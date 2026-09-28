import { describe, expect, test } from "bun:test";
import { CRON_MACROS, CronExpression, CronSchedule, IanaTimezone, isValidCron, isValidIanaTimezone, parseCron, scheduleCronColumn } from "../src/index";

const fields = (e: string) => {
  const r = parseCron(e);
  if (!r.ok) throw new Error(r.error);
  return r.fields;
};

describe("parseCron", () => {
  test("expands steps, ranges, lists and names", () => {
    expect([...fields("*/15 * * * *").minute]).toEqual([0, 15, 30, 45]);
    expect([...fields("0 9-17/4 * * *").hour]).toEqual([9, 13, 17]);
    expect([...fields("5/20 * * * *").minute]).toEqual([5, 25, 45]);
    expect([...fields("0 0 1,15 * *").dayOfMonth]).toEqual([1, 15]);
    expect([...fields("0 0 * jan-mar *").month]).toEqual([1, 2, 3]);
    expect([...fields("0 0 * * Mon-FRI").dayOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  test("folds day-of-week 7 into Sunday", () => {
    expect([...fields("0 0 * * 7").dayOfWeek]).toEqual([0]);
    expect([...fields("0 0 * * 5-7").dayOfWeek].sort()).toEqual([0, 5, 6]);
  });

  test("records which day fields are restricted (Vixie OR semantics)", () => {
    const f = fields("0 0 13 * 5");
    expect(f.dayOfMonthRestricted).toBe(true);
    expect(f.dayOfWeekRestricted).toBe(true);
    const g = fields("0 0 */2 * *");
    expect(g.dayOfMonthRestricted).toBe(false);
  });

  test("macros expand; unsupported ones are rejected", () => {
    for (const [macro, expansion] of Object.entries(CRON_MACROS)) expect(fields(macro)).toEqual(fields(expansion));
    expect(isValidCron("@reboot")).toBe(false);
    expect(isValidCron("@every 5m")).toBe(false);
    expect(isValidCron("@DAILY")).toBe(false);
  });

  test.each([
    ["60 * * * *", "outside"],
    ["* 24 * * *", "outside"],
    ["* * 32 * *", "outside"],
    ["* * * 13 *", "outside"],
    ["* * * * 8", "outside"],
    ["*/0 * * * *", "step"],
    ["*/61 * * * *", "step"],
    ["5-1 * * * *", "backwards"],
    ["1-2-3 * * * *", "range"],
    ["1,,2 * * * *", "empty"],
    ["0 0 L * *", "invalid value"],
    ["0 0 ? * *", "invalid value"],
    ["0 0 * * 1#2", "invalid value"],
    ["0 0 15W * *", "invalid value"],
    ["0 0 30 2 *", "never occurs"],
    ["0 0 31 4,6,9,11 *", "never occurs"],
    ["0 0 * *", "5 fields"],
    ["0 0 0 * * *", "5 fields"],
    [" 0 0 * * *", "5 fields"],
    ["0\t0 * * *", "5 fields"],
  ])("rejects %p", (expr, why) => {
    const r = parseCron(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(why);
  });

  test("a restricted day-of-week rescues an impossible day-of-month", () => {
    expect(isValidCron("0 0 30 2 1")).toBe(true);
  });

  test("CronExpression schema agrees with parseCron", () => {
    for (const e of ["0 9 * * 1-5", "@hourly", "0 0 29 2 *"]) expect(CronExpression.safeParse(e).success).toBe(true);
    for (const e of ["0 0 30 2 *", "@reboot", "* * * * * *"]) expect(CronExpression.safeParse(e).success).toBe(false);
  });
});

describe("timezones", () => {
  test.each(["UTC", "Europe/London", "America/Indiana/Indianapolis", "Asia/Kolkata", "Etc/GMT+5", "US/Pacific", "Australia/Lord_Howe"])(
    "accepts %p",
    (tz) => {
      expect(isValidIanaTimezone(tz)).toBe(true);
      expect(IanaTimezone.safeParse(tz).success).toBe(true);
    },
  );

  test.each(["+05:00", "-0800", "GMT+5:30", "", "Europe/", "/London", "Europe London", "Mars/Olympus_Mons", "Local"])("rejects %p", (tz) => {
    expect(isValidIanaTimezone(tz)).toBe(false);
    expect(IanaTimezone.safeParse(tz).success).toBe(false);
  });

  test("cron schedules require a zone", () => {
    const s = { kind: "cron", cron: "0 2 * * *", timezone: "America/New_York", catchup: "run_once", max_catchup: 1 };
    expect(CronSchedule.safeParse(s).success).toBe(true);
    expect(CronSchedule.safeParse({ ...s, timezone: undefined }).success).toBe(false);
  });
});

test("scheduleCronColumn", () => {
  expect(scheduleCronColumn({ kind: "cron", cron: "0 9 * * *", timezone: "UTC", catchup: "skip", max_catchup: 1 })).toBe("0 9 * * *");
  expect(scheduleCronColumn({ kind: "interval", every_minutes: 15, catchup: "skip", max_catchup: 1 })).toBe("@every 15m");
});
