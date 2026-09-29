// Creating and talking to other bots.
import type { Agent } from '../types.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, type Tool } from './core.ts';

export const AGENT_TOOLS: Tool[] = [
  {
    schema: {
      name: 'CreateAgent',
      description: 'Create another bot (a teammate) with its own chat, box and memory.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', description: 'What this teammate is for.' },
          color: { type: 'string' },
        },
        required: ['name'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const agent = ctx.runner.createAgent({
        name: str(args.name),
        title: str(args.title),
        description: str(args.description),
        color: str(args.color, 'purple'),
      });
      ctx.systemEvent({ kind: 'agent', label: 'Created bot', chip: agent.name, chipAgentId: agent.id });
      return { output: `Created bot "${agent.name}" (id ${agent.id}). Use SendToAgent to give it work.` };
    },
  },

  {
    schema: {
      name: 'UpdateAgent',
      description: 'Update your own profile (or another bot): name, title, description.',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const id = str(args.agent_id) || ctx.agentId;
      const patch: Partial<Agent> = {};
      if (str(args.name)) patch.name = str(args.name);
      if (typeof args.title === 'string') patch.title = str(args.title);
      if (typeof args.description === 'string') patch.description = str(args.description);
      const next = ctx.runner.updateAgent(id, patch);
      return next ? { output: `Updated ${next.name}.` } : { output: 'No such bot.', isError: true };
    },
  },

  {
    schema: {
      name: 'SendToAgent',
      description:
        'Message another bot, or post into a room you belong to. Asynchronous: it returns right away and wakes them to work in their own chat. Give the id of a bot or of a channel.',
      parameters: { type: 'object', properties: { agent_id: { type: 'string' }, text: { type: 'string' } }, required: ['agent_id', 'text'] },
    },
    async run(ctx, args) {
      const id = str(args.agent_id);
      const channel = ctx.store.getChannel(id);
      if (channel) {
        if (!channel.memberIds.includes(ctx.agentId)) return { output: `You are not in the ${channel.name} room.`, isError: true };
        ctx.runner.postToRoom(channel.id, ctx.agentId, str(args.text));
        ctx.systemEvent({ kind: 'handoff', label: 'Posted to', chip: channel.name });
        return { output: `Posted in ${channel.name}. Everyone in the room sees it.` };
      }

      const target = ctx.store.getAgent(id);
      if (!target) {
        const list = ctx.store.listAgents().map((a) => `${a.name} -> ${a.id}`).join('\n');
        return { output: `No such bot or room. Known bots:\n${list}`, isError: true };
      }
      ctx.runner.deliverToAgent(ctx.agentId, target.id, str(args.text));
      ctx.systemEvent({ kind: 'handoff', label: 'Messaged', chip: target.name, chipAgentId: target.id });
      return { output: `Sent to ${target.name}. They will work on it in their own chat.` };
    },
  },

  {
    schema: {
      name: 'ListAgents',
      description: 'List the other bots on this machine with their ids.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      const list = ctx.store.listAgents().map((a) => `- ${a.name} (${a.id})${a.title ? ` - ${a.title}` : ''} [${a.status}]`);
      return { output: list.join('\n') || 'No other bots yet.' };
    },
  },
];
