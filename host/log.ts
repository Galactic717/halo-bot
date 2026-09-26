import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scrub } from './audit.ts';

/**
 * What Halo itself did and what went wrong, one JSON object per line.
 *
 * The audit trail answers "what did a bot do"; this answers "why did Halo misbehave" — a turn that
 * failed, a model server that stopped answering, a plugin that would not start, a crash. Before it
 * existed those were caught and dropped in some fifty places, and a user's bug report could only say
 * "it stopped working".
 *
 * Strings are scrubbed with the trail's own key masking before they are written, because a log is
 * the file people attach to issues.
 *
 * ponytail: synchronous appends and a size roll, three generations. One process, one person; if it
 * ever needs shipping somewhere, OpenTelemetry, not a bigger file.
 */

export type LogLevel = 'info' | 'warn' | 'error';

const MAX_BYTES = 2 * 1024 * 1024;
const GENERATIONS = 3;

let dir: string | null = null;

/** Starts writing to `<root>/logs/halo.log`. Until then, warnings and errors go to stderr only. */
export function initLog(root: string): void {
  dir = join(root, 'logs');
  mkdirSync(dir, { recursive: true });
}

export function logDir(): string | null {
  return dir;
}

function file(generation = 0): string {
  return join(dir!, generation === 0 ? 'halo.log' : `halo.log.${generation}`);
}

function roll(): void {
  if (!existsSync(file()) || statSync(file()).size < MAX_BYTES) return;
  for (let g = GENERATIONS - 1; g >= 1; g--) {
    if (existsSync(file(g - 1))) renameSync(file(g - 1), file(g));
  }
}

function clean(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: scrub(value.message), stack: scrub(value.stack?.split('\n').slice(0, 6).join('\n') ?? '') };
  }
  if (typeof value === 'string') return scrub(value).slice(0, 2000);
  return value;
}

/** Writes one line. Never throws: a log that cannot be written must not take the app down with it. */
export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const entry: Record<string, unknown> = { at: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) entry[key] = clean(value);
  const line = JSON.stringify(entry);
  if (!dir) {
    if (level !== 'info') console.error(line);
    return;
  }
  try {
    roll();
    appendFileSync(file(), `${line}\n`, 'utf8');
  } catch {
    /* a full disk is not a reason to crash */
  }
}

/** The newest lines, oldest first, for the diagnostics a user can copy into an issue. */
export function recentLog(lines = 100): string[] {
  if (!dir || !existsSync(file())) return [];
  return readFileSync(file(), 'utf8').trimEnd().split('\n').slice(-lines);
}
