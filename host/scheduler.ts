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
    for (const routine of this.store.listRoutines()) {
      if (!routine.enabled) continue;
      const due = routine.nextRunAt ?? nextRun(routine, routine.createdAt);
      if (due > now) continue;
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
      this.runner.submitSystemTurn(routine.agentId, routine.prompt, `Routine "${routine.name}"`, 'routine', (ok, note) =>
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
    this.store.saveRoutine({ ...routine, runs });
    this.emit({ type: 'routines', routines: this.store.listRoutines() });
  }
}
