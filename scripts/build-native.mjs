import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Builds the box confinement helper.
 *
 * Skipped rather than fatal when cargo is missing: `runShell` falls back to plain PowerShell without
 * it, which is how the app behaved before the helper existed. A build that refuses to produce an app
 * because one optional binary could not be compiled is worse than an app that says, on its About
 * screen, that the boundary is not in force.
 */
const crate = join(process.cwd(), 'native', 'halo-box');
const out = join(crate, 'target', 'release', 'halo-box.exe');

if (process.platform !== 'win32') {
  console.log('[native] not Windows — the box helper is Windows-only, skipping');
  process.exit(0);
}

const cargo = spawnSync('cargo', ['build', '--release', '--offline'], { cwd: crate, stdio: 'inherit', shell: true });
if (cargo.status !== 0) {
  console.warn('[native] cargo build failed or cargo is not installed — the box will run unconfined');
  process.exit(0);
}

if (!existsSync(out)) {
  console.warn('[native] cargo reported success but produced no binary — the box will run unconfined');
  process.exit(0);
}

// Copied next to the built main process so a packaged app and `npm start` find it the same way.
mkdirSync(join(process.cwd(), 'build'), { recursive: true });
copyFileSync(out, join(process.cwd(), 'build', 'halo-box.exe'));
console.log('[native] halo-box.exe built and staged in build/');
