import { randomUUID } from "node:crypto";
import {
  MonitorState,
  ScheduleCoverage,
  ScheduleSpec,
  ScheduleState,
  scheduleCronColumn,
  type JsonValue,
  type SchedulePausedReason,
} from "@homerun/core";
import { compileSchedule, nextFire, type CompiledSchedule } from "../schedule/cron-next";
import type { Store } from "./store";

// ---------------------------------------------------------------- schedules (§6, §8)

export interface ScheduleRow {
  schedule_id: string;
  task_id: string;
  cron: string;
  timezone: string;
  catchup: string;
  max_catchup: number;
  next_fire_at: number | null;
  last_fired_at: number | null;
  enabled: number;
  spec: string;
  anchor_at: number;
  last_evaluated_at: number;
  paused_reason: SchedulePausedReason | null;
  consecutive_failures: number;
  missed_since_last_run: number;
  created_at: number;
}

export function scheduleSpecOf(r: ScheduleRow): ScheduleSpec {
  return ScheduleSpec.parse(JSON.parse(r.spec));
}

export function compiledOf(r: ScheduleRow): CompiledSchedule {
  return compileSchedule(scheduleSpecOf(r), r.anchor_at);
}

export function rowToScheduleState(r: ScheduleRow): ScheduleState {
  return ScheduleState.parse({
    schedule_id: r.schedule_id,
    task_id: r.task_id,
    schedule: JSON.parse(r.spec),
    enabled: r.enabled === 1,
    paused_reason: r.paused_reason,
    next_fire_at: r.enabled === 1 ? r.next_fire_at : null,
    last_fired_at: r.last_fired_at,
    consecutive_failures: r.consecutive_failures,
    missed_since_last_run: r.missed_since_last_run,
  });
}

export function getSchedule(store: Store, scheduleId: string): ScheduleRow | null {
  return store.db.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE schedule_id = ?").get(scheduleId) ?? null;
}

export function scheduleForTask(store: Store, taskId: string): ScheduleRow | null {
  return store.db.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE task_id = ?").get(taskId) ?? null;
}

export function allSchedules(store: Store): ScheduleRow[] {
  return store.db.query<ScheduleRow, []>("SELECT * FROM schedules ORDER BY created_at, schedule_id").all();
}

/**
 * Make the task's schedule match its spec (task create and update). A new or changed schedule is
 * evaluated from `now`: an edit never produces misses for the past (§16.2 "timezone changes").
 * An interval stores the device's zone at the time, for its coverage days only (§8.4).
 */
export function syncSchedule(store: Store, taskId: string, spec: ScheduleSpec, deviceZone: string, now: number): ScheduleRow {
  return store.tx(() => {
    const json = JSON.stringify(spec);
    const tz = spec.kind === "cron" ? spec.timezone : deviceZone;
    const cur = scheduleForTask(store, taskId);
    if (cur && cur.spec === json) return cur;
    const next = nextFire(compileSchedule(spec, now), now);
    if (!cur) {
      const id = randomUUID();
      store.db
        .query(
          `INSERT INTO schedules (schedule_id, task_id, cron, timezone, catchup, max_catchup, next_fire_at, last_fired_at, enabled, spec,
             anchor_at, last_evaluated_at, paused_reason, consecutive_failures, missed_since_last_run, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL, 0, 0, ?)`,
        )
        .run(id, taskId, scheduleCronColumn(spec), tz, spec.catchup, spec.max_catchup, next, json, now, now, now);
      return getSchedule(store, id)!;
    }
    store.db
      .query(
        `UPDATE schedules SET cron = ?, timezone = ?, catchup = ?, max_catchup = ?, spec = ?, anchor_at = ?, last_evaluated_at = ?,
           next_fire_at = ? WHERE schedule_id = ?`,
      )
      .run(scheduleCronColumn(spec), tz, spec.catchup, spec.max_catchup, json, now, now, cur.enabled ? next : null, cur.schedule_id);
    return getSchedule(store, cur.schedule_id)!;
  });
}

/**
 * Pause (`reason` set) or resume a schedule. Queued fires are cancelled on pause. Resuming
 * evaluates from `now` and clears the failure count, so a paused stretch is not a list of misses.
 */
