import type { Store } from './store.ts';
import type { HaloEvent, Routine, RoutineRun, RoutineTrigger } from './types.ts';
import type { Runner } from './runner.ts';

export function nextRunForTrigger(trigger: RoutineTrigger, from = Date.now()): number {
  // A webhook fires when something outside calls in, so it has no next time. Pushing it far out keeps
  // it out of `nextRun`'s minimum without needing a second code path for "never".
  if (trigger.kind === 'webhook') return Number.MAX_SAFE_INTEGER;
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

/**
 * "There is no next time", for a routine every one of whose triggers waits to be called.
 *
 * It has to be a real number rather than undefined, because `nextRunAt` is what the tick compares
 * against and an absent one falls back to `createdAt` — which is in the past, so the routine fires
 * immediately. The old fallback was `now + 24h`, which is worse than either: a webhook-only routine
 * quietly became a daily one.
 */
export const NEVER = Number.MAX_SAFE_INTEGER;

/** Earliest of all the routine's triggers, or `NEVER` when none of them watches the clock. */
export function nextRun(routine: Pick<Routine, 'triggers'>, from = Date.now()): number {
  const times = (routine.triggers ?? []).map((t) => nextRunForTrigger(t, from)).filter((t) => t !== NEVER);
  return times.length ? Math.min(...times) : NEVER;
}

const DEFAULT_MAX_RUNS_PER_DAY = 24;

/**
 * The shortest interval a routine may fire on, wherever it was written.
 *
 * Ported from OpenBot's `MINIMUM_INTERVAL_MS`, and its reasoning is the whole point: a model can be
 * talked into anything a sentence can describe, including "check this every minute", and the floor is
 * what a sentence cannot talk its way past. Halo's daily cap already limits the damage, but it does it
 * by pausing the routine after the fact — the floor prevents the misconfiguration instead of punishing
 * it. It applies to the editor too, because one field that means two different things depending on who
 * filled it in is worse than one rule.
 */
export const MIN_INTERVAL_MINUTES = 15;

/**
 * How many routines may be switched on at once.
 *
 * OpenBot's cap, for OpenBot's reason: a conversation is an easy place to accumulate standing work
 * without noticing, and twenty is roughly where a person's own list stops being something they can
 * hold in their head. Switching one off frees a slot; deleting it is not required.
 */
export const MAX_ENABLED_ROUTINES = 20;

/** Applies the interval floor. Every path that builds a trigger goes through this one. */
export function clampTrigger(trigger: RoutineTrigger): RoutineTrigger {
  if (trigger.kind !== 'interval') return trigger;
  return { kind: 'interval', everyMinutes: Math.max(MIN_INTERVAL_MINUTES, Math.round(trigger.everyMinutes)) };
}

export function clampTriggers(triggers: RoutineTrigger[]): RoutineTrigger[] {
  return triggers.map(clampTrigger);
}

/**
 * Whether one more routine may be switched on, and what to say when it may not.
 *
 * `exceptId` is the routine being edited, so saving a change to one that is already on does not count
 * it twice against the cap.
 */
export function enabledSlot(routines: Routine[], exceptId?: string): { ok: true } | { ok: false; reason: string } {
  const on = routines.filter((r) => r.enabled && r.id !== exceptId).length;
  if (on < MAX_ENABLED_ROUTINES) return { ok: true };
  return {
    ok: false,
    reason: `${MAX_ENABLED_ROUTINES} routines are already switched on, which is the limit. Switch one off before adding another.`,
  };
}

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
      if (!r.enabled) continue;
      // The second half is a repair, not a schedule: a version of this file that had no "never"
      // wrote `now + 24h` onto webhook-only routines, and every one of those has been firing daily
      // ever since. Recomputing on start clears it without asking anybody to notice.
      const clockless = (r.triggers ?? []).every((t) => t.kind === 'webhook');
      if (!r.nextRunAt || (clockless && r.nextRunAt !== NEVER)) this.store.saveRoutine({ ...r, nextRunAt: nextRun(r) });
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
    /*
     * Exactly two messages about a failing routine, ever: the first failure after a success, and the
     * one that switches it off. OpenBot calls this the fatigue rule and it is right — a routine whose
     * token expired in March fails cleanly every single night, and a line per firing is how a person
     * learns to skim past the one line that mattered. Silence in between is the feature.
     */
    if (!ok && streak === 1) {
      this.runner.systemEvent(routine.agentId, {
        kind: 'routine',
        label: `"${routine.name}" failed`,
        ...(note ? { chip: note.slice(0, 80) } : {}),
      });
    }
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
