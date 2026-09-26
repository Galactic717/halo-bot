import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxHelper, confineBox, verifyConfinement } from './box.ts';

/**
 * The box, asserted against the real kernel rather than described.
 *
 * These run the built `halo-box.exe`. On a developer machine without a Rust toolchain they skip; in
 * CI the helper is built first, so a missing one is a failure rather than a quiet pass.
 */
const helper = process.platform === 'win32' ? boxHelper() : null;
const skip =
  process.platform !== 'win32'
    ? 'the box is Windows-only'
    : helper || process.env.CI
      ? false
      : 'halo-box.exe is not built (npm run build:native)';

/** Runs one PowerShell command inside a box and returns what it printed. */
function inBox(box: string, command: string): string {
  const result = spawnSync(helper!, ['--cwd', box, '--timeout-ms', '20000', '--', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

test('the box helper is built', { skip }, () => {
  assert.ok(helper, 'CI must build native/halo-box before the tests run');
});

test('a box command cannot write outside its box', { skip }, () => {
  const box = mkdtempSync(join(tmpdir(), 'halo-box-'));
  const verdict = verifyConfinement(box);
  assert.equal(verdict.confined, true, verdict.detail);
});

test('a box command can still write inside its own box', { skip }, () => {
  const box = mkdtempSync(join(tmpdir(), 'halo-box-'));
  assert.ok(confineBox(box));
  const out = inBox(box, "Set-Content -Path inside.txt -Value ok; Get-Content inside.txt");
  assert.equal(out, 'ok');
});
