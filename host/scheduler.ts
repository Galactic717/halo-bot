import type { Store } from './store.ts';
import type { HaloEvent, Routine, RoutineRun, RoutineTrigger } from './types.ts';
import type { Runner } from './runner.ts';

export function nextRunForTrigger(trigger: RoutineTrigger, from = Date.now()): number {
  if (trigger.kind === 'interval') return from + trigger.everyMinutes * 60_000;
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(trigger.hour, trigger.minute, 0, 0);

  if (trigger.kind === 'daily') {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  if (trigger.kind === 'weekdays') {
    if (next.getTime() <= from) next.setDate(next.getDate() + 1);
    while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    return next.getTime();
  }

  const delta = (trigger.weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next.getTime() <= from) next.setDate(next.getDate() + 7);
  return next.getTime();
}

/** Earliest of all the routine's triggers. */
export function nextRun(routine: Pick<Routine, 'triggers'>, from = Date.now()): number {
  const times = (routine.triggers ?? []).map((t) => nextRunForTrigger(t, from));
  return times.length ? Math.min(...times) : from + 24 * 60 * 60_000;
}

const DEFAULT_MAX_RUNS_PER_DAY = 24;

/**
 * Consecutive failures before a routine is paused.
 *
 * A routine whose site moved or whose command no longer exists fails identically every time. Left
 * alone it burns tokens on a schedule and fills the history with the same line, and nobody reads a
 * history that is all the same line. Three is Hermes's default for the same reason.
 */
const FAILURE_STREAK_LIMIT = 3;

/**
 * Whether the app is in a state where firing a routine can possibly work.
 *
 * Checked before any model machinery is built, so a routine that fires while the model server is
 * down is skipped and left due rather than burnt as a failure — the alternative spends the daily
 * allowance and the failure streak on an outage that has nothing to do with the routine.
 */
export function preflight(settings: { provider: { model: string; baseUrl: string } }, providerHealthy: boolean | null): string | null {
  if (!settings.provider.model.trim()) return 'no model is configured';
  if (providerHealthy === false) return `the model server at ${settings.provider.baseUrl} is not answering`;
  return null;
}

/** True when a routine has already fired its daily allowance. */
export function isOverDailyCap(runs: RoutineRun[] | undefined, cap: number, now: number): boolean {
  const dayAgo = now - 86_400_000;
  return (runs ?? []).filter((run) => run.at >= dayAgo).length >= cap;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private store: Store;
  private runner: Runner;
  private emit: (event: HaloEvent) => void;
  /** Set by main from the provider health check, so a tick can tell an outage from a bad routine. */
  providerHealthy: boolean | null = null;
  private warnedBlocked = new Set<string>();

  constructor(store: Store, runner: Runner, emit: (event: HaloEvent) => void) {
    this.store = store;
    this.runner = runner;
    this.emit = emit;
  }

  start() {
    for (const r of this.store.listRoutines()) {
      if (r.enabled && !r.nextRunAt) this.store.saveRoutine({ ...r, nextRunAt: nextRun(r) });
    }
    this.timer = setInterval(() => this.tick(), 20_000);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const now = Date.now();
    let changed = false;
    // Nothing can run right now: leave every routine due and say so once, rather than spending the
    // daily allowance and the failure streak on an outage none of them caused.
    const blocked = preflight(this.store.getSettings(), this.providerHealthy);
    for (const routine of this.store.listRoutines()) {
      if (!routine.enabled) continue;
      const due = routine.nextRunAt ?? nextRun(routine, routine.createdAt);
      if (due > now) continue;
      if (blocked) {
        if (!this.warnedBlocked.has(routine.id)) {
          this.warnedBlocked.add(routine.id);
          this.runner.systemEvent(routine.agentId, {
            kind: 'routine',
            label: `"${routine.name}" is waiting — ${blocked}`,
          });
        }
        continue;
      }
      this.warnedBlocked.delete(routine.id);
      if (!this.store.getAgent(routine.agentId)) {
        this.store.deleteRoutine(routine.id);
        changed = true;
        continue;
      }
      const cap = routine.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY;
      if (isOverDailyCap(routine.runs, cap, now)) {
        // Pause rather than hammer: the user gets one line, not a flood of turns.
        this.store.saveRoutine({ ...routine, enabled: false, nextRunAt: nextRun(routine, now) });
        this.runner.systemEvent(routine.agentId, {
          kind: 'routine',
          label: `Paused "${routine.name}" — it hit its limit of ${cap} runs in a day`,
        });
        changed = true;
        continue;
      }

      // The run is recorded now so the daily cap counts queued turns too, then corrected on finish.
      this.store.saveRoutine({
        ...routine,
        lastRunAt: now,
        nextRunAt: nextRun(routine, now),
        runs: [...(routine.runs ?? []), { at: now, status: 'ok' as const, note: 'running' }].slice(-20),
      });
      // A routine that reports the same thing every hour is noise; with continuity on it can see
      // what it last said and stay quiet when nothing has moved.
      const prompt = routine.continuity && routine.lastOutput
        ? `${routine.prompt}\n\n[What you reported last time]\n${routine.lastOutput}\n\nIf nothing has changed since then, end the turn silently instead of repeating yourself.`
        : routine.prompt;
      this.runner.submitSystemTurn(routine.agentId, prompt, `Routine "${routine.name}"`, 'routine', (ok, note) =>
        this.finishRun(routine.id, now, ok, note),
      );
      changed = true;
    }
    if (changed) this.emit({ type: 'routines', routines: this.store.listRoutines() });
  }

  /** Replaces the provisional entry with what actually happened, so the history is not a guess. */
  private finishRun(routineId: string, at: number, ok: boolean, note?: string) {
    const routine = this.store.getRoutine(routineId);
    if (!routine) return;
    const runs = (routine.runs ?? []).map((run) =>
      run.at === at ? { at, status: ok ? ('ok' as const) : ('error' as const), ...(note ? { note } : {}) } : run,
    );
    const streak = ok ? 0 : (routine.failureStreak ?? 0) + 1;
    const exhausted = streak >= FAILURE_STREAK_LIMIT;
    if (exhausted) {
      this.runner.systemEvent(routine.agentId, {
        kind: 'routine',
        label: `Paused "${routine.name}" — it failed ${streak} times in a row`,
        ...(note ? { chip: note.slice(0, 80) } : {}),
      });
    }
    this.store.saveRoutine({
      ...routine,
      runs,
      failureStreak: streak,
      ...(exhausted ? { enabled: false } : {}),
      ...(ok && routine.continuity && note ? { lastOutput: note.slice(0, 2000) } : {}),
    });
    this.emit({ type: 'routines', routines: this.store.listRoutines() });
  }
}
