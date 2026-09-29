import { HealthDigest, HealthSettings, parseCron, type Downtime, type MonitorHealth } from "@homerun/core";
import { log } from "../log";
import { nextFire, type CompiledSchedule } from "../schedule/cron-next";
import { listTasks } from "../store/rows";
import { downtimeBetween, getSetting, putSetting, rowToScheduleState, scheduleForTask } from "../store/schedule-rows";
import type { Store } from "../store/store";

const SETTINGS_KEY = "health_settings";
const LAST_KEY = "health_digest_last_to";
const DAY = 86_400_000;

/**
 * The health digest (§8.3): what every monitor did over a period, so that silence can be told
 * apart from death. Runs are counted by when they ended; fires by the slot they were due.
 */
export function computeDigest(store: Store, from: number, to: number, timezone: string, generatedAt: number): HealthDigest {
  const monitors: MonitorHealth[] = [];
  let total = 0;
  for (const task of listTasks(store, "monitor")) {
    const s = scheduleForTask(store, task.task_id);
    const state = s ? rowToScheduleState(s) : null;
    const runs = store.db
      .query<{ n: number; ok: number; changes: number; failed: number; cost: number | null }, [string, number, number]>(
        `SELECT count(*) AS n,
                sum(state = 'succeeded') AS ok,
                sum(outcome = 'changed') AS changes,
                sum(state IN ('failed','abandoned')) AS failed,
                sum(cost_usd) AS cost
           FROM runs WHERE task_id = ? AND ended_at >= ? AND ended_at < ?`,
      )
      .get(task.task_id, from, to)!;
    const last = store.db
      .query<{ t: number | null }, [string, number]>("SELECT max(ended_at) AS t FROM runs WHERE task_id = ? AND ended_at < ?")
      .get(task.task_id, to)!.t;
    const fires = s
      ? store.db
          .query<{ on_time: number; merged: number; late: number }, [string, number, number]>(
            `SELECT sum(kind = 'schedule') AS on_time, sum(kind = 'schedule' AND state = 'merged') AS merged, sum(kind = 'catchup') AS late
               FROM schedule_fires WHERE schedule_id = ? AND scheduled_for >= ? AND scheduled_for < ?`,
          )
          .get(s.schedule_id, from, to)!
      : { on_time: 0, merged: 0, late: 0 };
    const missed = s ? missedIn(store, s.schedule_id, from, to) : { asleep: 0, not_running: 0 };
    const cost = round6(runs.cost ?? 0);
    total += cost;
    const failed = runs.failed ?? 0;
    const paused = state?.paused_reason ?? null;
    monitors.push({
      task_id: task.task_id,
      name: task.name,
      schedule_id: state?.schedule_id ?? null,
      enabled: state?.enabled ?? false,
      paused_reason: paused,
      expected: (fires.on_time ?? 0) + missed.asleep + missed.not_running,
      succeeded: runs.ok ?? 0,
      changes: runs.changes ?? 0,
      failed,
      missed_asleep: missed.asleep,
      missed_not_running: missed.not_running,
      skipped: fires.merged ?? 0,
      caught_up: fires.late ?? 0,
      cost_usd: cost,
      last_run_at: last,
      next_fire_at: state?.next_fire_at ?? null,
      needs_attention: paused === "failures" || paused === "budget_cap" || failed > 0 || missed.asleep + missed.not_running > 0,
    });
  }
  return HealthDigest.parse({
    from,
    to,
    generated_at: generatedAt,
    timezone,
    monitors,
    downtime: mergedDowntime(store, from, to),
    cost_usd: round6(total),
    needs_attention: monitors.some((m) => m.needs_attention),
  });
}

/** Missed slots in the period, from the `schedule.missed` groups whose first slot falls in it. */
function missedIn(store: Store, scheduleId: string, from: number, to: number): { asleep: number; not_running: number } {
  const rows = store.db
    .query<{ reason: string; n: number }, [string, number, number]>(
      `SELECT json_extract(payload, '$.reason') AS reason, sum(json_extract(payload, '$.count')) AS n
         FROM thread_events
        WHERE type = 'schedule.missed' AND json_extract(payload, '$.schedule_id') = ?
          AND json_extract(payload, '$.scheduled_for') >= ? AND json_extract(payload, '$.scheduled_for') < ?
        GROUP BY reason`,
    )
    .all(scheduleId, from, to);
  const by = (r: string) => rows.find((x) => x.reason === r)?.n ?? 0;
  return { asleep: by("asleep"), not_running: by("not_running") };
}

