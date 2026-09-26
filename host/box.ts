import { execFile, execFileSync, spawnSync } from 'node:child_process';
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

const labelled = new Set<string>();

/**
 * Marks a box writable by a Low-integrity process, and nothing else.
 *
 * Two steps, and the first is not optional: setting a mandatory label needs WRITE_OWNER on the
 * directory, which the owner does not hold implicitly — `icacls /setintegritylevel` fails with
 * "Access is denied" on a freshly created folder without it. Granting ourselves full control first
 * works because an owner always holds WRITE_DAC, so we can add the access we are missing.
 *
 * Returns false when the label could not be applied; the box's commands are then refused, because a
 * confined process could not write to its own workspace and an unconfined one is not a box.
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

/**
 * Why a command in this box cannot be confined, or null when it can.
 *
 * The caller refuses to run the command when this returns a reason. Falling back to plain PowerShell
 * — what this used to do — handed the bot the user's full rights exactly when the boundary was
 * missing, and said so nowhere.
 */
export function confinementProblem(
  dir: string,
  resourcesPath?: string,
  helper: string | null = boxHelper(resourcesPath),
): string | null {
  if (process.platform !== 'win32') return 'the box is only enforced on Windows';
  if (!helper) return 'the confinement helper (halo-box.exe) is missing from this install';
  if (!confineBox(dir)) return "the box folder could not be labelled Low integrity";
  return null;
}

/**
 * Deletes a box's AppContainer profile, for a bot that is being deleted.
 *
 * The profile is the container's identity and its private folders under %LOCALAPPDATA%\Packages;
 * left behind, a later box at the same path would inherit whatever the old bot stored there.
 */
export function forgetBox(dir: string, resourcesPath?: string): void {
  const helper = process.platform === 'win32' ? boxHelper(resourcesPath) : null;
  if (helper) spawnSync(helper, ['--forget', dir], { windowsHide: true });
}

export interface Confinement {
  confined: boolean;
  detail: string;
}

/**
 * A probe that the confinement is really in force, run at startup for the banner and About screen.
 *
 * Asserting the mechanism rather than trusting it: the helper could be missing, the label could have
 * failed, or a future Windows could change what Low integrity means. This asks the actual question —
 * can a command started this way write outside its box — and answers from what happened. Async, so
 * the PowerShell start-up it waits on does not stall the main process.
 */
export async function verifyConfinement(dir: string, resourcesPath?: string): Promise<Confinement> {
  const problem = confinementProblem(dir, resourcesPath);
  if (problem) return { confined: false, detail: problem };
  const outside = join(process.env.TEMP ?? 'C:\\Windows\\Temp', `halo-confinement-${Date.now()}.txt`);
  const probe = `try { Set-Content -Path '${outside}' -Value x -ErrorAction Stop; 'ESCAPED' } catch { 'BLOCKED' }`;
  const out = await new Promise<string>((resolve) => {
    execFile(boxHelper(resourcesPath)!, ['--cwd', dir, '--timeout-ms', '15000', '--', probe], { windowsHide: true }, (_err, stdout, stderr) =>
      resolve(`${stdout ?? ''}${stderr ?? ''}`),
    );
  });
  if (out.includes('BLOCKED')) return { confined: true, detail: 'a write outside the box was refused by the kernel' };
  if (out.includes('ESCAPED')) return { confined: false, detail: 'a write outside the box succeeded' };
  return { confined: false, detail: `the probe did not run: ${out.trim().slice(0, 160) || 'no output'}` };
}
