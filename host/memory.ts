import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { complete, type ChatMessage } from './provider.ts';
import type { Store } from './store.ts';
import type { Settings } from './types.ts';

export type MemoryTier = 'profile' | 'log' | 'note';

export interface MemoryFact {
  tier: MemoryTier;
  text: string;
  createdAt: number;
}

const MAX_FACT_CHARS = 500;
const PROMPT_RECENT_LIMIT = 30;
const PROMPT_CHAR_BUDGET = 4000;
const PROFILE_LIMIT = 100;
const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

const IMPORTANCE: Record<MemoryTier, number> = { profile: 1.5, log: 1, note: 0.5 };

/** Small talk is not worth a model call, let alone a memory. */
const TRIVIAL = new Set([
  'hi', 'hey', 'hello', 'yo', 'sup', 'thanks', 'thank you', 'ty', 'thx', 'ok', 'okay', 'k', 'kk',
  'cool', 'nice', 'great', 'awesome', 'perfect', 'yes', 'yep', 'yeah', 'no', 'nope', 'sure',
  'got it', 'gotcha', 'lol', 'haha', 'np', 'done', 'good', 'bye', 'ага', 'ок', 'добре', 'дякую',
]);

export function isMemorable(userMessage: string): boolean {
  const text = userMessage.trim();
  if (text.length === 0) return false;
  if (text.length > 40 || text.includes('?')) return true;
  const normalized = text.toLowerCase().replace(/[\s!.…,~)\]]+$/g, '').replace(/\s+/g, ' ');
  return !TRIVIAL.has(normalized);
}

export class MemoryStore {
  private dir: string;
  private store: Store;
  private agentId: string;

  constructor(store: Store, agentId: string) {
    this.store = store;
    this.agentId = agentId;
    this.dir = join(store.agentDir(agentId), 'memory');
    mkdirSync(join(this.dir, 'log'), { recursive: true });
    this.migrateLegacyFile();
  }

  private profilePath() { return join(this.dir, 'profile.md'); }
  private logPath() { return join(this.dir, 'log', 'facts.jsonl'); }

  /**
   * Older builds kept a single `memory.md` next to the agent, which nothing ever read back into
   * the prompt. Anything a user typed there is folded in once, then the file goes away.
   */
  private migrateLegacyFile() {
    const legacy = join(this.store.agentDir(this.agentId), 'memory.md');
    if (!existsSync(legacy)) return;
    try {
      for (const raw of readFileSync(legacy, 'utf8').split('\n')) {
        const line = raw.replace(/^\s*[-*]\s+/, '').trim();
        if (!line || line.startsWith('#')) continue;
        this.add('log', line.replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, ''));
      }
      rmSync(legacy, { force: true });
    } catch { /* leave the file alone rather than lose it */ }
  }

  list(): MemoryFact[] {
    const out: MemoryFact[] = [];
    if (existsSync(this.profilePath())) {
      for (const line of readFileSync(this.profilePath(), 'utf8').split('\n')) {
        const m = /^- \((\d{4}-\d{2}-\d{2})\) (.+)$/.exec(line.trim());
        if (m) out.push({ tier: 'profile', text: m[2]!, createdAt: Date.parse(m[1]!) });
      }
    }
    if (existsSync(this.logPath())) {
      for (const line of readFileSync(this.logPath(), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const fact = JSON.parse(line) as MemoryFact;
          if (fact.text) out.push(fact);
        } catch { /* skip torn line */ }
      }
    }
    return out;
  }

  add(tier: MemoryTier, text: string, now = Date.now()) {
    const clean = text.trim().slice(0, MAX_FACT_CHARS);
    if (!clean) return;
    // Memory extraction runs after the turn, and the bot can be deleted in between. Writing then would
    // either throw (the folder is gone) or bring a deleted bot's memory back from the dead.
    if (!existsSync(join(this.dir, 'log'))) return;
    const existing = this.list();
    if (existing.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return;
    if (tier === 'profile') {
      const kept = existing.filter((f) => f.tier === 'profile').slice(-(PROFILE_LIMIT - 1));
      const lines = [...kept, { tier, text: clean, createdAt: now }].map(
        (f) => `- (${new Date(f.createdAt).toISOString().slice(0, 10)}) ${f.text}`,
      );
      writeFileSync(this.profilePath(), `# Profile\n\n${lines.join('\n')}\n`, 'utf8');
      return;
    }
    appendFileSync(this.logPath(), `${JSON.stringify({ tier, text: clean, createdAt: now })}\n`, 'utf8');
  }

  forget(text: string) {
    const target = text.trim().toLowerCase();
    const kept = this.list().filter((f) => f.text.toLowerCase() !== target);
    const profile = kept.filter((f) => f.tier === 'profile');
    writeFileSync(
      this.profilePath(),
      `# Profile\n\n${profile.map((f) => `- (${new Date(f.createdAt).toISOString().slice(0, 10)}) ${f.text}`).join('\n')}\n`,
      'utf8',
    );
    writeFileSync(
      this.logPath(),
      kept.filter((f) => f.tier !== 'profile').map((f) => JSON.stringify(f)).join('\n') + '\n',
      'utf8',
    );
  }

  /**
   * Importance decayed by a 30-day half-life: log2(importance * 2^(-age/halfLife)).
   * Written as a subtraction so the age term cannot dwarf importance the way a raw timestamp does.
   */
  private rank(fact: MemoryFact, now = Date.now()): number {
    const ageDays = Math.max(0, now - fact.createdAt) / DAY_MS;
    return Math.log2(IMPORTANCE[fact.tier]) - ageDays / HALF_LIFE_DAYS;
  }

  /** The whole memory as editable text — one `tier: fact` per line. What Settings shows and export carries. */
  exportText(): string {
    const lines = this.list().map((f) => `${f.tier}: ${f.text}`);
    return lines.length ? `${lines.join('\n')}\n` : '';
  }

  /** Replaces the whole memory from the text form. Unknown lines are kept as log facts. */
  importText(text: string) {
    writeFileSync(this.profilePath(), '# Profile\n\n', 'utf8');
    writeFileSync(this.logPath(), '', 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(profile|log|note)\s*:\s*(.+)$/i.exec(line);
      if (m) this.add(m[1]!.toLowerCase() as MemoryTier, m[2]!.trim());
      else this.add('log', line.replace(/^\(\d{4}-\d{2}-\d{2}\)\s*/, ''));
    }
  }

  render(): string {
    const all = this.list();
    if (all.length === 0) return '';
    const now = Date.now();
    const profile = all.filter((f) => f.tier === 'profile');
    const rest = all.filter((f) => f.tier !== 'profile').sort((a, b) => this.rank(b, now) - this.rank(a, now));

    const lines = [
      'Memory: durable facts you have learned about the user and their world.',
      `They live in ${this.dir} — profile.md and log/. Read or grep them when you need something older than this list.`,
    ];
    if (profile.length > 0) {
      lines.push('', 'About the user:');
      for (const f of profile) lines.push(factLine(f));
    }
    if (rest.length > 0) {
      lines.push('', 'Recently:');
      let budget = PROMPT_CHAR_BUDGET;
      let shown = 0;
      for (const f of rest.slice(0, PROMPT_RECENT_LIMIT)) {
        const line = factLine(f);
        if (shown > 0 && line.length > budget) break;
        lines.push(line);
        budget -= line.length;
        shown += 1;
      }
      const omitted = rest.length - shown;
      if (omitted > 0) lines.push(`(${omitted} more on disk — grep log/ for them.)`);
    }
    return lines.join('\n');
  }
}