/** Downtime clipped to the period, overlapping intervals of one cause joined (§8.4). */
export function mergedDowntime(store: Store, from: number, to: number): Downtime[] {
  const out: Downtime[] = [];
  for (const cause of ["not_running", "asleep"] as const) {
    let cur: Downtime | null = null;
    for (const d of downtimeBetween(store, from, to)) {
      if (d.cause !== cause) continue;
      const start = Math.max(d.start_at, from);
      const end = Math.min(d.end_at, to);
      if (end <= start) continue;
      if (cur && start <= cur.end_at) cur.end_at = Math.max(cur.end_at, end);
      else out.push((cur = { start_at: start, end_at: end, cause }));
    }
  }
  return out.sort((a, b) => a.start_at - b.start_at);
}

export function healthSettings(store: Store, deviceZone: string): HealthSettings {
  const s = getSetting<HealthSettings>(store, SETTINGS_KEY);
  const parsed = s ? HealthSettings.safeParse(s) : null;
  return parsed?.success ? parsed.data : { enabled: true, time: "08:00", timezone: deviceZone };
}

/**
 * The daily digest (§8.3): due each day at the settings' time in their zone, with run_once
 * catch-up, so a Mac asleep at 08:00 gets that morning's digest when it wakes. A change of
 * settings starts counting from the moment it is made.
 */
export class DigestScheduler {
  constructor(
    private store: Store,
    private deviceZone: () => string,
    private publish: (d: HealthDigest) => void,
  ) {}

  settings(): HealthSettings {
    return healthSettings(this.store, this.deviceZone());
  }

  setSettings(s: HealthSettings, now: number): HealthSettings {
    this.store.tx(() => {
      putSetting(this.store, SETTINGS_KEY, s);
      putSetting(this.store, LAST_KEY, now);
    });
    return s;
  }

  private compiled(s: HealthSettings): CompiledSchedule {
    const [h, m] = s.time.split(":").map(Number) as [number, number];
    const r = parseCron(`${m} ${h} * * *`);
    if (!r.ok) throw new Error(r.error);
    return { kind: "cron", fields: r.fields, hours: [h], minutes: [m], timezone: s.timezone };
  }

  private lastTo(now: number): number {
    const v = getSetting<number>(this.store, LAST_KEY);
    if (typeof v === "number") return v;
    putSetting(this.store, LAST_KEY, now);
    return now;
  }

  /** When the next digest is due, or null when it is off. */
  nextAt(now: number): number | null {
    const s = this.settings();
    if (!s.enabled) return null;
    return nextFire(this.compiled(s), this.lastTo(now));
  }

  /** Generate the digest if one is due: the latest missed slot only. */
  tick(now: number): HealthDigest | null {
    const s = this.settings();
    if (!s.enabled) return null;
    const c = this.compiled(s);
    const last = this.lastTo(now);
    let due: number | null = null;
    for (let t = nextFire(c, last); t <= now; t = nextFire(c, t)) due = t;
    if (due === null) return null;
    const to = due;
    const digest = this.store.tx(() => {
      const prev = this.store.db.query<{ to_at: number }, []>("SELECT max(to_at) AS to_at FROM health_digests").get()?.to_at ?? null;
      const from = prev !== null && prev < to && to - prev <= 31 * DAY ? prev : to - DAY;
      const d = computeDigest(this.store, from, to, s.timezone, now);
      this.store.db
        .query("INSERT OR REPLACE INTO health_digests (to_at, from_at, generated_at, digest) VALUES (?, ?, ?, ?)")
        .run(to, from, now, JSON.stringify(d));
      putSetting(this.store, LAST_KEY, to);
      return d;
    });
    log.info("health digest generated", { from: digest.from, to: digest.to, needs_attention: digest.needs_attention });
    this.publish(digest);
    return digest;
  }

  latest(): HealthDigest | null {
    const r = this.store.db.query<{ digest: string }, []>("SELECT digest FROM health_digests ORDER BY to_at DESC LIMIT 1").get();
    return r ? HealthDigest.parse(JSON.parse(r.digest)) : null;
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
