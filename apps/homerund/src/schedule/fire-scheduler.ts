import { MonitorSpec, type ScheduleSpec } from "@homerun/core";
import { log } from "../log";
import { appendEvent } from "../store/events";
import { activeRunRow, getTask, tryInsertRun } from "../store/rows";
import {
  addDowntime,
  allSchedules,
  beginLife,
  bumpCoverage,
  compiledOf,
  downtimeBetween,
  fireKey,
  getSchedule,
  insertFire,
  queuedFires,
  touchLife,
  updateFire,
  type DowntimeCause,
  type DowntimeRow,
  type FireRow,
  type ScheduleRow,
} from "../store/schedule-rows";
import type { Store } from "../store/store";
import { pauseSchedule } from "../monitors/complete";
import type { Clock } from "./clock";
import { nextFire } from "./cron-next";
import { dayStartInstant, localDay } from "./zone";

/** The safety-net ticker (§8): evaluates every schedule and notices sleep. */
export const TICK_MS = 15_000;
/** A wall-clock gap this long between ticks means the computer was asleep (§8.4). */
export const GAP_MS = 3 * TICK_MS;
/** How often a runtime life's `last_seen_at` is written, so a crash still bounds the downtime. */
export const HEARTBEAT_MS = 60_000;
/** Slots older than this are not looked at after a very long absence. */
const MAX_LOOKBACK_MS = 400 * 86_400_000;

export interface FireHooks {
  /** New work may be ready: wake the run pool. */
  kick(): void;
  /** Ran after each tick and wake (the daily digest). */
  onTick?(now: number): void;
  /** Another instant to wake at (the next digest). */
  nextWake?(): number | null;
}

interface Slot {
  at: number;
  day: string;
  cause: DowntimeCause | null;
}

/**
 * Fires monitors on their schedules (§8). Every step is one transaction, so a crash at any point
 * neither loses nor repeats a fire:
 * 1. evaluate: each slot in `(last_evaluated_at, now]` is classified as on time or missed (and
 *    why), coverage and `schedule.missed` are written, the catch-up policy picks the missed slots
 *    to run late, and the fires are queued, all with `last_evaluated_at` advanced;
 * 2. promote: when the monitor's thread has no active run, its oldest ready fire becomes a
 *    pending run whose dedupe key names the slot and attempt.
 *
 * One timer is armed for the earliest due instant, so fires are on time; the ticker is the safety
 * net and, by noticing wall-clock gaps, the sleep detector when the shell sends no power events.
 */
export class FireScheduler {
  private lifeStart = 0;
  private lastSeen = 0;
  private lastHeartbeat = 0;
  private sleepingSince: number | null = null;
  private cancelTimer: (() => void) | null = null;
  private cancelTick: (() => void) | null = null;
  private stopped = false;

  constructor(
    private store: Store,
    private clock: Clock,
    private hooks: FireHooks,
    private deviceZone: () => string,
  ) {}

