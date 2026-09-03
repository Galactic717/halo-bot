package com.halo.bot.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.Calendar

fun nextRunForTrigger(trigger: RoutineTrigger, from: Long = System.currentTimeMillis()): Long {
    // A webhook fires when something outside calls in, so it has no next time. Pushing it far out
    // keeps it out of `nextRun`'s minimum without needing a second code path for "never".
    if (trigger.kind == "webhook") return Long.MAX_VALUE
    if (trigger.kind == "interval") return from + trigger.everyMinutes * 60_000L

    val next = Calendar.getInstance().apply {
        timeInMillis = from
        set(Calendar.HOUR_OF_DAY, trigger.hour)
        set(Calendar.MINUTE, trigger.minute)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }

    when (trigger.kind) {
        "daily" -> {
            if (next.timeInMillis <= from) next.add(Calendar.DATE, 1)
        }

        "weekdays" -> {
            if (next.timeInMillis <= from) next.add(Calendar.DATE, 1)
            while (next.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY || next.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY) {
                next.add(Calendar.DATE, 1)
            }
        }

        else -> {
            // Calendar's DAY_OF_WEEK is 1-based from Sunday; the stored weekday is 0-based from Sunday.
            val current = next.get(Calendar.DAY_OF_WEEK) - 1
            val delta = ((trigger.weekday - current) + 7) % 7
            next.add(Calendar.DATE, delta)
            if (next.timeInMillis <= from) next.add(Calendar.DATE, 7)
        }
    }
    return next.timeInMillis
}

/**
 * "There is no next time", for a routine every one of whose triggers waits to be called.
 *
 * It has to be a real number rather than null, because `nextRunAt` is what the tick compares against
 * and an absent one falls back to `createdAt` — which is in the past, so the routine fires at once.
 * The old fallback was `now + 24h`, which is worse than either: a webhook-only routine quietly became
 * a daily one.
 */
const val NEVER: Long = Long.MAX_VALUE

/** Earliest of all the routine's triggers, or `NEVER` when none of them watches the clock. */
fun nextRun(routine: Routine, from: Long = System.currentTimeMillis()): Long {
    val times = routine.triggers.map { nextRunForTrigger(it, from) }.filter { it != NEVER }
    return times.minOrNull() ?: NEVER
}

private const val DEFAULT_MAX_RUNS_PER_DAY = 24

/**
 * The shortest interval a routine may fire on, wherever it was written.
 *
 * Ported from OpenBot's `MINIMUM_INTERVAL_MS`, and its reasoning is the whole point: a model can
 * be talked into anything a sentence can describe, including "check this every minute", and the
 * floor is what a sentence cannot talk its way past. The daily cap already limits the damage, but
 * it does it by pausing the routine after the fact — the floor prevents the misconfiguration
 * instead of punishing it. It applies to the editor too, because one field that means two
 * different things depending on who filled it in is worse than one rule.
 */
const val MIN_INTERVAL_MINUTES = 15

/**
 * How many routines may be switched on at once.
 *
 * OpenBot's cap, for OpenBot's reason: a conversation is an easy place to accumulate standing
 * work without noticing, and twenty is roughly where a person's own list stops being something
 * they can hold in their head. Switching one off frees a slot; deleting it is not required.
 */
const val MAX_ENABLED_ROUTINES = 20

/** Applies the interval floor. Every path that builds a trigger goes through this one. */
fun clampTrigger(trigger: RoutineTrigger): RoutineTrigger =
    if (trigger.kind != "interval") trigger
    else trigger.copy(everyMinutes = maxOf(MIN_INTERVAL_MINUTES, trigger.everyMinutes))

fun clampTriggers(triggers: List<RoutineTrigger>): List<RoutineTrigger> = triggers.map(::clampTrigger)

/**
 * Whether one more routine may be switched on, and what to say when it may not.
 *
 * `exceptId` is the routine being edited, so saving a change to one that is already on does not
 * count it twice against the cap.
 */
fun enabledSlotReason(routines: List<Routine>, exceptId: String? = null): String? {
    val on = routines.count { it.enabled && it.id != exceptId }
    if (on < MAX_ENABLED_ROUTINES) return null
    return "$MAX_ENABLED_ROUTINES routines are already switched on, which is the limit. " +
        "Switch one off before adding another."
}

/**
 * Consecutive failures before a routine is paused.
 *
 * A routine whose site moved or whose command no longer exists fails identically every time. Left
 * alone it burns tokens on a schedule and fills the history with the same line, and nobody reads a
 * history that is all the same line. Three is Hermes's default for the same reason.
 */
private const val FAILURE_STREAK_LIMIT = 3

/**
 * Whether the app is in a state where firing a routine can possibly work.
 *
 * Checked before any model machinery is built, so a routine that fires while the model server is down
 * is skipped and left due rather than burnt as a failure — the alternative spends the daily allowance
 * and the failure streak on an outage that has nothing to do with the routine.
 */
fun preflight(settings: Settings, providerHealthy: Boolean?): String? {
    if (settings.provider.model.isBlank()) return "no model is configured"
    if (providerHealthy == false) return "the model server at ${settings.provider.baseUrl} is not answering"
    return null
}

/** True when a routine has already fired its daily allowance. */
fun isOverDailyCap(runs: List<RoutineRun>, cap: Int, now: Long): Boolean =
    runs.count { it.at >= now - 86_400_000L } >= cap

