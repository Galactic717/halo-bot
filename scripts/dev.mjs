import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import { context } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
};

const mainCtx = await context({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.cjs' });
const preloadCtx = await context({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.cjs' });
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
server.printUrls();

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, HALO_DEV: '1' },
});

child.on('close', async () => {
  await server.close();
  await mainCtx.dispose();
  await preloadCtx.dispose();
  process.exit(0);
});
