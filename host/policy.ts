import { complete } from './provider.ts';
import { normalize as normalizePath, relative, isAbsolute } from 'node:path';
import type { Agent, ApprovalRequest, Settings } from './types.ts';

export type Decision = 'allow' | 'ask' | 'deny';

/** What the gate is being asked to approve. */
export interface ActionSummary {
  /** One line shown on the approval card; a remembered rule is written from this text. */
  summary: string;
  /** Command, path or payload the rules and the danger list are matched against. */
  detail: string;
  /** Filesystem target, when the action has one. This, not the command text, is what allowedPaths gates. */
  path?: string;
  /** A box command that names something outside the box — really an action on the user's machine. */
  outsideBox?: boolean;
}

/** Actions that touch the user's machine or the outside world always start at "ask". */
const BASE: Record<ApprovalRequest['surface'], Decision> = {
  external_shell: 'ask',
  external_read: 'ask',
  file_write: 'ask',
  browser: 'allow',
  shell: 'allow',
  agent_write: 'allow',
};

/** Commands that are destructive enough to ask even inside the bot's own box. */
const DANGEROUS = [
  /\bremove-item\b[^|]*-recurse/i,
  /\brm\s+-rf\b/i,
  /\bformat-volume\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]\b/i,
  /\bshutdown\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bNew-ItemProperty\b[^|]*HKLM/i,
  /\breg\s+(add|delete)\b/i,
  /\bnetsh\b/i,
  /\bdiskpart\b/i,
  /\bvssadmin\b/i,
  /\bcipher\s+\/w/i,
  /\bInvoke-WebRequest\b[^|]*\|\s*iex/i,
  /\bcurl\b[^|]*\|\s*(bash|sh|iex)/i,
];

