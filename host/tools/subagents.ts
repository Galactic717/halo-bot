// Background work: subagents and long shell commands.
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, num, clip, type Tool } from './core.ts';

export const SUBAGENT_TOOLS: Tool[] = [
  {
    schema: {
      name: 'Task',
      description:
        'Hand a self-contained chunk of work to a background worker and keep going. It runs on its own and reports back to you when it finishes, so never sit and wait for it. Scope it tight: the exact step, the specifics it needs, what "done" looks like, and what to report.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['browser', 'research', 'shell'],
            description: 'browser drives your browser, research searches and reads the web, shell works in your box.',
          },
          description: { type: 'string', description: 'Three to five words naming the job.' },
          prompt: { type: 'string', description: 'The full task, standalone — the worker sees none of this conversation.' },
        },
        required: ['kind', 'description', 'prompt'],
      },
    },
    async run(ctx, args) {
      const kind = str(args.kind, 'research') as 'browser' | 'research' | 'shell';
      const id = ctx.runner.dispatchSubagent(ctx.agentId, kind, str(args.description), str(args.prompt));
      return {
        output: `Dispatched ${id} (${kind}). Keep working; you will be woken with its report. Use CheckSubagent ${id} if it seems stuck.`,
      };
    },
  },

  {
    schema: {
      name: 'CheckSubagent',
      description: 'Look in on a background worker: status, recent actions, and its report so far. Use it to spot a stall, not to poll for completion.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    async run(ctx, args) {
      return { output: ctx.runner.checkSubagent(str(args.task_id)) };
    },
  },

  {
    schema: {
      name: 'MessageSubagent',
      description:
        'Correct or narrow a background worker that is already running. It reads this before its next step and keeps everything it has done so far — which is why this beats stopping it and dispatching a new one.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, text: { type: 'string', description: 'The correction, in one or two sentences.' } },
        required: ['task_id', 'text'],
      },
    },
    async run(ctx, args) {
      return { output: ctx.runner.messageSubagent(str(args.task_id), str(args.text)) };
    },
  },

  {
    schema: {
      name: 'StopSubagent',
      description: 'Abort a background worker that is wedged or no longer needed. Prefer MessageSubagent when it only needs redirecting.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
    },
    async run(ctx, args) {
      return { output: ctx.runner.stopSubagent(str(args.task_id)) };
    },
  },

  {
    schema: {
      name: 'AwaitShell',
      description: 'Wait for a background command you started earlier and read its output.',
      parameters: {
        type: 'object',
        properties: { shell_id: { type: 'string' }, timeout_ms: { type: 'number' } },
        required: ['shell_id'],
      },
    },
    async run(ctx, args) {
      return { output: clip(await ctx.awaitBackground(str(args.shell_id), num(args.timeout_ms, 120_000))) };
    },
  },
];
