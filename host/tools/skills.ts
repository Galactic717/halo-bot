// Saved skills and handing the computer to the user.
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, type Tool } from './core.ts';

export const SKILL_TOOLS: Tool[] = [
  {
    schema: {
      name: 'SaveSkill',
      description:
        'Save a reusable recipe you can look up later. The description decides when it applies, so write it as "use this when ...". A skill has no schedule — use CreateRoutine for something that should run on its own.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string', description: 'Use this when ...' },
          body: { type: 'string', description: 'The recipe, in markdown.' },
        },
        required: ['name', 'description', 'body'],
      },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      const skill = ctx.skills.write(str(args.name), str(args.description), str(args.body));
      ctx.systemEvent({ kind: 'note', label: 'Saved skill', chip: skill.name });
      return { output: `Saved skill "${skill.name}".` };
    },
  },

  {
    schema: {
      name: 'ReadSkill',
      description: 'Read the full body of one of your saved skills before following it.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    async run(ctx, args) {
      const skill = ctx.skills.read(str(args.name));
      if (!skill) return { output: 'No skill by that name.', isError: true };
      return { output: `# ${skill.name}\n> ${skill.description}\n\n${skill.body}` };
    },
  },

  {
    schema: {
      name: 'DeleteSkill',
      description: 'Delete one of your saved skills.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    surface: 'agent_write',
    async run(ctx, args) {
      return { output: ctx.skills.delete(str(args.name)) ? 'Deleted.' : 'No skill by that name.' };
    },
  },

  {
    schema: {
      name: 'HandOverComputer',
      description:
        "Show the user your screen and ask them to do the one step only they can do — a sign-in, 2FA, a captcha, a payment. You never see their credentials. Say what you need in one short line, then end your turn.",
      parameters: {
        type: 'object',
        properties: { instruction: { type: 'string', description: 'One short line, e.g. "Sign in to your Google account".' } },
        required: ['instruction'],
      },
    },
    async run(ctx, args) {
      await ctx.computer.handOver(ctx.agentId, str(args.instruction));
      ctx.sendMessage(`${str(args.instruction)} — I opened the screen for you. Tell me when you're done and I'll pick it back up.`);
      return { output: 'Handed the screen over. End your turn and wait for the user.' };
    },
  },
];