  /** Start a runtime life: the time since the last one is "Homerun was not running" (§8.4). */
  start(): void {
    const now = this.clock.now();
    const prev = beginLife(this.store, now);
    this.lifeStart = now;
    this.lastSeen = now;
    this.lastHeartbeat = now;
    if (prev !== null && now > prev) addDowntime(this.store, { start_at: prev, end_at: now, cause: "not_running", source: "restart" });
    this.run(now);
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTick?.();
    try {
      touchLife(this.store, this.lifeStart, this.clock.now(), true);
    } catch (e) {
      log.warn("could not record runtime stop", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Tests simulating a crash: stop timers, record nothing. */
  halt(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTick?.();
  }

  // ------------------------------------------------------------------ power events (§8.1)

  willSleep(at: number): void {
    this.sleepingSince = at;
  }

  didWake(at: number, sleptAt: number | null): void {
    const start = sleptAt ?? this.sleepingSince ?? this.lastSeen;
    this.sleepingSince = null;
    const now = this.clock.now();
    addDowntime(this.store, { start_at: start, end_at: Math.min(at, now), cause: "asleep", source: "os" });
    // The OS told us; the gap detector must not record the same sleep again.
    this.lastSeen = now;
    this.run(now);
  }

  // ------------------------------------------------------------------ the loop

  private scheduleTick(): void {
    if (this.stopped) return;
    this.cancelTick = this.clock.setTimer(TICK_MS, () => {
      this.cancelTick = null;
      this.run(this.clock.now());
      this.scheduleTick();
    });
  }

  /** Evaluate every schedule, promote ready fires, re-arm. Also after wake, enable and edits. */
  run(now = this.clock.now()): void {
    if (this.stopped) return;
    try {
      this.observe(now);
      for (const s of allSchedules(this.store)) if (s.enabled) this.evaluate(s.schedule_id, now);
      this.promoteAll(now);
      this.hooks.onTick?.(now);
    } catch (e) {
      log.error("scheduler pass failed", { error: e instanceof Error ? e.message : String(e) });
    }
    this.arm();
  }

  /** Gap detection and the life heartbeat. */
  private observe(now: number): void {
    if (now - this.lastSeen > GAP_MS) addDowntime(this.store, { start_at: this.lastSeen, end_at: now, cause: "asleep", source: "gap" });
    this.lastSeen = now; // also when the clock was set back: measure from here
    if (Math.abs(now - this.lastHeartbeat) >= HEARTBEAT_MS) {
      this.lastHeartbeat = now;
      touchLife(this.store, this.lifeStart, now);
    }
  }

  private arm(): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const now = this.clock.now();
    let due = Infinity;
    for (const s of allSchedules(this.store)) if (s.enabled && s.next_fire_at !== null) due = Math.min(due, s.next_fire_at);
    for (const f of queuedFires(this.store)) if (f.not_before !== null && f.not_before > now) due = Math.min(due, f.not_before);
    const extra = this.hooks.nextWake?.();
    if (extra != null) due = Math.min(due, extra);
    if (!Number.isFinite(due)) return;
    // Never more than a tick ahead: a timer set before a sleep is late by the sleep (§8.1).
    const delay = Math.max(0, Math.min(due - now, TICK_MS));
    if (delay >= TICK_MS) return;
    this.cancelTimer = this.clock.setTimer(delay, () => {
      this.cancelTimer = null;
      this.run(this.clock.now());
    });
  }

  // ------------------------------------------------------------------ evaluate

  /** Classify and queue the slots of one schedule up to `now`. One transaction. */
  evaluate(scheduleId: string, now: number): void {
    this.store.tx(() => {
      const s = getSchedule(this.store, scheduleId);
      if (!s || !s.enabled) return;
      // A clock that moved backwards evaluates nothing: slots up to last_evaluated_at are done.
      if (now <= s.last_evaluated_at) return;
      const threadId = monitorThread(this.store, s.task_id);
      const compiled = compiledOf(s);
      const from = Math.max(s.last_evaluated_at, now - MAX_LOOKBACK_MS);
      const downs = downtimeBetween(this.store, from, now);

      const slots: Slot[] = [];
      for (let t = nextFire(compiled, from); t <= now; t = nextFire(compiled, t)) {
        const d = downs.find((x) => x.start_at <= t && t < x.end_at);
        slots.push({ at: t, day: localDay(s.timezone, t), cause: d ? pickCause(downs, t) : null });
      }

      const perDay = new Map<string, { expected: number; missed_asleep: number; missed_not_running: number; merged: number }>();
      const day = (d: string) => {
        let v = perDay.get(d);
        if (!v) perDay.set(d, (v = { expected: 0, missed_asleep: 0, missed_not_running: 0, merged: 0 }));
        return v;
      };
      for (const sl of slots) {
        const v = day(sl.day);
        v.expected++;
        if (sl.cause === "asleep") v.missed_asleep++;
        else if (sl.cause === "not_running") v.missed_not_running++;
      }

      // Catch-up (§8.1) over every missed slot: run_once runs the latest, run_all the last
      // max_catchup, skip none. Late runs are not counted as ran (§8.4).
      const missed = slots.filter((x) => x.cause !== null);
      const spec = JSON.parse(s.spec) as ScheduleSpec;
      const late = spec.catchup === "run_once" ? missed.slice(-1) : spec.catchup === "run_all" ? missed.slice(-spec.max_catchup) : [];
      const lateSet = new Set(late.map((x) => x.at));
      for (const x of late) insertFire(this.store, s.schedule_id, x.at, "catchup", "queued", now);

      // On-time fires. One already waiting absorbs the new one (§5.3: run_once semantics).
      let merged = 0;
      let waiting = queuedFires(this.store, s.schedule_id).some((f) => f.kind === "schedule");
      const mergedSlots: Slot[] = [];
      for (const sl of slots) {
        if (sl.cause !== null) continue;
        if (waiting) {
          if (insertFire(this.store, s.schedule_id, sl.at, "schedule", "merged", now)) {
            merged++;
            day(sl.day).merged++;
            mergedSlots.push(sl);
          }
        } else if (insertFire(this.store, s.schedule_id, sl.at, "schedule", "queued", now)) {
          waiting = true;
        }
      }

      for (const [d, v] of perDay) bumpCoverage(this.store, s.schedule_id, d, v);
      if (threadId) {
        for (const g of groups(slots)) {
          appendEvent(this.store, threadId, null, "schedule.missed", {
            schedule_id: s.schedule_id,
            scheduled_for: g[0]!.at,
            reason: g[0]!.cause!,
            count: g.length,
            ...(g.length > 1 ? { last_scheduled_for: g[g.length - 1]!.at } : {}),
            caught_up: g.filter((x) => lateSet.has(x.at)).length,
          }, now);
        }
        if (mergedSlots.length) {
          appendEvent(this.store, threadId, null, "schedule.missed", {
            schedule_id: s.schedule_id,
            scheduled_for: mergedSlots[0]!.at,
            reason: "skipped_by_policy",
            count: mergedSlots.length,
            ...(mergedSlots.length > 1 ? { last_scheduled_for: mergedSlots[mergedSlots.length - 1]!.at } : {}),
            caught_up: 0,
          }, now);
        }
      }
      this.store.db
        .query("UPDATE schedules SET last_evaluated_at = ?, next_fire_at = ?, missed_since_last_run = missed_since_last_run + ? WHERE schedule_id = ?")
        .run(now, nextFire(compiled, now), missed.length + merged, s.schedule_id);
    });
  }

  // ------------------------------------------------------------------ promote

  promoteAll(now = this.clock.now()): void {
    const ids = new Set(queuedFires(this.store).map((f) => f.schedule_id));
    let started = false;
    for (const id of ids) started = this.promote(id, now) || started;
    if (started) this.hooks.kick();
  }

  /** Start the schedule's oldest ready fire if its monitor is idle. One transaction. */
  promote(scheduleId: string, now: number): boolean {
    return this.store.tx(() => {
      const s = getSchedule(this.store, scheduleId);
      if (!s) return false;
      const task = getTask(this.store, s.task_id);
      const threadId = monitorThread(this.store, s.task_id);
      if (!task || !threadId || task.kind !== "monitor") return false;
      if (activeRunRow(this.store, threadId)) return false;
      const fire = queuedFires(this.store, scheduleId).find((f) => f.not_before === null || f.not_before <= now);
      if (!fire) return false;
      if (!s.enabled) return false;

      const spec = MonitorSpec.parse(task.spec);
      const cap = spec.budget.monthly_cap_usd;
      if (cap !== undefined && monthCost(this.store, task.task_id, s.timezone, now) >= cap) {
        pauseSchedule(this.store, s, threadId, "budget_cap", `Paused: this month's spend reached the $${cap} cap. Raise the cap or resume next month.`, now);
        return false;
      }

      const key = fireKey(fire);
      const existing = this.store.db.query<{ run_id: string }, [string]>("SELECT run_id FROM runs WHERE dedupe_key = ?").get(key);
      if (existing) {
        // Already started by an earlier pass; only the fire's own row lagged behind.
        updateFire(this.store, fire, { state: "started", run_id: existing.run_id });
        if (fire.kind === "schedule" && fire.attempt === 0) bumpCoverage(this.store, s.schedule_id, localDay(s.timezone, fire.scheduled_for), { ran: 1 });
        return false;
      }
      const run = tryInsertRun(this.store, {
        threadId,
        taskId: task.task_id,
        taskVersion: task.version,
        deviceId: task.device_id,
        trigger: fire.kind,
        originDevice: null,
        originSurface: null,
        authority: "full",
        pool: "monitor",
        now,
        scheduledFor: fire.scheduled_for,
        dedupeKey: key,
        attempt: fire.attempt,
        monitorPhase: spec.check.kind === "rule" ? "rule_check" : "model_check",
      });
      if (!run) return false;
      updateFire(this.store, fire, { state: "started", run_id: run.run_id });
      if (fire.kind === "schedule" && fire.attempt === 0) bumpCoverage(this.store, s.schedule_id, localDay(s.timezone, fire.scheduled_for), { ran: 1 });
      this.store.db.query("UPDATE schedules SET last_fired_at = ? WHERE schedule_id = ?").run(now, s.schedule_id);
      return true;
    });
  }
}

export { fireKey };

export function monitorThread(store: Store, taskId: string): string | null {
  return store.db.query<{ thread_id: string }, [string]>("SELECT thread_id FROM threads WHERE task_id = ? ORDER BY updated_at LIMIT 1").get(taskId)?.thread_id ?? null;
}

/** The task's spend this calendar month in `timezone` (§7.4 `monthly_cap_usd`). */
export function monthCost(store: Store, taskId: string, timezone: string, now: number): number {
  const start = dayStartInstant(timezone, `${localDay(timezone, now).slice(0, 7)}-01`);
  return (
    store.db
      .query<{ c: number | null }, [string, number]>("SELECT SUM(cost_usd) AS c FROM runs WHERE task_id = ? AND created_at >= ?")
      .get(taskId, start)?.c ?? 0
  );
}

/** "Homerun was not running" wins over "asleep" when both cover a slot: it is the stronger claim. */
function pickCause(downs: DowntimeRow[], t: number): DowntimeCause {
  return downs.some((d) => d.cause === "not_running" && d.start_at <= t && t < d.end_at) ? "not_running" : "asleep";
}

/** Runs of contiguous missed slots with the same cause, for one `schedule.missed` each. */
function groups(slots: Slot[]): Slot[][] {
  const out: Slot[][] = [];
  let cur: Slot[] | null = null;
  for (const sl of slots) {
    if (sl.cause === null) cur = null;
    else if (cur && cur[0]!.cause === sl.cause) cur.push(sl);
    else out.push((cur = [sl]));
  }
  return out;
}