export function setScheduleEnabled(store: Store, scheduleId: string, reason: SchedulePausedReason | null, now: number): ScheduleRow {
  return store.tx(() => {
    const cur = getSchedule(store, scheduleId);
    if (!cur) throw new Error(`no schedule ${scheduleId}`);
    if (reason) {
      if (!cur.enabled && cur.paused_reason === reason) return cur;
      store.db.query("UPDATE schedules SET enabled = 0, paused_reason = ?, next_fire_at = NULL WHERE schedule_id = ?").run(reason, scheduleId);
      store.db
        .query("UPDATE schedule_fires SET state = 'cancelled' WHERE schedule_id = ? AND state = 'queued'")
        .run(scheduleId);
      return getSchedule(store, scheduleId)!;
    }
    if (cur.enabled) return cur;
    const next = nextFire(compiledOf(cur), now);
    store.db
      .query(
        "UPDATE schedules SET enabled = 1, paused_reason = NULL, last_evaluated_at = ?, next_fire_at = ?, consecutive_failures = 0 WHERE schedule_id = ?",
      )
      .run(now, next, scheduleId);
    return getSchedule(store, scheduleId)!;
  });
}

// ---------------------------------------------------------------- fires (internal)

export type FireKind = "schedule" | "catchup";
export type FireState = "queued" | "started" | "done" | "failed" | "merged" | "cancelled";

export interface FireRow {
  schedule_id: string;
  scheduled_for: number;
  kind: FireKind;
  state: FireState;
  attempt: number;
  run_id: string | null;
  not_before: number | null;
  created_at: number;
}

/** Claim a slot. False if it was already claimed: a slot is claimable exactly once. */
/** The run's dedupe key: one run per slot and attempt, whoever tries to start it (§6). */
export function fireKey(f: Pick<FireRow, "schedule_id" | "scheduled_for" | "attempt">): string {
  return `fire:${f.schedule_id}:${f.scheduled_for}:${f.attempt}`;
}

export function insertFire(store: Store, scheduleId: string, scheduledFor: number, kind: FireKind, state: "queued" | "merged", now: number): boolean {
  return (
    store.db
      .query("INSERT OR IGNORE INTO schedule_fires (schedule_id, scheduled_for, kind, state, attempt, created_at) VALUES (?, ?, ?, ?, 0, ?)")
      .run(scheduleId, scheduledFor, kind, state, now).changes === 1
  );
}

export function getFire(store: Store, scheduleId: string, scheduledFor: number): FireRow | null {
  return (
    store.db.query<FireRow, [string, number]>("SELECT * FROM schedule_fires WHERE schedule_id = ? AND scheduled_for = ?").get(scheduleId, scheduledFor) ??
    null
  );
}

export function queuedFires(store: Store, scheduleId?: string): FireRow[] {
  return scheduleId
    ? store.db
        .query<FireRow, [string]>("SELECT * FROM schedule_fires WHERE state = 'queued' AND schedule_id = ? ORDER BY scheduled_for")
        .all(scheduleId)
    : store.db.query<FireRow, []>("SELECT * FROM schedule_fires WHERE state = 'queued' ORDER BY schedule_id, scheduled_for").all();
}

export function updateFire(store: Store, f: Pick<FireRow, "schedule_id" | "scheduled_for">, fields: Partial<Omit<FireRow, "schedule_id" | "scheduled_for">>): void {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (!keys.length) return;
  store.db
    .query(`UPDATE schedule_fires SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE schedule_id = ? AND scheduled_for = ?`)
    .run(...keys.map((k) => fields[k] as string | number | null), f.schedule_id, f.scheduled_for);
}

// ---------------------------------------------------------------- coverage (§8.4)

export type CoverageField = "expected" | "ran" | "missed_asleep" | "missed_not_running" | "merged";

export function bumpCoverage(store: Store, scheduleId: string, day: string, deltas: Partial<Record<CoverageField, number>>): void {
  const d = { expected: 0, ran: 0, missed_asleep: 0, missed_not_running: 0, merged: 0, ...deltas };
  store.db
    .query(
      `INSERT INTO schedule_coverage (schedule_id, day, expected, ran, missed_asleep, missed_not_running, merged) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (schedule_id, day) DO UPDATE SET expected = expected + excluded.expected, ran = ran + excluded.ran,
         missed_asleep = missed_asleep + excluded.missed_asleep, missed_not_running = missed_not_running + excluded.missed_not_running,
         merged = merged + excluded.merged`,
    )
    .run(scheduleId, day, d.expected, d.ran, d.missed_asleep, d.missed_not_running, d.merged);
}

export function coverageDays(store: Store, scheduleId: string, fromDay: string, toDay: string): ScheduleCoverage[] {
  return store.db
    .query<ScheduleCoverage, [string, string, string]>(
      "SELECT schedule_id, day, expected, ran, missed_asleep, missed_not_running, merged FROM schedule_coverage WHERE schedule_id = ? AND day >= ? AND day <= ? ORDER BY day",
    )
    .all(scheduleId, fromDay, toDay)
    .map((r) => ScheduleCoverage.parse(r));
}

