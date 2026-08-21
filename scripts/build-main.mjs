import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist/main', { recursive: true, force: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outExtension: { '.js': '.cjs' },
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.cjs' });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.cjs' });
if (!watch) process.exit(0);
