import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Builds the box confinement helper from source and stages it in build/.
 *
 * `--strict` (CI and `npm run package`) turns every failure into a non-zero exit: a package built
 * without the helper would ship a bot shell with the user's full rights. Without the flag a missing
 * cargo only warns, so `npm run dev` still starts on a machine that has no Rust toolchain.
 */
const strict = process.argv.includes('--strict');
const crate = join(process.cwd(), 'native', 'halo-box');
const out = join(crate, 'target', 'release', 'halo-box.exe');

function giveUp(message) {
  if (strict) {
    console.error(`[native] ${message}`);
    process.exit(1);
  }
  console.warn(`[native] ${message} — bot shells will be switched off until the helper is built`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('[native] not Windows — the box helper is Windows-only, skipping');
  process.exit(0);
}

const cargo = spawnSync('cargo', ['build', '--release', '--offline'], { cwd: crate, stdio: 'inherit' });
if (cargo.status !== 0) giveUp('cargo build failed or cargo is not installed');
if (!existsSync(out)) giveUp('cargo reported success but produced no binary');

// Copied next to the built main process so a packaged app and `npm start` find it the same way.
mkdirSync(join(process.cwd(), 'build'), { recursive: true });
copyFileSync(out, join(process.cwd(), 'build', 'halo-box.exe'));
console.log('[native] halo-box.exe built and staged in build/');
