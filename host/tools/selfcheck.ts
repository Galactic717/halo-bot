// SelfCheck, the one command that explains a broken setup.
import { existsSync, writeFileSync, statfsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REFERENCE_DIR, referenceFiles } from '../reference.ts';
import { listModels } from '../provider.ts';
import { probeN8n } from '../n8n.ts';
// Type-only on the way back (scheduler imports Runner as a type), so this is not a runtime cycle.
import { type ToolContext, type Tool } from './core.ts';

export const SELFCHECK_TOOLS: Tool[] = [
  {
    schema: {
      name: 'SelfCheck',
      description:
        'Probe the things that break Halo silently — model server, your box, browser, plugins, disk — and get one PASS/FAIL line each. Run this first when something is wrong, before guessing.',
      parameters: { type: 'object', properties: {} },
    },
    async run(ctx) {
      return { output: await selfCheck(ctx) };
    },
  },
];

/**
 * Halo's answer to Grok Bot's `box-doctor` (docs/GROK_BOT_0.24_0.27_TEARDOWN.md §11.3): one command
 * that probes the handful of things whose failure looks like a dozen unrelated failures, and prints a
 * line per check that a bot can quote to the user instead of speculating.
 */
async function selfCheck(ctx: ToolContext): Promise<string> {
  const lines: string[] = [];
  const say = (ok: boolean, name: string, detail: string) => lines.push(`[selfcheck] ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  const settings = ctx.store.getSettings();

  // The model server, which is the cause far more often than anything else here.
  const model = settings.provider.model.trim();
  if (!model) {
    say(false, 'model', 'no model chosen — Settings → Model');
  } else {
    try {
      const models = await listModels(settings.provider);
      const known = models.length === 0 || models.includes(model);
      say(known, 'model', known ? `${model} at ${settings.provider.baseUrl}` : `${settings.provider.baseUrl} answers but does not serve ${model}`);
    } catch (error) {
      say(false, 'model', `${settings.provider.baseUrl} unreachable — ${String((error as Error)?.message ?? error).slice(0, 120)}`);
    }
  }

  // The box: writable, and holding the reference docs the bot is told to read.
  const box = ctx.store.boxDir(ctx.agentId);
  try {
    const probe = join(box, `.selfcheck-${randomUUID().slice(0, 8)}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    say(true, 'box', box);
  } catch (error) {
    say(false, 'box', `cannot write ${box} — ${String((error as Error)?.message ?? error).slice(0, 120)}`);
  }
  const refs = referenceFiles().filter((name) => existsSync(join(box, REFERENCE_DIR, name)));
  say(refs.length === referenceFiles().length, 'reference', refs.length ? `${REFERENCE_DIR}/: ${refs.join(', ')}` : 'missing');

  // Free space, because a box that cannot write fails in a dozen unrelated-looking ways.
  try {
    const fs = statfsSync(box);
    const freeGb = (fs.bavail * fs.bsize) / 1024 ** 3;
    say(freeGb > 1, 'disk', `${freeGb.toFixed(1)} GB free`);
  } catch {
    say(true, 'disk', 'not reported on this volume');
  }

  // The browser view, which is started on demand and can fail long before anyone clicks anything.
  try {
    await ctx.computer.ensure(ctx.agentId);
    say(true, 'browser', 'window ready');
  } catch (error) {
    say(false, 'browser', String((error as Error)?.message ?? error).slice(0, 160));
  }

  // The automation the bots may have been told to use, if the user connected one.
  if (settings.n8n?.enabled) {
    const probe = await probeN8n(settings);
    say(probe.ok, 'n8n', probe.detail);
  }

  const plugins = ctx.pluginStatus?.() ?? [];
  if (plugins.length === 0) {
    say(true, 'plugins', 'none installed');
  } else {
    for (const plugin of plugins) {
      say(plugin.state === 'ready', `plugin:${plugin.name}`, plugin.state === 'ready' ? `${plugin.toolCount} tools` : `${plugin.state}${plugin.error ? ` — ${plugin.error.slice(0, 120)}` : ''}`);
    }
  }

  const failed = lines.filter((l) => l.includes('] FAIL ')).length;
  lines.push(`[selfcheck] SUMMARY ${lines.length - failed} passed, ${failed} failed`);
  return lines.join('\n');
}
