import { z } from "zod";
import { named } from "./registry";
import { ScheduleId, TaskId, TimestampMs } from "./common";
import { CRON_SHAPE_PATTERN, parseCron } from "./cron";
import { IANA_TIMEZONE_PATTERN, isValidIanaTimezone } from "./timezone";

export const CronExpression = named(
  "CronExpression",
  z
    .string()
    .regex(CRON_SHAPE_PATTERN)
    .superRefine((expr, ctx) => {
      const r = parseCron(expr);
      if (!r.ok) ctx.addIssue({ code: "custom", message: `invalid cron: ${r.error}` });
    }),
  "5-field cron, validated by parseCron",
);

export const IanaTimezone = named(
  "IanaTimezone",
  z
    .string()
    .max(64)
    .regex(IANA_TIMEZONE_PATTERN)
    .refine(isValidIanaTimezone, "unknown IANA timezone"),
);

/** What to do with fires missed while asleep or not running (§8.1). */
export const CatchupPolicy = named("CatchupPolicy", z.enum(["run_once", "run_all", "skip"]));
export type CatchupPolicy = z.infer<typeof CatchupPolicy>;

const catchupFields = {
  catchup: CatchupPolicy,
  /** Upper bound on replayed fires for `run_all` (§6 `max_catchup`). */
  max_catchup: z.int().min(1).max(100),
};

/**
 * Wall-clock schedule, evaluated in `timezone`, never device-local time (§8). DST:
 * a time in the spring-forward gap fires at the first valid instant after it; a time in the
 * fall-back overlap fires once, on its first occurrence.
 */
export const CronSchedule = named(
  "CronSchedule",
  z.object({ kind: z.literal("cron"), cron: CronExpression, timezone: IanaTimezone, ...catchupFields }),
);

/**
 * Elapsed-time schedule ("every 15 minutes"). Unaffected by DST and timezones (§8). Kept apart
 * from cron because `*\/15 * * * *` under the overlap rule would skip an hour of fires.
 */
export const IntervalSchedule = named(
  "IntervalSchedule",
  z.object({ kind: z.literal("interval"), every_minutes: z.int().min(1).max(7 * 24 * 60), ...catchupFields }),
);

export const ScheduleSpec = named("ScheduleSpec", z.discriminatedUnion("kind", [CronSchedule, IntervalSchedule]));
export type ScheduleSpec = z.infer<typeof ScheduleSpec>;

/** The value stored in `schedules.cron`: the cron text, or `@every <n>m` for an interval. */
export function scheduleCronColumn(s: ScheduleSpec): string {
  return s.kind === "cron" ? s.cron : `@every ${s.every_minutes}m`;
}

/** Scheduler state for a monitor's schedule (§6 `schedules`). Not part of the versioned spec. */
export const ScheduleState = named(
  "ScheduleState",
  z.object({
    schedule_id: ScheduleId,
    task_id: TaskId,
    /** False when paused by the user or after three failed fires in a row (§5.3). */
    enabled: z.boolean(),
    next_fire_at: TimestampMs.nullable(),
    last_fired_at: TimestampMs.nullable(),
  }),
);
export type ScheduleState = z.infer<typeof ScheduleState>;

/** Per-schedule, per-day coverage (§8.4). */
export const ScheduleCoverage = named(
  "ScheduleCoverage",
  z
    .object({
      schedule_id: ScheduleId,
      day: z.iso.date(),
      expected: z.int().nonnegative(),
      ran: z.int().nonnegative(),
      missed_asleep: z.int().nonnegative(),
      missed_not_running: z.int().nonnegative(),
    })
    .refine((c) => c.ran + c.missed_asleep + c.missed_not_running <= c.expected, "ran + missed cannot exceed expected"),
);
export type ScheduleCoverage = z.infer<typeof ScheduleCoverage>;
