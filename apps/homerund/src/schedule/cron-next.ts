import { parseCron, type CronFields, type ScheduleSpec } from "@homerun/core";
import { localTime, resolveWall } from "./zone";

/**
 * Fire times for a schedule (§8). Written here rather than taken from a cron library because the
 * DST rules are ours and must be exact, and core already parses the grammar (`parseCron`):
 * - cron times are wall-clock times in the schedule's IANA timezone;
 * - a time in the spring-forward gap fires at the first valid instant after it (the transition),
 *   and several gap times that land on the same instant fire once;
 * - a time in the fall-back overlap fires once, on its first occurrence;
 * - an interval is elapsed time from its anchor, unaffected by DST.
 * `test/unit/cron-next.test.ts` checks this against a brute-force, minute-by-minute oracle.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Longer than any DST shift, so a candidate this far before `after` cannot fire after it. */
const SKIP_MARGIN = 3 * 3_600_000;
/** `0 0 29 2 1-5`-style expressions can wait years; parseCron rejects ones that never fire. */
const MAX_DAYS = 366 * 9;

export type CompiledSchedule =
  | { kind: "cron"; fields: CronFields; hours: number[]; minutes: number[]; timezone: string }
  | { kind: "interval"; periodMs: number; anchor: number };

/** `anchor` is when an interval schedule's elapsed time is measured from. */
export function compileSchedule(s: ScheduleSpec, anchor: number): CompiledSchedule {
  if (s.kind === "interval") return { kind: "interval", periodMs: s.every_minutes * MINUTE, anchor };
  const r = parseCron(s.cron);
  if (!r.ok) throw new Error(`invalid cron ${s.cron}: ${r.error}`);
  return {
    kind: "cron",
    fields: r.fields,
    hours: [...r.fields.hour].sort((a, b) => a - b),
    minutes: [...r.fields.minute].sort((a, b) => a - b),
    timezone: s.timezone,
  };
}

function dayMatches(f: CronFields, month: number, day: number, weekday: number): boolean {
  if (!f.month.has(month)) return false;
  const dom = f.dayOfMonth.has(day);
  const dow = f.dayOfWeek.has(weekday);
  if (f.dayOfMonthRestricted && f.dayOfWeekRestricted) return dom || dow;
  if (f.dayOfMonthRestricted) return dom;
  if (f.dayOfWeekRestricted) return dow;
  return true;
}

/** The first fire strictly after `after`. */
export function nextFire(s: CompiledSchedule, after: number): number {
  if (s.kind === "interval") {
    const k = after < s.anchor ? 1 : Math.floor((after - s.anchor) / s.periodMs) + 1;
    return s.anchor + k * s.periodMs;
  }
  const lt = localTime(s.timezone, after);
  const wallAfter = Date.UTC(lt.year, lt.month - 1, lt.day, lt.hour, lt.minute);
  const firstDay = Date.UTC(lt.year, lt.month - 1, lt.day) - DAY;
  for (let i = 0; i < MAX_DAYS; i++) {
    const dayWall = firstDay + i * DAY;
    const d = new Date(dayWall);
    if (!dayMatches(s.fields, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    for (const h of s.hours) {
      if (dayWall + (h + 1) * 3_600_000 <= wallAfter - SKIP_MARGIN) continue;
      for (const m of s.minutes) {
        const wall = dayWall + h * 3_600_000 + m * MINUTE;
        if (wall < wallAfter - SKIP_MARGIN) continue;
        const at = resolveWall(s.timezone, wall);
        if (at > after) return at;
      }
    }
  }
  throw new Error("schedule has no fire in the next nine years");
}

/** Fires in `(from, to]`, oldest first, at most `limit` (the caller counts the rest). */
export function firesBetween(s: CompiledSchedule, from: number, to: number, limit = Infinity): number[] {
  const out: number[] = [];
  for (let t = nextFire(s, from); t <= to && out.length < limit; t = nextFire(s, t)) out.push(t);
  return out;
}

/** How many fires are in `(from, to]`, without listing them. */
export function countFires(s: CompiledSchedule, from: number, to: number): number {
  if (s.kind === "interval") {
    if (to <= from) return 0;
    const idx = (t: number) => (t < s.anchor ? 0 : Math.floor((t - s.anchor) / s.periodMs));
    return idx(to) - idx(from);
  }
  let n = 0;
  for (let t = nextFire(s, from); t <= to; t = nextFire(s, t)) n++;
  return n;
}
