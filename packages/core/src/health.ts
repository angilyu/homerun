import { z } from "zod";
import { named } from "./registry";
import { ScheduleId, TaskId, TimestampMs } from "./common";
import { IanaTimezone, SchedulePausedReason } from "./schedule";

/**
 * The health digest (§8.3): silence must be distinguishable from death. Once a day, at a time the
 * user chooses, Homerun summarises every monitor. The digest can be turned off; missed-fire and
 * failure events (§8.2) cannot.
 */

/** A time of day, `HH:MM`, 24-hour. */
export const TimeOfDay = named("TimeOfDay", z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/));

export const HealthSettings = named(
  "HealthSettings",
  z.object({
    /** Whether the daily digest is generated. */
    enabled: z.boolean(),
    /** When, in `timezone`. */
    time: TimeOfDay,
    timezone: IanaTimezone,
  }),
);
export type HealthSettings = z.infer<typeof HealthSettings>;

/** A period the computer was asleep or Homerun was not running (§8.4). */
export const Downtime = named(
  "Downtime",
  z
    .object({ start_at: TimestampMs, end_at: TimestampMs, cause: z.enum(["asleep", "not_running"]) })
    .refine((d) => d.end_at >= d.start_at, "end_at must not be before start_at"),
);
export type Downtime = z.infer<typeof Downtime>;

export const MonitorHealth = named(
  "MonitorHealth",
  z.object({
    task_id: TaskId,
    name: z.string().min(1).max(200),
    schedule_id: ScheduleId.nullable(),
    enabled: z.boolean(),
    paused_reason: SchedulePausedReason.nullable(),
    /** Fires that were due in the period. */
    expected: z.int().nonnegative(),
    /** Runs that finished in the period, by outcome. */
    succeeded: z.int().nonnegative(),
    changes: z.int().nonnegative(),
    failed: z.int().nonnegative(),
    /** Fires that did not run on time, by cause (§8.4). */
    missed_asleep: z.int().nonnegative(),
    missed_not_running: z.int().nonnegative(),
    /** On-time fires Homerun merged into one already waiting (§5.3). Missed fires the catch-up policy does not run stay counted as missed. */
    skipped: z.int().nonnegative(),
    /** Late runs made by the catch-up policy (§8.1). */
    caught_up: z.int().nonnegative(),
    cost_usd: z.number().nonnegative(),
    last_run_at: TimestampMs.nullable(),
    next_fire_at: TimestampMs.nullable(),
    /** Something the user should look at: a pause, a failure, or a miss. */
    needs_attention: z.boolean(),
  }),
);
export type MonitorHealth = z.infer<typeof MonitorHealth>;

export const HealthDigest = named(
  "HealthDigest",
  z
    .object({
      from: TimestampMs,
      to: TimestampMs,
      generated_at: TimestampMs,
      /** The zone its times are shown in. */
      timezone: IanaTimezone,
      monitors: z.array(MonitorHealth),
      /** Sleep and not-running periods that overlap the digest's period, oldest first. */
      downtime: z.array(Downtime),
      cost_usd: z.number().nonnegative(),
      needs_attention: z.boolean(),
    })
    .refine((d) => d.to > d.from, "to must be after from"),
);
export type HealthDigest = z.infer<typeof HealthDigest>;

/** The longest period one digest may cover. */
export const HEALTH_DIGEST_MAX_MS = 31 * 24 * 60 * 60 * 1000;