function factLine(fact: MemoryFact): string {
  return `- (learned ${new Date(fact.createdAt).toISOString().slice(0, 10)}) ${fact.text}`;
}

const EXTRACTION_SYSTEM = [
  'You maintain the long-term memory of a personal assistant. Read the latest exchange and decide what, if anything,',
  'is worth remembering for future, unrelated conversations.',
  '',
  'Tag each fact you keep with a category:',
  '- "profile": enduring facts about who the user is and how to work with them — name, role, location, languages,',
  '  lasting preferences and constraints, important people. Kept indefinitely.',
  '- "log": substantive history — ongoing projects, decisions, commitments, time-bound details.',
  '- "note": minor details that might help someday but are not worth keeping in mind every turn.',
  '',
  'Do NOT record one-off request mechanics, what the assistant did this turn, general knowledge, or anything already',
  'in the existing memory list.',
  '',
  'If the exchange contradicts an existing fact, output "remove: <the exact existing fact text>" and then add the',
  'corrected fact. Only remove facts that appear verbatim in the existing list.',
  '',
  'Write one fact per line: "profile: <fact>", "log: <fact>", "note: <fact>", or "remove: <existing fact>".',
  'Output exactly NONE (and nothing else) when there is nothing to add or remove.',
].join('\n');

const LINE = /^(profile|log|note|remove)\s*:\s*(.+)$/i;

/** Runs after a turn, on a cheap non-streaming call. Failures are silent by design. */
export async function extractMemories(
  provider: Settings['provider'],
  memory: MemoryStore,
  userMessage: string,
  agentMessage: string,
): Promise<number> {
  if (!isMemorable(userMessage)) return 0;
  const existing = memory.list().map((f) => f.text);
  const messages: ChatMessage[] = [
    { role: 'system', content: EXTRACTION_SYSTEM },
    {
      role: 'user',
      content: [
        'Existing memory:',
        existing.length ? existing.map((t) => `- ${t}`).join('\n') : '(empty)',
        '',
        'Latest exchange:',
        `User: ${userMessage.trim() || '(no message)'}`,
        `Assistant: ${agentMessage.trim() || '(no message)'}`,
      ].join('\n'),
    },
  ];

  let raw: string;
  try {
    raw = await complete(provider, messages);
  } catch {
    return 0;
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase().startsWith('NONE')) return 0;

  let changes = 0;
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    const m = LINE.exec(line);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const text = m[2]!.trim();
    if (!text) continue;
    if (kind === 'remove') memory.forget(text);
    else memory.add(kind as MemoryTier, text);
    changes += 1;
  }
  return changes;
}
