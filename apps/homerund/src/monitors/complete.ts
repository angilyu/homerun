import {
  CheckResult,
  MAX_RUN_ATTEMPT,
  MONITOR_PAUSE_AFTER_FAILED_FIRES,
  MONITOR_RETRY_BACKOFF_MS,
  type RunOutcome,
  type Surface,
  type TerminalRunState,
} from "@homerun/core";
import { log } from "../log";
import { appendEvent, runEvents } from "../store/events";
import { updateRun, type RunRow } from "../store/rows";
import {
  bumpCoverage,
  fireKey,
  getFire,
  getMonitorState,
  saveMonitorState,
  scheduleForTask,
  setScheduleEnabled,
  updateFire,
  type ScheduleRow,
} from "../store/schedule-rows";
import type { Store } from "../store/store";
import { localDay } from "../schedule/zone";

/**
 * The monitor half of finishing a run (§8.3, §5.3), called inside `finishRun`'s transaction:
 * - success saves the check's `new_state` in the same transaction that marks the run succeeded
 *   (step 5), so the state never advances for a run that did not finish;
 * - a failed scheduled fire is retried as a new attempt after 1 then 5 minutes, and three failed
 *   fires in a row pause the schedule;
 * - a no-change success leaves no trace in the thread (step 6); anything else is shown there.
 */

export function checkResultOf(row: Pick<RunRow, "check_result">): CheckResult | null {
  return row.check_result ? CheckResult.parse(JSON.parse(row.check_result)) : null;
}

export function monitorOutcome(row: RunRow, state: TerminalRunState): RunOutcome | null {
  if (!row.monitor_phase || state !== "succeeded") return null;
  const r = checkResultOf(row);
  return r?.changed ? "changed" : "no_change";
}

/** A quiet run: a monitor run that succeeded with nothing to report (§8.3 step 6). */
export function isQuiet(row: RunRow, state: TerminalRunState): boolean {
  return monitorOutcome(row, state) === "no_change";
}

/** `run.started`, once, before a monitor run's first visible event. */
export function ensureRunStarted(store: Store, row: RunRow, now: number): void {
  if (runEvents(store, row.run_id, "run.started").length) return;
  appendEvent(
    store,
    row.thread_id,
    row.run_id,
    "run.started",
    {
      trigger: row.trigger as "schedule",
      authority: row.authority as "full",
      origin: row.origin_device ? { device_id: row.origin_device, surface: (row.origin_surface ?? "desktop") as Surface } : null,
      task_id: row.task_id,
      task_version: row.task_version,
      scheduled_for: row.scheduled_for,
      attempt: row.attempt,
    },
    now,
  );
  if (row.started_at === null) updateRun(store, row.run_id, { started_at: now });
}

export function completeMonitorRun(store: Store, row: RunRow, state: TerminalRunState, now: number): void {
  if (!row.monitor_phase || !row.task_id) return;
  const schedule = scheduleForTask(store, row.task_id);
  const fire = schedule && row.scheduled_for !== null ? getFire(store, schedule.schedule_id, row.scheduled_for) : null;
  // A run whose fire row never recorded it (it lagged behind the run's insert) still owns it.
  const adopt = fire !== null && fire.run_id === null && fire.state === "queued" && row.dedupe_key === fireKey(fire);
  const ownsFire = fire !== null && (fire.run_id === row.run_id || adopt);
  if (adopt && fire.kind === "schedule" && fire.attempt === 0) bumpCoverage(store, schedule!.schedule_id, localDay(schedule!.timezone, fire.scheduled_for), { ran: 1 });

  if (state === "succeeded") {
    const result = checkResultOf(row);
    if (result) saveIfCurrent(store, row, result, now);
    dropTranscripts(store, row);
    if (schedule) {
      store.db
        .query(`UPDATE schedules SET missed_since_last_run = 0${ownsFire ? ", consecutive_failures = 0" : ""} WHERE schedule_id = ?`)
        .run(schedule.schedule_id);
    }
    if (ownsFire) updateFire(store, fire, { state: "done", run_id: row.run_id });
    return;
  }

  if (!ownsFire || !schedule) return;
  if (state === "cancelled") {
    updateFire(store, fire, { state: "cancelled", run_id: row.run_id });
    return;
  }
  // failed or abandoned: another attempt of the same fire, or give up on it (§5.3).
  if (row.attempt < MAX_RUN_ATTEMPT && schedule.enabled) {
    updateFire(store, fire, { state: "queued", attempt: row.attempt + 1, not_before: now + MONITOR_RETRY_BACKOFF_MS[row.attempt]! });
    return;
  }
  updateFire(store, fire, { state: "failed", run_id: row.run_id });
  const failures = schedule.consecutive_failures + 1;
  store.db.query("UPDATE schedules SET consecutive_failures = ? WHERE schedule_id = ?").run(failures, schedule.schedule_id);
  if (failures >= MONITOR_PAUSE_AFTER_FAILED_FIRES && schedule.enabled) {
    pauseSchedule(store, schedule, row.thread_id, "failures", `Paused after ${failures} failed runs in a row. Fix the problem, then resume the schedule.`, now);
  }
}

/** The runtime pauses a schedule and says so in the monitor's thread (§8.2). */
export function pauseSchedule(store: Store, s: ScheduleRow, threadId: string, reason: "failures" | "budget_cap", detail: string, now: number): void {
  setScheduleEnabled(store, s.schedule_id, reason, now);
  appendEvent(store, threadId, null, "schedule.paused", { schedule_id: s.schedule_id, reason, detail }, now);
  log.warn("schedule paused", { schedule_id: s.schedule_id, reason });
}

/**
 * Save the check's new state unless the state moved since the check read it: a hand edit or
 * reset made meanwhile wins (§8.3), and this run's state is dropped.
 */
function saveIfCurrent(store: Store, row: RunRow, result: CheckResult, now: number): void {
  const cur = getMonitorState(store, row.task_id!);
  const readVersion = row.state_version ?? 0;
  if ((cur?.version ?? 0) !== readVersion) {
    log.info("monitor state edited during the run; keeping the edit", { run_id: row.run_id, read: readVersion, now: cur?.version ?? 0 });
    return;
  }
  if (cur && JSON.stringify(cur.state) === JSON.stringify(result.new_state)) return;
  saveMonitorState(store, row.task_id!, result.new_state, row.run_id, now);
}

/** Each monitor run is a fresh session (§8.3); its transcripts are not needed once it succeeds (§6.1). */
function dropTranscripts(store: Store, row: RunRow): void {
  for (const sid of [row.check_session_id, row.sdk_session_id]) {
    if (!sid) continue;
    store.db.query("DELETE FROM sdk_transcripts WHERE session_id = ?").run(sid);
    store.db.query("DELETE FROM sdk_session_summaries WHERE session_id = ?").run(sid);
  }
}
