// The decide-record-act ordering is adapted from OpenBot (MIT, (c) 2026 CopilotKit). See NOTICE.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditRow, AuditVerdict } from './types.ts';

/**
 * What each bot was allowed to do, what it was refused, and what then failed.
 *
 * The record is not a report written alongside the work, it is the thing the work goes through: the
 * gate writes the row before the action runs, so there is no path that acts without appearing here.
 * That ordering is the whole point, and it is borrowed wholesale from OpenBot's gateway — a trail
 * that only contains successes cannot show the sequence somebody needs when something has gone wrong.
 *
 * A permitted action that then failed gets a second row rather than an edit, because "allowed" and
 * "happened" are different facts and a reader will otherwise take the first for the second.
 *
 * Each row carries the hash of the one before it, so a row edited, deleted or inserted afterwards
 * breaks the chain and `verify()` says where. That makes the trail tamper-*evident*, not
 * tamper-proof: a process with the user's rights can rewrite the whole file and recompute every
 * hash. A bot's own shell cannot — its AppContainer has no access to Halo's data directory — which
 * is the case the trail exists for.
 *
 * ponytail: append-only JSONL with a size roll. One machine, one person. If this ever needs
 * filtering by more than the loaded window, it wants SQLite, not a bigger read.
 */

/** The chain's anchor before any row exists. */
const GENESIS = '0'.repeat(64);

/** The hash of a row: over its predecessor's hash and every other field, in a fixed key order. */
export function hashRow(row: AuditRow, prev: string): string {
  const { hash: _hash, prev: _prev, ...fields } = row;
  const canonical = JSON.stringify(fields, Object.keys(fields).sort());
  return createHash('sha256').update(prev).update('\n').update(canonical).digest('hex');
}

/** Rolled at this size so the file can always be read into memory to be searched. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Field names whose values never go in the trail, whatever they are nested inside. */
const SECRET_KEYS = /^(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|auth|credential|cookie|session)$/i;

/** The trail says a secret was there and how long it was. It never says what it said. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.test(key) ? `[${String(inner ?? '').length} characters withheld]` : redact(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Masks anything in free text that looks like a key.
 *
 * A command is recorded verbatim because a rule about a shell can only be written against what was
 * actually typed — but `curl -H "Authorization: Bearer sk-…"` is a command *and* a secret, and the
 * trail is a file on disk that outlives the reason it was written.
 */
export function scrub(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|ghs|xoxb|xoxp|AIza)[-_A-Za-z0-9]{12,}/g, '[key withheld]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, '$1 [withheld]')
    .replace(/(-{1,2}(?:password|token|api[_-]?key|secret)[=\s]+)("[^"]*"|'[^']*'|\S+)/gi, '$1[withheld]')
    .replace(/(\$env:[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[withheld]');
}

export class AuditLog {
  private path: string;
  /** The last row's hash; read from disk once, so a restart continues the chain rather than forking it. */
  private last: string | null = null;

  constructor(root: string) {
    this.path = join(root, 'audit.jsonl');
  }

  private lastHash(): string {
    if (this.last !== null) return this.last;
    for (const path of [this.path, `${this.path}.1`]) {
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const row = JSON.parse(lines[i]!) as AuditRow;
          if (row.hash) return (this.last = row.hash);
        } catch {
          /* a torn last line; look one further back */
        }
      }
    }
    return (this.last = GENESIS);
  }

  /** Writes one row. Never throws: a trail that cannot be written must not stop the decision. */
  write(row: AuditRow): AuditRow {
    const clean: AuditRow = {
      ...row,
      summary: scrub(row.summary).slice(0, 400),
      detail: scrub(row.detail).slice(0, 2000),
      ...(row.failure ? { failure: scrub(row.failure).slice(0, 400) } : {}),
    };
    clean.prev = this.lastHash();
    clean.hash = hashRow(clean, clean.prev);
    try {
      this.roll();
      appendFileSync(this.path, `${JSON.stringify(clean)}\n`, 'utf8');
      this.last = clean.hash;
    } catch {
      /* a full or locked disk is not a reason to stop deciding */
    }
    return clean;
  }

  /**
   * Walks the chain from the oldest kept row to the newest and says whether it holds.
   *
   * The oldest kept row's `prev` points into a generation that has been rolled away, so it is taken
   * as given; every link after it is checked. Rows written before the chain existed have no hash and
   * are skipped until the first one that does.
   */
  verify(): AuditVerdict {
    let prev: string | null = null;
    let rows = 0;
    for (const path of [`${this.path}.1`, this.path]) {
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        rows += 1;
        let row: AuditRow;
        try {
          row = JSON.parse(line) as AuditRow;
        } catch {
          return { intact: false, rows, brokenAt: rows, reason: 'a row is not valid JSON' };
        }
        if (!row.hash) {
          if (prev === null) continue;
          return { intact: false, rows, brokenAt: rows, reason: 'a row has no hash after the chain began' };
        }
        if (prev !== null && row.prev !== prev) {
          return { intact: false, rows, brokenAt: rows, reason: 'a row does not follow the one before it (one was removed or inserted)' };
        }
        if (hashRow(row, row.prev ?? '') !== row.hash) {
          return { intact: false, rows, brokenAt: rows, reason: 'a row was changed after it was written' };
        }
        prev = row.hash;
      }
    }
    return { intact: true, rows };
  }

  /** Keeps one generation, so a roll never silently discards the week somebody is looking for. */
  private roll() {
    try {
      if (!existsSync(this.path) || statSync(this.path).size < MAX_BYTES) return;
      renameSync(this.path, `${this.path}.1`);
    } catch {
      /* nothing to roll */
    }
  }

  /**
   * The most recent rows, newest first, optionally narrowed.
   *
   * Reads the file each time rather than holding it: the trail is looked at when something went
   * wrong, which is rare, and keeping megabytes of it resident for that is the wrong trade.
   */
  read(options: { limit?: number; agentId?: string; outcome?: AuditRow['outcome']; query?: string } = {}): AuditRow[] {
    const limit = options.limit ?? 200;
    const needle = options.query?.trim().toLowerCase() ?? '';
    const rows: AuditRow[] = [];
    for (const path of [this.path, `${this.path}.1`]) {
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let row: AuditRow;
        try {
          row = JSON.parse(line) as AuditRow;
        } catch {
          continue;
        }
        if (options.agentId && row.agentId !== options.agentId) continue;
        if (options.outcome && row.outcome !== options.outcome) continue;
        if (needle && !`${row.summary} ${row.detail} ${row.tool} ${row.agentName}`.toLowerCase().includes(needle)) continue;
        rows.push(row);
      }
      if (rows.length >= limit) break;
    }
    return rows;
  }

  /** Counts for the last `days`, for the summary strip above the trail. */
  summary(days = 7): { allowed: number; refused: number; failed: number } {
    const since = Date.now() - days * 86_400_000;
    const totals = { allowed: 0, refused: 0, failed: 0 };
    for (const row of this.read({ limit: 5000 })) {
      if (row.at < since) break;
      totals[row.outcome] += 1;
    }
    return totals;
  }
}