// ---------------------------------------------------------------- monitor state (§8.3)

interface MonitorStateRow {
  task_id: string;
  state: string;
  version: number;
  last_run_id: string;
  updated_at: number;
}

export function getMonitorState(store: Store, taskId: string): MonitorState | null {
  const r = store.db.query<MonitorStateRow, [string]>("SELECT * FROM monitor_state WHERE task_id = ?").get(taskId);
  return r ? MonitorState.parse({ ...r, state: JSON.parse(r.state) }) : null;
}

/** A successful run's new state (§8.3 step 5). The caller is inside the run's finishing transaction. */
export function saveMonitorState(store: Store, taskId: string, state: JsonValue, runId: string, now: number): void {
  store.db
    .query(
      `INSERT INTO monitor_state (task_id, state, version, last_run_id, updated_at) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET state = excluded.state, version = version + 1, last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at`,
    )
    .run(taskId, JSON.stringify(state), runId, now);
}

export class StateConflictError extends Error {
  constructor(readonly current: number | null) {
    super(current === null ? "The monitor has no saved state yet." : `The state is at version ${current}.`);
    this.name = "StateConflictError";
  }
}

/** A hand edit (monitors.state.set / reset). Keeps `last_run_id`: no run produced it. */
export function editMonitorState(store: Store, taskId: string, state: JsonValue, expectedVersion: number, now: number): MonitorState {
  return store.tx(() => {
    const cur = getMonitorState(store, taskId);
    if (!cur || cur.version !== expectedVersion) throw new StateConflictError(cur?.version ?? null);
    store.db
      .query("UPDATE monitor_state SET state = ?, version = version + 1, updated_at = ? WHERE task_id = ?")
      .run(JSON.stringify(state), now, taskId);
    return getMonitorState(store, taskId)!;
  });
}

// ---------------------------------------------------------------- downtime and runtime lives (§8.4)

export type DowntimeCause = "asleep" | "not_running";

export interface DowntimeRow {
  start_at: number;
  end_at: number;
  cause: DowntimeCause;
  source: "os" | "gap" | "restart";
}

export function addDowntime(store: Store, d: DowntimeRow): void {
  if (d.end_at <= d.start_at) return;
  store.tx(() =>
    store.db
      .query(
        `INSERT INTO downtime (start_at, end_at, cause, source) VALUES (?, ?, ?, ?)
         ON CONFLICT (start_at, cause) DO UPDATE SET end_at = max(end_at, excluded.end_at)`,
      )
      .run(d.start_at, d.end_at, d.cause, d.source),
  );
}

/** Intervals that overlap `(from, to]`, oldest first. */
export function downtimeBetween(store: Store, from: number, to: number): DowntimeRow[] {
  return store.db
    .query<DowntimeRow, [number, number]>("SELECT * FROM downtime WHERE end_at > ? AND start_at <= ? ORDER BY start_at")
    .all(from, to);
}

/**
 * Start a runtime life. Returns when the previous one was last seen (or stopped), so the gap can
 * be recorded as "Homerun was not running".
 */
export function beginLife(store: Store, now: number): number | null {
  return store.tx(() => {
    const prev = store.db
      .query<{ last_seen_at: number; stopped_at: number | null }, []>("SELECT last_seen_at, stopped_at FROM runtime_lives ORDER BY started_at DESC LIMIT 1")
      .get();
    store.db.query("INSERT OR REPLACE INTO runtime_lives (started_at, last_seen_at, stopped_at) VALUES (?, ?, NULL)").run(now, now);
    return prev ? (prev.stopped_at ?? prev.last_seen_at) : null;
  });
}

export function touchLife(store: Store, startedAt: number, now: number, stopped = false): void {
  store.tx(() =>
    store.db
      .query(`UPDATE runtime_lives SET last_seen_at = max(last_seen_at, ?)${stopped ? ", stopped_at = ?" : ""} WHERE started_at = ?`)
      .run(...(stopped ? [now, now, startedAt] : [now, startedAt])),
  );
}

// ---------------------------------------------------------------- settings (internal)

export function getSetting<T>(store: Store, key: string): T | null {
  const r = store.db.query<{ value: string }, [string]>("SELECT value FROM app_settings WHERE key = ?").get(key);
  return r ? (JSON.parse(r.value) as T) : null;
}

export function putSetting(store: Store, key: string, value: unknown): void {
  store.tx(() =>
    store.db.query("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value)),
  );
}
