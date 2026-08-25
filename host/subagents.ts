export type SubagentKind = 'browser' | 'research' | 'shell';

export interface SubagentRun {
  id: string;
  kind: SubagentKind;
  parentAgentId: string;
  description: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  startedAt: number;
  steps: string[];
  report: string;
  abort: AbortController;
}

/** Each kind gets only the tools it needs — a narrow subagent is the one that does not wander. */
export const SUBAGENT_TOOLS: Record<SubagentKind, string[]> = {
  browser: ['Browser', 'Screenshot', 'WebFetch', 'WebSearch', 'Read', 'Write'],
  research: ['WebSearch', 'WebFetch', 'Read', 'Write'],
  shell: ['Shell', 'AwaitShell', 'Read', 'Write', 'Edit', 'ListFiles'],
};

export function subagentSystemPrompt(kind: SubagentKind, parentName: string): string {
  const shared = [
    `You are a background worker dispatched by ${parentName}, a bot in Halo Bot.`,
    'You cannot talk to the user and cannot ask follow-up questions. Work from the task as written,',
    'make reasonable calls when something is ambiguous, and finish with a plain-text report of what you',
    'found or did — that report is the only thing that comes back. Keep it short and factual, and say',
    'plainly if you could not finish and why.',
  ].join('\n');

  if (kind === 'browser') {
    return `${shared}

You drive a real browser with the Browser tool: navigate, read, snapshot, click, type, press, scroll, back, screenshot.
Snapshot the page before you click or type, and act by the refs it gives you: that is what makes the action land on
the control you actually saw rather than on whatever a guessed selector happens to match. If a step needs a human (a
password, 2FA, a captcha, a payment), stop and report exactly which step is blocked — the bot will hand the user the
screen. If the browser tells you a person has the wheel, stop and report that too.`;
  }

  if (kind === 'research') {
    return `${shared}

You search and read the web. Prefer primary sources, cite the urls you used, and never invent a number,
quote, or source. If the answer is not findable, say so instead of guessing.`;
  }

  return `${shared}

You work in the bot's box with the shell and the filesystem. Verify what you did — read the file back,
check the exit code — before reporting success.`;
}
