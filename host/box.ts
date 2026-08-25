import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bot's box, as a boundary the kernel enforces rather than one a regex describes.
 *
 * Until now `Shell` was real PowerShell with the user's full rights, and `reachesOutsideBox` in
 * host/policy.ts could only make an escape *visible*: it reads the command text, and a determined
 * model writes the same command a hundred ways. The `ponytail:` note there said to swap in a real
 * boundary if the box was ever meant to be one. This is that swap.
 *
 * Two halves, and both are needed:
 *
 *  - `halo-box.exe` (native/halo-box) runs the command under a restricted, **Low integrity** token
 *    inside a job object. Windows' mandatory integrity control then refuses every write to anything
 *    at Medium — the user's profile, their documents, HKCU, Halo's own data directory.
 *  - The box directory is labelled Low, so the bot still has somewhere to work.
 *
 * What it stops: changing anything outside the box. What it does not stop: reading. Most objects
 * carry no no-read-up policy, so a Low process can still read the user's files, and closing that
 * would need an AppContainer with its own profile. The half this closes is the half that is not
 * recoverable.
 */

/**
 * Where the helper lives: beside the packaged app, or in the build tree during development.
 *
 * No `__dirname`. This file is bundled to CommonJS for Electron and also loaded as an ES module by
 * node when the tests and the probe run it directly, and `__dirname` exists in only one of those —
 * naming it makes node refuse the file outright as ambiguous.
 */
export function helperPath(resourcesPath?: string): string | null {
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'halo-box.exe')] : []),
    join(process.cwd(), 'build', 'halo-box.exe'),
    join(process.cwd(), 'native', 'halo-box', 'target', 'release', 'halo-box.exe'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

let resolved: string | null | undefined;

/**
 * The helper, looked up once.
 *
 * Cached because it is asked for on every shell call, and `undefined` rather than `null` marks "not
 * looked yet" so a genuine absence is not re-probed on every command.
 */
export function boxHelper(resourcesPath?: string): string | null {
  if (resolved === undefined) resolved = helperPath(resourcesPath);
  return resolved;
}

/** Only meaningful on Windows; everywhere else the helper does not exist and the caller falls back. */
export function confinementAvailable(resourcesPath?: string): boolean {
  return process.platform === 'win32' && boxHelper(resourcesPath) !== null;
}

const labelled = new Set<string>();

/**
 * Marks a box writable by a Low-integrity process, and nothing else.
 *
 * Two steps, and the first is not optional: setting a mandatory label needs WRITE_OWNER on the
 * directory, which the owner does not hold implicitly — `icacls /setintegritylevel` fails with
 * "Access is denied" on a freshly created folder without it. Granting ourselves full control first
 * works because an owner always holds WRITE_DAC, so we can add the access we are missing.
 *
 * Returns false when the label could not be applied, which is the caller's signal to keep the box
 * unconfined rather than hand the bot a shell that cannot write to its own workspace.
 */
export function confineBox(dir: string): boolean {
  if (process.platform !== 'win32') return false;
  if (labelled.has(dir)) return true;
  mkdirSync(dir, { recursive: true });
  const account = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  try {
    execFileSync('icacls', [dir, '/grant', `${account}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    execFileSync('icacls', [dir, '/setintegritylevel', '(OI)(CI)L'], { stdio: 'ignore', windowsHide: true });
    labelled.add(dir);
    return true;
  } catch {
    return false;
  }
}

/** True when this box is labelled and the helper is present, so a command in it can be confined. */
export function canConfine(dir: string, resourcesPath?: string): boolean {
  return confinementAvailable(resourcesPath) && confineBox(dir);
}

/**
 * A one-off probe that the confinement is really in force, for the About screen and for a test.
 *
 * Asserting the mechanism rather than trusting it: the helper could be missing, the label could have
 * failed, or a future Windows could change what Low integrity means. This asks the actual question —
 * can a command started this way write outside its box — and answers from what happened.
 */
export function verifyConfinement(dir: string, resourcesPath?: string): { confined: boolean; detail: string } {
  const helper = boxHelper(resourcesPath);
  if (!helper) return { confined: false, detail: 'the confinement helper is not built' };
  if (!confineBox(dir)) return { confined: false, detail: 'the box could not be labelled low integrity' };
  const outside = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `halo-confinement-${Date.now()}.txt`);
  const result = spawnSync(
    helper,
    ['--cwd', dir, '--timeout-ms', '15000', '--', `try { Set-Content -Path '${outside}' -Value x -ErrorAction Stop; 'ESCAPED' } catch { 'BLOCKED' }`],
    { encoding: 'utf8', windowsHide: true },
  );
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (out.includes('BLOCKED')) return { confined: true, detail: 'a write outside the box was refused by the kernel' };
  if (out.includes('ESCAPED')) return { confined: false, detail: 'a write outside the box succeeded' };
  return { confined: false, detail: `the probe did not run: ${out.trim().slice(0, 160) || 'no output'}` };
}
