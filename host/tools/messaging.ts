// Talking in the conversation.
import { existsSync } from 'node:fs';
import { normalize } from 'node:path';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, type Tool } from './core.ts';

export const MESSAGING_TOOLS: Tool[] = [
  {
    schema: {
      name: 'SendMessage',
      description:
        'Say something to the user in the chat. This is the ONLY way the user hears from you - plain assistant text is never delivered. Use it to report progress, ask a question, or hand over finished work.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Markdown message shown in the chat.' },
          images: {
            type: 'array',
            description: 'Absolute paths of images to show inside this message. Only paths a tool actually returned.',
            items: { type: 'string' },
          },
        },
        required: ['text'],
      },
    },
    async run(ctx, args) {
      const text = str(args.text).trim();
      const images = (Array.isArray(args.images) ? args.images : [])
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .map((path) => ({ path: normalize(path) }))
        .filter((image) => existsSync(image.path));
      if (!text && images.length === 0) return { output: 'Nothing sent: text was empty.', isError: true };
      ctx.sendMessage(text, images);
      return { output: `${images.length ? `Delivered with ${images.length} image(s).` : 'Delivered to the user.'} If the work is done, stop: end your turn without calling another tool.` };
    },
  },

  {
    schema: {
      name: 'ReactToMessage',
      description: 'Put an emoji reaction on a message in this chat.',
      parameters: {
        type: 'object',
        properties: {
          message_id: { type: 'string', description: 'Id of the message to react to; omit for the latest user message.' },
          emoji: { type: 'string', description: 'A single emoji.' },
        },
        required: ['emoji'],
      },
    },
    async run(ctx, args) {
      const transcript = ctx.store.transcript(ctx.agentId);
      const target = str(args.message_id)
        ? transcript.find((m) => m.id === str(args.message_id))
        : [...transcript].reverse().find((m) => m.role === 'user');
      if (!target) return { output: 'No such message.', isError: true };
      const reactions = [...(target.reactions ?? []), str(args.emoji)];
      ctx.store.updateMessage(ctx.agentId, target.id, { reactions });
      ctx.emit({ type: 'message.patch', agentId: ctx.agentId, messageId: target.id, reactions });
      return { output: 'Reaction added.' };
    },
  },
];
