// Memory, routines, the todo list and questions for the user.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Routine, RoutineTrigger } from '../types.ts';
import type { MemoryTier } from '../memory.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { clampTrigger, enabledSlot, MIN_INTERVAL_MINUTES } from '../scheduler.ts';
import { str, type Tool } from './core.ts';

export const PLANNING_TOOLS: Tool[] = [
  {
    schema: {
      name: 'UpdateMemory',
      description:
        'Write something durable about how the user works, their preferences, or facts you should not have to ask twice. This memory is loaded into every future turn.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'A self-contained statement, e.g. "The user ships on Fridays".' },
          tier: {
            type: 'string',
            enum: ['profile', 'log', 'note'],
            description:
              'profile = who the user is, kept in mind every turn. log = substantive history (default). note = minor detail that fades fast.',
          },
          forget: { type: 'string', description: 'Exact text of a recorded fact to drop. Pair with a fact to correct it.' },
        },
      },
    },
    async run(ctx, args) {
      const forget = str(args.forget);
      const fact = str(args.fact);
      if (forget) ctx.memory.forget(forget);
      if (fact) ctx.memory.add((str(args.tier, 'log') as MemoryTier) || 'log', fact);
      if (!forget && !fact) return { output: 'Give a fact to remember or a fact to forget.', isError: true };
      ctx.systemEvent({ kind: 'memory', label: 'Updated memory', chip: (fact || forget).slice(0, 60) });
      return { output: 'Memory updated.' };
    },
  },

  {
    schema: {
      name: 'CreateRoutine',
      description: 'Save a recurring task for yourself. It fires on a schedule and you run the prompt as if the user had sent it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          prompt: { type: 'string' },
          every_minutes: { type: 'number', description: `Minutes between runs. ${MIN_INTERVAL_MINUTES} is the shortest Halo allows; anything less is raised to it.` },
          daily_at: { type: 'string', description: 'HH:MM, 24h' },
          weekdays_at: { type: 'string', description: 'HH:MM, Monday to Friday only' },
          weekly_on: { type: 'string', description: 'e.g. "mon 09:00"' },
          webhook: {
            type: 'boolean',
            description:
              'Instead of a schedule, fire when something calls in. Halo returns a loopback URL to give the user; anything that can POST to it starts this routine.',
          },
        },
        required: ['name', 'prompt'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const trigger = parseTrigger(args);
      if (!trigger) return { output: 'Give one of every_minutes, daily_at, weekdays_at, weekly_on, or webhook: true.', isError: true };
      const slot = enabledSlot(ctx.store.listRoutines());
      if (!slot.ok) return { output: `${slot.reason} Tell the user, and offer to switch one off.`, isError: true };
      const routine: Routine = {
        id: randomUUID(),
        agentId: ctx.agentId,
        name: str(args.name),
        prompt: str(args.prompt),
        triggers: [trigger],
        enabled: true,
        createdAt: Date.now(),
      };
      ctx.store.saveRoutine(routine);
      ctx.emit({ type: 'routines', routines: ctx.store.listRoutines() });
      ctx.systemEvent({ kind: 'routine', label: 'Created routine', chip: routine.name });
      return { output: `Routine "${routine.name}" saved (${describeTrigger(trigger)}).` };
    },
  },

  {
    schema: {
      name: 'ListRoutines',
      description: 'List your routines.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      const rs = ctx.store.listRoutines().filter((r) => r.agentId === ctx.agentId);
      return {
        output: rs.map((r) => `- ${r.name} [${describeTriggers(r.triggers)}]${r.enabled ? '' : ' (disabled)'} id=${r.id}`).join('\n') || 'No routines.',
      };
    },
  },

  {
    schema: {
      name: 'DeleteRoutine',
      description: 'Delete one of your routines.',
      parameters: { type: 'object', properties: { routine_id: { type: 'string' } }, required: ['routine_id'] },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      ctx.store.deleteRoutine(str(args.routine_id));
      ctx.emit({ type: 'routines', routines: ctx.store.listRoutines() });
      return { output: 'Deleted.' };
    },
  },

  {
    schema: {
      name: 'TodoWrite',
      description: 'Keep a visible plan for a longer task. Replaces the current list.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    async run(ctx, args) {
      const todos = Array.isArray(args.todos) ? (args.todos as { content: string; status: string }[]) : [];
      writeFileSync(join(ctx.store.agentDir(ctx.agentId), 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
      const rendered = todos
        .map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`)
        .join('\n');
      return { output: rendered || 'Cleared.' };
    },
  },
  {
    schema: {
      name: 'AskUser',
      description:
        'Ask the user a question with buttons instead of prose, when you genuinely need a decision. Their pick comes back as their next message, so this ends your turn — stop after calling it.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'A natural question, exactly as you would say it. Not "pick an option below".' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                value: { type: 'string', description: 'What comes back as their reply. Defaults to the label.' },
                style: { type: 'string', enum: ['default', 'primary', 'danger'] },
              },
              required: ['label'],
            },
          },
          allow_custom: { type: 'boolean', description: 'Let them type their own answer too.' },
        },
        required: ['prompt', 'options'],
      },
    },
    async run(ctx, args) {
      const raw = Array.isArray(args.options) ? (args.options as Record<string, unknown>[]) : [];
      const options = raw
        .map((o) => ({
          label: str(o.label),
          value: str(o.value) || str(o.label),
          style: (str(o.style, 'default') as 'default' | 'primary' | 'danger') || 'default',
        }))
        .filter((o) => o.label);
      if (options.length === 0) return { output: 'Give at least one option.', isError: true };
      ctx.sendWidget({ prompt: str(args.prompt), options, allowCustom: args.allow_custom === true });
      return { output: 'Question sent. End your turn now — their answer arrives as the next message.' };
    },
  },
];

export function parseTrigger(args: Record<string, unknown>): RoutineTrigger | null {
  // A webhook routine waits to be called rather than watching the clock; the token is its whole address,
  // so it is generated here and never taken from the model.
  if (args.webhook === true) return { kind: 'webhook', token: randomUUID().replace(/-/g, '') };
  // The floor is applied here rather than trusted to the caller: this is the path a model writes.
  if (typeof args.every_minutes === 'number' && args.every_minutes > 0) {
    return clampTrigger({ kind: 'interval', everyMinutes: args.every_minutes });
  }

  const weekdays = str(args.weekdays_at);
  if (/^\d{1,2}:\d{2}$/.test(weekdays)) {
    const [h, m] = weekdays.split(':');
    return { kind: 'weekdays', hour: Number(h), minute: Number(m) };
  }

  const daily = str(args.daily_at);
  if (/^\d{1,2}:\d{2}$/.test(daily)) {
    const [h, m] = daily.split(':');
    return { kind: 'daily', hour: Number(h), minute: Number(m) };
  }

  const weekly = str(args.weekly_on).toLowerCase();
  const wm = /^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/.exec(weekly);
  if (wm) {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return { kind: 'weekly', weekday: days.indexOf(wm[1]!), hour: Number(wm[2]), minute: Number(wm[3]) };
  }
  return null;
}

export function describeTrigger(t: RoutineTrigger): string {
  if (t.kind === 'webhook') return 'when its webhook is called';
  if (t.kind === 'interval') return `every ${t.everyMinutes} min`;
  const hh = String(t.hour).padStart(2, '0');
  const mm = String(t.minute).padStart(2, '0');
  if (t.kind === 'daily') return `daily at ${hh}:${mm}`;
  if (t.kind === 'weekdays') return `weekdays at ${hh}:${mm}`;
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.weekday]} at ${hh}:${mm}`;
}

export function describeTriggers(triggers: RoutineTrigger[]): string {
  return triggers.map(describeTrigger).join(', ') || 'no schedule';
}
