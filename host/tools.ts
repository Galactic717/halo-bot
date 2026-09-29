// The tools a bot can call. Each area lives in host/tools/; this file puts them together in the
// order the model sees them and keeps the lookup the runner uses.
import type { ToolSchema } from './provider.ts';
import type { Tool } from './tools/core.ts';
import { MESSAGING_TOOLS } from './tools/messaging.ts';
import { WORKSPACE_TOOLS } from './tools/workspace.ts';
import { EXTERNAL_TOOLS } from './tools/external.ts';
import { WEB_TOOLS } from './tools/web.ts';
import { AGENT_TOOLS } from './tools/agents.ts';
import { PLANNING_TOOLS } from './tools/planning.ts';
import { SKILL_TOOLS } from './tools/skills.ts';
import { SUBAGENT_TOOLS } from './tools/subagents.ts';
import { AUTOMATION_TOOLS } from './tools/automation.ts';
import { SELFCHECK_TOOLS } from './tools/selfcheck.ts';

export { runShell, shellEnvironment } from './tools/core.ts';
export type { ComputerPort, RunnerPort, Tool, ToolContext, ToolResult } from './tools/core.ts';
export { describeTrigger, describeTriggers, parseTrigger } from './tools/planning.ts';

export const TOOLS: Tool[] = [
  ...MESSAGING_TOOLS,
  ...WORKSPACE_TOOLS,
  ...EXTERNAL_TOOLS,
  ...WEB_TOOLS,
  ...AGENT_TOOLS,
  ...PLANNING_TOOLS,
  ...SKILL_TOOLS,
  ...SUBAGENT_TOOLS,
  ...AUTOMATION_TOOLS,
  ...SELFCHECK_TOOLS,
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.schema.name, t]));

// ----------------------------------------------------------------- compact profile

/**
 * What a small model is handed on the wire: enough to do a job end to end in its box and on the web,
 * and a way to find the rest. Forty-odd schemas cost a 4B model ~4.6k tokens of every request and a
 * good part of its attention; routines, teammates, skills and the user's own machine are one FindTool
 * away instead. Grok Build hides its MCP schemas behind a search tool for the same reason.
 */
export const CORE_TOOL_NAMES = [
  'SendMessage',
  'AskUser',
  'Shell',
  'Read',
  'Write',
  'Edit',
  'ListFiles',
  'WebFetch',
  'WebSearch',
  'Browser',
  'UpdateMemory',
] as const;

export const FIND_TOOL: ToolSchema = {
  name: 'FindTool',
  description:
    'Look up tools that are not in your list: routines, teammates, skills, plugins, the user\'s own computer, subagents, images. Returns names, what they do and their arguments. Then call one with UseTool.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you need, in a few words. Empty lists everything.' } } },
};

export const USE_TOOL: ToolSchema = {
  name: 'UseTool',
  description: 'Call a tool you found with FindTool. It goes through the same approval as any other call.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' }, args: { type: 'object', description: 'The arguments FindTool listed for it.' } },
    required: ['name'],
  },
};

/** FindTool's answer: the best matches with their arguments, or every name when the query is empty. */
export function findTools(query: string, schemas: ToolSchema[]): string {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  if (words.length === 0) {
    return `Tools you can call with UseTool:\n${schemas.map((s) => `- ${s.name} — ${s.description.split(/(?<=\.)\s/)[0]?.slice(0, 120)}`).join('\n')}`;
  }
  const scored = schemas
    .map((s) => {
      const hay = `${s.name} ${s.description}`.toLowerCase();
      return { s, score: words.reduce((n, w) => n + (s.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  if (scored.length === 0) return `Nothing matched "${query}". FindTool with an empty query lists every tool.`;
  return scored
    .map(({ s }) => `${s.name} — ${s.description}\n  args: ${JSON.stringify(s.parameters.properties ?? {})}${(s.parameters.required as string[] | undefined)?.length ? `\n  required: ${(s.parameters.required as string[]).join(', ')}` : ''}`)
    .join('\n\n');
}
