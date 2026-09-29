// The user's machine, always behind the approval gate.
import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { dirname, normalize, relative, basename } from 'node:path';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { str, num, clip, boxPath, fileKind, runShell, type Tool } from './core.ts';

export const EXTERNAL_TOOLS: Tool[] = [
  {
    schema: {
      name: 'ExternalShell',
      description:
        "Run a PowerShell command on the USER'S computer, outside your box. Needs the user's approval. Use it only when the work has to happen on their machine.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          reason: { type: 'string', description: 'Why this has to run on their machine.' },
          timeout_ms: { type: 'number' },
        },
        required: ['command'],
      },
    },
    surface: 'external_shell',
    async run(ctx, args) {
      const cwd = str(args.cwd) || process.env.USERPROFILE || 'C:/';
      const { code, out } = await runShell(str(args.command), cwd, ctx.signal, num(args.timeout_ms, 120_000));
      return { output: clip(`exit ${code}\n${out || '(no output)'}`), isError: code !== 0 };
    },
  },

  {
    schema: {
      name: 'ExternalRead',
      description: "Read a file from the USER'S computer (any absolute path). Needs approval.",
      parameters: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } }, required: ['path'] },
    },
    surface: 'external_read',
    async run(_ctx, args) {
      const p = normalize(str(args.path));
      if (!existsSync(p)) return { output: `No such file: ${p}`, isError: true };
      const kind = fileKind(p);
      if (kind === 'image') return { output: `${basename(p)} is an image; look at it below.`, imagePath: p };
      if (kind === 'binary') return { output: `${basename(p)} is a binary file. Use ExternalShell if you need to inspect it.`, isError: true };
      const lines = readFileSync(p, 'utf8').split(/\r?\n/).slice(0, num(args.limit, 800));
      return { output: clip(lines.join('\n')) };
    },
  },

  {
    schema: {
      name: 'CopyToBox',
      description: "Copy a file from the user's computer into your box so you can work on it.",
      parameters: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' } }, required: ['source'] },
    },
    surface: 'external_read',
    async run(ctx, args) {
      const src = normalize(str(args.source));
      if (!existsSync(src)) return { output: `No such file: ${src}`, isError: true };
      const dst = boxPath(ctx, str(args.destination) || basename(src));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return { output: `Copied to ${relative(ctx.store.boxDir(ctx.agentId), dst)}` };
    },
  },

  {
    schema: {
      name: 'CopyFromBox',
      description: "Copy a file out of your box onto the user's computer. Needs approval.",
      parameters: { type: 'object', properties: { box_path: { type: 'string' }, destination: { type: 'string' } }, required: ['box_path', 'destination'] },
    },
    surface: 'file_write',
    async run(ctx, args) {
      const src = boxPath(ctx, str(args.box_path));
      if (!existsSync(src)) return { output: 'No such file in your box.', isError: true };
      const dst = normalize(str(args.destination));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      return { output: `Copied to ${dst}` };
    },
  },
];