/**
 * The clock.
 *
 * On the desktop this was a 20-second interval in a process that never sleeps. A phone is not that,
 * so the ticker runs inside the foreground service when the user has it on, and WorkManager wakes the
 * app on a coarser cadence when they do not. Both call `tick`, which is idempotent: a routine whose
 * `nextRunAt` has passed fires once, whoever noticed first.
 */
class Scheduler(
    private val store: Store,
    private val runner: Runner,
    private val emit: (HaloEvent) -> Unit,
    private val scope: CoroutineScope,
) {
    private var job: Job? = null

    /** Set from the provider health check, so a tick can tell an outage from a bad routine. */
    @Volatile var providerHealthy: Boolean? = null

    private val warnedBlocked = HashSet<String>()

    fun start() {
        for (r in store.listRoutines()) {
            if (!r.enabled) continue
            // The second half is a repair, not a schedule: a version of this file that had no
            // "never" wrote `now + 24h` onto webhook-only routines, and every one of those has been
            // firing daily ever since. Recomputing on start clears it without asking anybody to notice.
            val clockless = r.triggers.all { it.kind == "webhook" }
            if (r.nextRunAt == null || (clockless && r.nextRunAt != NEVER)) {
                store.saveRoutine(r.copy(nextRunAt = nextRun(r)))
            }
        }
        job?.cancel()
        job = scope.launch {
            while (isActive) {
                tick()
                delay(20_000)
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun tick() {
        val now = System.currentTimeMillis()
        var changed = false
        // Nothing can run right now: leave every routine due and say so once, rather than spending the
        // daily allowance and the failure streak on an outage none of them caused.
        val blocked = preflight(store.getSettings(), providerHealthy)
        for (routine in store.listRoutines()) {
            if (!routine.enabled) continue
            val due = routine.nextRunAt ?: nextRun(routine, routine.createdAt)
            if (due > now) continue
            if (blocked != null) {
                if (warnedBlocked.add(routine.id)) {
                    runner.systemEvent(
                        routine.agentId,
                        SystemEvent("routine", "\"${routine.name}\" is waiting — $blocked"),
                    )
                }
                continue
            }
            warnedBlocked.remove(routine.id)
            if (store.getAgent(routine.agentId) == null) {
                store.deleteRoutine(routine.id)
                changed = true
                continue
            }
            val cap = routine.maxRunsPerDay ?: DEFAULT_MAX_RUNS_PER_DAY
            if (isOverDailyCap(routine.runs, cap, now)) {
                // Pause rather than hammer: the user gets one line, not a flood of turns.
                store.saveRoutine(routine.copy(enabled = false, nextRunAt = nextRun(routine, now)))
                runner.systemEvent(
                    routine.agentId,
                    SystemEvent("routine", "Paused \"${routine.name}\" — it hit its limit of $cap runs in a day"),
                )
                changed = true
                continue
            }

            // The run is recorded now so the daily cap counts queued turns too, then corrected on finish.
            store.saveRoutine(
                routine.copy(
                    lastRunAt = now,
                    nextRunAt = nextRun(routine, now),
                    runs = (routine.runs + RoutineRun(now, "ok", "running")).takeLast(20),
                ),
            )
            // A routine that reports the same thing every hour is noise; with continuity on it can see
            // what it last said and stay quiet when nothing has moved.
            val prompt = if (routine.continuity && !routine.lastOutput.isNullOrBlank()) {
                routine.prompt + "\n\n[What you reported last time]\n" + routine.lastOutput +
                    "\n\nIf nothing has changed since then, end the turn silently instead of repeating yourself."
            } else {
                routine.prompt
            }
            runner.submitSystemTurn(routine.agentId, prompt, "Routine \"${routine.name}\"", "routine") { ok, note ->
                finishRun(routine.id, now, ok, note)
            }
            changed = true
        }
        if (changed) emit(HaloEvent.RoutinesChanged(store.listRoutines()))
    }

    /** Replaces the provisional entry with what actually happened, so the history is not a guess. */
    private fun finishRun(routineId: String, at: Long, ok: Boolean, note: String?) {
        val routine = store.getRoutine(routineId) ?: return
        val runs = routine.runs.map { run ->
            if (run.at == at) RoutineRun(at, if (ok) "ok" else "error", note) else run
        }
        val streak = if (ok) 0 else routine.failureStreak + 1
        val exhausted = streak >= FAILURE_STREAK_LIMIT
        /*
         * Exactly two messages about a failing routine, ever: the first failure after a success,
         * and the one that switches it off. OpenBot calls this the fatigue rule and it is right —
         * a routine whose token expired in March fails cleanly every single night, and a line per
         * firing is how a person learns to skim past the one line that mattered. Silence in
         * between is the feature.
         */
        if (!ok && streak == 1) {
            runner.systemEvent(
                routine.agentId,
                SystemEvent("routine", "\"${routine.name}\" failed", note?.take(80)),
            )
        }
        if (exhausted) {
            runner.systemEvent(
                routine.agentId,
                SystemEvent(
                    "routine",
                    "Paused \"${routine.name}\" — it failed $streak times in a row",
                    note?.take(80),
                ),
            )
        }
        store.saveRoutine(
            routine.copy(
                runs = runs,
                failureStreak = streak,
                enabled = if (exhausted) false else routine.enabled,
                lastOutput = if (ok && routine.continuity && note != null) note.take(2000) else routine.lastOutput,
            ),
        )
        emit(HaloEvent.RoutinesChanged(store.listRoutines()))
    }
}