/** Signs that a command run "inside the box" is actually reaching onto the user's machine. */
const OUTSIDE_BOX = [
  /\b[a-z]:[\\/]/i,
  /\\\\[^\\\s]/,
  /\$env:(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|TEMP|TMP|ProgramFiles|ProgramData|SystemRoot|windir|OneDrive)\b/i,
  /%(USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH|TEMP|TMP|ProgramFiles|ProgramData|SystemRoot|windir|OneDrive)%/i,
  /(^|[\s;|(])\.\.[\\/]/,
  /(^|[\s;|(])(cd|Set-Location|Push-Location|pushd)\s+["']?[\\/~]/i,
];

/** Removes the bot's own box path so its own absolute paths do not read as an escape. */
function stripBox(text: string, boxDir: string): string {
  if (!boxDir) return text;
  const pattern = boxDir
    .split(/[\\/]/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
  try {
    return text.replace(new RegExp(pattern, 'gi'), ' ');
  } catch {
    return text;
  }
}

/**
 * True when a box command names something outside the box.
 * ponytail: text heuristic, not a sandbox. It makes an escape visible; it cannot prevent one, because
 * `Shell` is real PowerShell with the user's rights. Swap for a container or Windows Sandbox if the
 * box is ever meant to be a real boundary.
 */
export function reachesOutsideBox(command: string, boxDir: string): boolean {
  const rest = stripBox(command, boxDir);
  return OUTSIDE_BOX.some((re) => re.test(rest));
}

function normalize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
}

/**
 * Natural-language rules, matched by word overlap.
 * ponytail: bag-of-words match; swap for a classifier call if rules start misfiring.
 */
export function matchRule(settings: Settings, summary: string, detail: string): Decision | null {
  const haystack = new Set(normalize(`${summary} ${detail}`));
  let best: { score: number; decision: Decision } | null = null;
  for (const rule of settings.rules) {
    const words = normalize(rule.when);
    if (words.length === 0) continue;
    const hits = words.filter((w) => haystack.has(w)).length;
    const score = hits / words.length;
    if (score >= 0.6 && (!best || score > best.score)) best = { score, decision: rule.decision };
  }
  // "ask first" wins ties by construction: a rule that says ask is never downgraded below.
  // A rule with no matchable words matches nothing, so it must not silently gate every action.
  const asksFirst = settings.rules.some((rule) => {
    if (rule.decision !== 'ask') return false;
    const words = normalize(rule.when);
    return words.length > 0 && words.every((w) => haystack.has(w));
  });
  if (asksFirst) return 'ask';
  return best?.decision ?? null;
}

/** True when the path sits inside one of the folders the user granted this bot. */
export function isInsideAllowed(path: string, allowed: string[] | undefined): boolean {
  if (!allowed || allowed.length === 0 || !path) return false;
  const target = normalizePath(path);
  // A bare word is not a path; resolving it against the process cwd would grant far too much.
  if (!isAbsolute(target)) return false;
  return allowed.some((root) => {
    const rel = relative(normalizePath(root), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

export function decide(
  settings: Settings,
  surface: ApprovalRequest['surface'],
  action: ActionSummary,
  agent?: Pick<Agent, 'localExecution' | 'allowedPaths'>,
): Decision {
  const rule = matchRule(settings, action.summary, action.detail);
  if (rule === 'deny') return 'deny';

  const danger = DANGEROUS.some((re) => re.test(action.detail));
  // A bot given a folder works inside it without stopping to ask each time.
  const granted = isInsideAllowed(action.path ?? '', agent?.allowedPaths);

  if (surface === 'external_shell' || surface === 'external_read') {
    const mode = agent?.localExecution && agent.localExecution !== 'inherit' ? agent.localExecution : settings.localExecution;
    if (mode === 'never') return 'deny';
    // A destructive command never rides in on a blanket "allow" — that is what the list is for.
    if (settings.autoReview && danger) return 'ask';
    if (granted) return 'allow';
    if (mode === 'allow') return rule ?? 'allow';
  }

  if (granted) return 'allow';
  if (!settings.autoReview) return 'allow';
  if (danger || action.outsideBox) return 'ask';
  return rule ?? BASE[surface];
}

export function summarize(toolName: string, args: Record<string, unknown>, boxDir = ''): ActionSummary {
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (toolName) {
    case 'ExternalShell':
      return { summary: 'Run a command on your computer', detail: pick('command'), path: pick('cwd') };
    case 'Shell': {
      const command = pick('command');
      const outsideBox = boxDir ? reachesOutsideBox(command, boxDir) : false;
      return {
        summary: outsideBox ? 'Run a command that reaches outside its box' : "Run a command on the bot's computer",
        detail: command,
        outsideBox,
      };
    }
    case 'ExternalRead':
      return { summary: 'Read a file from your computer', detail: pick('path'), path: pick('path') };
    case 'CopyToBox':
      return { summary: 'Copy a file from your computer into the box', detail: pick('source'), path: pick('source') };
    case 'CopyFromBox':
      return { summary: 'Write a file onto your computer', detail: pick('destination'), path: pick('destination') };
    case 'Browser':
      return { summary: `Browser: ${pick('action')}`, detail: pick('url') || pick('selector') || pick('text') };
    case 'CreateAgent':
      return { summary: 'Create a new bot', detail: `${pick('name')} — ${pick('description')}` };
    case 'UpdateAgent':
      return { summary: 'Change a bot profile', detail: JSON.stringify(args) };
    case 'CreateRoutine':
      return { summary: `Create routine "${pick('name')}"`, detail: pick('prompt') };
    case 'DeleteRoutine':
      return { summary: 'Delete a routine', detail: pick('routine_id') };
    default:
      return { summary: toolName, detail: JSON.stringify(args).slice(0, 500) };
  }
}

const REVIEW_SYSTEM = [
  'You are the safety review inside a desktop agent app. A bot wants to run an action.',
  'Decide whether it is safe to run without asking the user.',
  '',
  'Answer with exactly one word on the first line: ALLOW, ASK or DENY.',
  'On the second line give a short reason (under 20 words).',
  '',
  'ALLOW: routine, reversible, clearly within what the user asked for.',
  "ASK: touches the user's own files, accounts, money, or anything hard to undo.",
  'DENY: destructive with no plausible benign reading (wiping disks, disabling security, exfiltrating secrets).',
  'Respect the user rules you are given: they override your defaults unless the action is destructive.',
].join('\n');

export interface ModelReview {
  decision: Decision;
  reason: string;
}

const REVIEW_CACHE_LIMIT = 200;
const reviewCache = new Map<string, ModelReview>();

/** Second opinion from the model for actions the static rules let through. */
export async function reviewWithModel(
  settings: Settings,
  surface: ApprovalRequest['surface'],
  action: ActionSummary,
  signal?: AbortSignal,
): Promise<ModelReview> {
  const key = `${surface}|${action.summary}|${action.detail}`.slice(0, 400);
  const cached = reviewCache.get(key);
  if (cached) return cached;

  const rules = settings.rules.map((r) => `- when the bot wants to ${r.when}: ${r.decision}`).join('\n') || '(none)';
  const provider = settings.provider.helperModel
    ? { ...settings.provider, model: settings.provider.helperModel }
    : settings.provider;

  let raw = '';
  try {
    raw = await complete(
      provider,
      [
        { role: 'system', content: REVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            `Surface: ${surface}`,
            `Action: ${action.summary}`,
            `Detail: ${action.detail.slice(0, 800)}`,
            ...(action.path ? [`Path: ${action.path}`] : []),
            '',
            'User rules:',
            rules,
          ].join('\n'),
        },
      ],
      signal,
    );
  } catch {
    // A review that cannot run must not silently widen permissions.
    return { decision: 'ask', reason: 'the safety review could not run' };
  }

  const first = raw.trim().split('\n')[0]?.toUpperCase() ?? '';
  const reason = raw.trim().split('\n').slice(1).join(' ').trim().slice(0, 160);
  const decision: Decision = first.startsWith('DENY') ? 'deny' : first.startsWith('ASK') ? 'ask' : 'allow';
  const review = { decision, reason: reason || 'reviewed by the model' };
  if (reviewCache.size >= REVIEW_CACHE_LIMIT) {
    const oldest = reviewCache.keys().next().value;
    if (oldest !== undefined) reviewCache.delete(oldest);
  }
  reviewCache.set(key, review);
  return review;
}
