// The bot's own box: its shell and its files.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, basename } from 'node:path';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, num, clip, boxPath, fileKind, runShell, type Tool } from './core.ts';

export const WORKSPACE_TOOLS: Tool[] = [
  {
    schema: {
      name: 'Shell',
      description:
        "Run a PowerShell command in your box: your own sandboxed folder and shell. Use it for anything scriptable: files, git, python. It cannot see the user's files or other bots' boxes, and it has no network unless the user turned it on for you — use the browser and fetch tools for the web.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: "Directory inside your box. Defaults to the box root." },
          timeout_ms: { type: 'number' },
          background: {
            type: 'boolean',
            description:
              'Set true for anything slow or never-ending (installs, builds, dev servers, watchers). Returns a shell id immediately; you are told when it finishes.',
          },
        },
        required: ['command'],
      },
    },
    surface: 'shell',
    async run(ctx, args) {
      const cwd = str(args.cwd) ? boxPath(ctx, str(args.cwd)) : ctx.store.boxDir(ctx.agentId);
      if (args.background === true) {
        const id = ctx.startBackground(str(args.command), cwd, true);
        return { output: `Started in the background as ${id}. Keep working; you will be told when it finishes.` };
      }
      const box = { dir: ctx.store.boxDir(ctx.agentId), network: ctx.store.getAgent(ctx.agentId)?.boxNetwork === true };
      const { code, out } = await runShell(str(args.command), cwd, ctx.signal, num(args.timeout_ms, 120_000), box);
      return { output: clip(`exit ${code}\n${out || '(no output)'}`), isError: code !== 0 };
    },
  },

  {
    schema: {
      name: 'Read',
      description: 'Read a text file from your box.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
        required: ['path'],
      },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${str(args.path)}`, isError: true };

      // An image is something to look at, not to read; other binaries would only pollute the context.
      const kind = fileKind(p);
      if (kind === 'image') return { output: `${basename(p)} is an image. Look at it below.`, imagePath: p };
      if (kind === 'binary') {
        return { output: `${basename(p)} is a binary file (${statSync(p).size} bytes). Use Shell to inspect it.`, isError: true };
      }

      const lines = readFileSync(p, 'utf8').split('\n');
      const offset = Math.max(0, num(args.offset, 0));
      const limit = num(args.limit, 800);
      const slice = lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`);
      return { output: clip(slice.join('\n')) };
    },
  },

  {
    schema: {
      name: 'Write',
      description: 'Create or overwrite a file in your box.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, str(args.content), 'utf8');
      return { output: `Wrote ${str(args.content).length} characters to ${relative(ctx.store.boxDir(ctx.agentId), p) || basename(p)}` };
    },
  },

  {
    schema: {
      name: 'Edit',
      description: 'Replace an exact string inside a file in your box.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async run(ctx, args) {
      const p = boxPath(ctx, str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${str(args.path)}`, isError: true };
      const cur = readFileSync(p, 'utf8');
      const old = str(args.old_string);
      if (!cur.includes(old)) return { output: 'old_string not found in the file.', isError: true };
      writeFileSync(p, cur.replace(old, str(args.new_string)), 'utf8');
      return { output: 'Edited.' };
    },
  },

  {
    schema: {
      name: 'ListFiles',
      description: 'List files and folders in your box.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
    async run(ctx, args) {
      const p = str(args.path) ? boxPath(ctx, str(args.path)) : ctx.store.boxDir(ctx.agentId);
      if (!existsSync(p)) return { output: 'No such directory.', isError: true };
      const entries = readdirSync(p, { withFileTypes: true }).map((d) => {
        const full = join(p, d.name);
        const size = d.isFile() ? statSync(full).size : 0;
        return d.isDirectory() ? `${d.name}/` : `${d.name} (${size} B)`;
      });
      return { output: entries.join('\n') || '(empty)' };
    },
  },
];
