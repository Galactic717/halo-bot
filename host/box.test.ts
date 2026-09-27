import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxHelper, confineBox, confinementProblem, forgetBox, verifyConfinement } from './box.ts';
import { runShell } from './tools.ts';

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
function inBox(box: string, command: string, extra: string[] = []): string {
  const result = spawnSync(helper!, ['--box', box, '--cwd', box, ...extra, '--timeout-ms', '20000', '--', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

const made: string[] = [];

/** Makes a box the way the app does: the folder, then the label and grants the helper needs. */
function newBox(): string {
  const box = mkdtempSync(join(tmpdir(), 'halo-box-'));
  assert.ok(confineBox(box));
  made.push(box);
  return box;
}

// Every box used here got an AppContainer profile; leaving them would pile up one per test run.
after(() => {
  for (const box of made) forgetBox(box);
});

test('the box helper is built', { skip }, () => {
  assert.ok(helper, 'CI must build native/halo-box before the tests run');
});

test('a box command cannot write outside its box', { skip }, async () => {
  const box = newBox();
  const verdict = await verifyConfinement(box);
  assert.equal(verdict.confined, true, verdict.detail);
});

test('a box without its helper is reported, so its commands are refused rather than run unconfined', { skip: process.platform !== 'win32' }, () => {
  const box = mkdtempSync(join(tmpdir(), 'halo-box-'));
  assert.match(confinementProblem(box, undefined, null) ?? '', /helper .* missing/);
});

test('a box command can still write inside its own box', { skip }, () => {
  const box = newBox();
  const out = inBox(box, "Set-Content -Path inside.txt -Value ok; Get-Content inside.txt");
  assert.equal(out, 'ok');
});

/** Runs a PowerShell script from a file in the box, which sidesteps quoting it through argv. */
function inBoxScript(box: string, script: string): string {
  writeFileSync(join(box, 'probe.ps1'), script);
  return inBox(box, '& .\\probe.ps1');
}

test("a box command gets a scratch folder it can write, and it is not the user's", { skip }, () => {
  const box = newBox();
  // Windows hands an app container a temp folder of its own; whatever it is, it must be writable
  // and it must not be the user's %TEMP%, which the container has no business reading.
  const out = inBox(box, '[IO.Path]::GetTempFileName()');
  assert.ok(existsSync(out), `could not create a temp file: ${out}`);
  assert.equal(realpathSync.native(out).toLowerCase().startsWith(realpathSync.native(tmpdir()).toLowerCase() + '\\'), false, out);
});

test("a box command cannot see the windows on the user's desktop", { skip }, () => {
  const box = newBox();
  const out = inBoxScript(
    box,
    [
      `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr FindWindow(string c, string w);'`,
      `[W.U]::FindWindow("Shell_TrayWnd", $null)`,
    ].join('\n'),
  );
  // The taskbar lives on the user's desktop; from the box's own desktop there is nothing to find.
  assert.equal(out, '0');
});

test('the shell a bot actually gets runs a command in its box', { skip, timeout: 120_000 }, async () => {
  const box = newBox();
  const started = Date.now();
  const result = await runShell('Write-Output hello', box, new AbortController().signal, 100_000, { dir: box });
  const took = Date.now() - started;
  assert.equal(result.out.trim(), 'hello', `exit ${result.code} after ${took}ms: ${result.out.slice(0, 300)}`);
  // A box command that takes this long is a start-up cost every tool call pays.
  assert.ok(took < 10_000, `the box shell took ${took}ms to say hello`);
});


test("a bot cannot write into another bot's box", { skip }, () => {
  const mine = newBox();
  const theirs = newBox();
  inBox(theirs, 'Write-Output ready'); // their box exists and has been used
  const out = inBox(mine, `try { Set-Content -Path '${join(theirs, 'planted.txt')}' -Value x -ErrorAction Stop; 'WROTE' } catch { 'BLOCKED' }`);
  assert.equal(out, 'BLOCKED');
  assert.equal(existsSync(join(theirs, 'planted.txt')), false);
});

test("a bot cannot read another bot's box", { skip }, () => {
  const mine = newBox();
  const theirs = newBox();
  inBox(theirs, "Set-Content -Path notes.txt -Value 'their secret'");
  const out = inBox(mine, `try { Get-Content -Path '${join(theirs, 'notes.txt')}' -ErrorAction Stop } catch { 'BLOCKED' }`);
  assert.equal(out, 'BLOCKED');
});

test("a bot cannot read the user's own files", { skip }, () => {
  const box = newBox();
  // An ordinary folder in the user's profile, as their documents or ~/.ssh would be.
  const home = mkdtempSync(join(tmpdir(), 'halo-user-'));
  writeFileSync(join(home, 'id_ed25519'), 'PRIVATE KEY');
  const out = inBox(box, `try { Get-Content -Path '${join(home, 'id_ed25519')}' -ErrorAction Stop } catch { 'BLOCKED' }`);
  assert.equal(out, 'BLOCKED');
});

const probeNet = "try { $null = (New-Object Net.WebClient).DownloadString('http://example.com'); 'ONLINE' } catch { 'OFFLINE' }";

test('a box has no network unless the bot is given it', { skip, timeout: 60_000 }, async (t) => {
  const online = await fetch('http://example.com', { signal: AbortSignal.timeout(10_000) }).then(
    () => true,
    () => false,
  );
  if (!online) return t.skip('this machine is offline, so there is nothing to withhold');
  const box = newBox();
  assert.equal(inBox(box, probeNet), 'OFFLINE');
  assert.equal(inBox(box, probeNet, ['--network']), 'ONLINE');
});

test("a deleted bot's container goes with it", { skip }, () => {
  const packages = join(process.env.LOCALAPPDATA ?? '', 'Packages');
  // Windows lower-cases the profile folder's name.
  const containers = () => new Set(readdirSync(packages).filter((name) => name.toLowerCase().startsWith('halo.box.')));
  const before = containers();
  const box = newBox();
  inBox(box, 'Write-Output ready');
  const created = [...containers()].filter((name) => !before.has(name));
  assert.equal(created.length, 1, 'using a box creates exactly one container profile');
  forgetBox(box);
  assert.equal(containers().has(created[0]!), false);
});

/** A box nested the way the app nests one, under folders the container may not look at. */
function nestedBox(): string {
  const box = join(mkdtempSync(join(tmpdir(), 'halo-nest-')), 'agents', 'bot', 'box');
  mkdirSync(box, { recursive: true });
  assert.ok(confineBox(box));
  made.push(box);
  return box;
}

test('double quotes in a box command reach PowerShell intact', { skip }, () => {
  const box = nestedBox();
  // Appended raw to the command line, powershell.exe split these off and ran `Write-Output two words`.
  const out = inBox(box, 'Write-Output "two words"; $s = \'{"name":"Olena"}\' | ConvertFrom-Json; $s.name; "{0}-{1}" -f 1, 2');
  assert.match(out, /^two words\r?\nOlena\r?\n1-2$/, out);
});

test('a bot can rename, move and delete files in its own box, the host\'s and its own', { skip }, () => {
  const box = nestedBox();
  writeFileSync(join(box, 'a.log'), 'a');
  writeFileSync(join(box, 'b.log'), 'b');
  writeFileSync(join(box, 'keep.txt'), 'k');
  // Through the Box: drive the provider walked the folders above the box to fix up casing, and the
  // container may not see those, so all three failed with "Access is denied" while writes worked.
  const out = inBox(box, 'New-Item -ItemType Directory logs | Out-Null; Move-Item *.log logs; Rename-Item keep.txt kept.txt; New-Item -ItemType File tmp.txt | Out-Null; rm tmp.txt; Get-ChildItem -Recurse -Name');
  assert.doesNotMatch(out, /denied/i, out);
  assert.deepEqual(readdirSync(box).filter((n) => !n.startsWith('.')).sort(), ['kept.txt', 'logs']);
  assert.deepEqual(readdirSync(join(box, 'logs')).sort(), ['a.log', 'b.log']);
});
