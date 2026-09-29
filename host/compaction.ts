import { complete, type ChatMessage } from './provider.ts';
import type { Settings } from './types.ts';

/** Rough but stable: 4 characters per token is close enough for budgeting. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    for (const call of message.tool_calls ?? []) chars += call.function.arguments.length + call.function.name.length;
  }
  return Math.ceil(chars / 4);
}

const SUMMARY_MARKER = '[conversation so far]';

export function isSummary(message: ChatMessage): boolean {
  return message.role === 'system' && message.content.startsWith(SUMMARY_MARKER);
}

const SUMMARY_SYSTEM = [
  'You compact an assistant conversation so it can keep going in a smaller context.',
  'Write a dense summary of what happened, in this order:',
  '1. What the user asked for and any standing preferences or constraints they stated.',
  '2. What was actually done, with concrete results: file paths, urls, names, numbers, commands that worked.',
  '3. What is still open or was promised.',
  'Keep every fact that a future turn would need. Drop pleasantries, retries and dead ends.',
  'No preamble, no headings, under 400 words.',
].join('\n');

export interface CompactionResult {
  messages: ChatMessage[];
  compacted: boolean;
}

/**
 * Keeps the tail verbatim and folds everything older into one summary message.
 * Tool results are never left orphaned: the tail always starts on a user or assistant message.
 */
export async function compactHistory(
  provider: Settings['provider'],
  messages: ChatMessage[],
  options: { tokenBudget: number; keepLast: number; signal?: AbortSignal; forced?: boolean },
): Promise<CompactionResult> {
  if (messages.length <= options.keepLast + 2) return { messages, compacted: false };
  // `forced` means the model has already refused this conversation for being too long, so the local
  // token estimate has been proved wrong about it and must not be allowed to veto the fix.
  if (!options.forced && estimateTokens(messages) <= options.tokenBudget) return { messages, compacted: false };

  let cut = messages.length - options.keepLast;
  while (cut < messages.length && (messages[cut]!.role === 'tool' || messages[cut]!.role === 'assistant')) cut++;
  if (cut <= 1) return { messages, compacted: false };

  const older = messages.slice(0, cut);
  const tail = messages.slice(cut);
  const previousSummary = older.find(isSummary)?.content ?? '';

  const transcript = older
    .filter((m) => !isSummary(m))
    .map((m) => {
      if (m.role === 'tool') return `tool(${m.name ?? 'result'}): ${m.content.slice(0, 400)}`;
      const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`).join(' ');
      return `${m.role}: ${m.content.slice(0, 1200)}${calls ? ` [called ${calls}]` : ''}`;
    })
    .join('\n')
    .slice(-24_000);

  let summary: string;
  try {
    summary = await complete(
      provider,
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: [previousSummary ? `Earlier summary:\n${previousSummary}\n` : '', 'Conversation to compact:', transcript].join('\n'),
        },
      ],
      options.signal,
    );
  } catch {
    // Without a summary, dropping history would lose facts silently — keep it as is.
    return { messages, compacted: false };
  }

  if (!summary.trim()) return { messages, compacted: false };

  return {
    messages: [{ role: 'system', content: `${SUMMARY_MARKER}\n${summary.trim()}` }, ...tail],
    compacted: true,
  };
}
