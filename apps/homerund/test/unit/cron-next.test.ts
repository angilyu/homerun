import { describe, expect, test } from "bun:test";
import { parseCron, type CronFields, type ScheduleSpec } from "@homerun/core";
import { compileSchedule, countFires, firesBetween, nextFire } from "../../src/schedule/cron-next";
import { dayStartInstant, localDay, offsetAt, resolveWall } from "../../src/schedule/zone";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const cron = (expr: string, timezone: string): ScheduleSpec => ({ kind: "cron", cron: expr, timezone, catchup: "run_once", max_catchup: 1 });
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------- the oracle

/**
 * Minute by minute, independently of cron-next: walk every UTC minute, and watch the local
 * minute it shows. When the local clock jumps forward (a gap), the skipped local minutes fire at
 * the first minute after them. When it goes backwards (an overlap), local minutes already seen
 * are second occurrences and never fire.
 */
function oracle(zone: string, crons: CronFields[], from: number, to: number): number[][] {
  const out: number[][] = crons.map(() => []);
  const fired = new Array<boolean>(crons.length);
  let maxLocal = from - MIN + offsetAt(zone, from - MIN);
  let dayKey = -1;
  let month = 0;
  let dom = 0;
  let dow = 0;
  let bucket = -1;
  let bucketOffset: number | null = null;
  for (let u = from; u < to; u += MIN) {
    const b = Math.floor(u / (15 * MIN));
    if (b !== bucket) {
      bucket = b;
      const o = offsetAt(zone, b * 15 * MIN);
      bucketOffset = o === offsetAt(zone, (b + 1) * 15 * MIN - 1000) ? o : null;
    }
    const local = u + (bucketOffset ?? offsetAt(zone, u));
    if (local <= maxLocal) continue;
    fired.fill(false);
    for (let l = maxLocal + MIN; l <= local; l += MIN) {
      const k = Math.floor(l / DAY);
      if (k !== dayKey) {
        const d = new Date(l);
        dayKey = k;
        month = d.getUTCMonth() + 1;
        dom = d.getUTCDate();
        dow = d.getUTCDay();
      }
      const hour = Math.floor(l / HOUR) % 24;
      const minute = Math.floor(l / MIN) % 60;
      for (let i = 0; i < crons.length; i++) {
        const f = crons[i]!;
        if (fired[i] || !f.minute.has(minute) || !f.hour.has(hour) || !f.month.has(month)) continue;
        const a = f.dayOfMonth.has(dom);
        const b = f.dayOfWeek.has(dow);
        const day = f.dayOfMonthRestricted && f.dayOfWeekRestricted ? a || b : f.dayOfMonthRestricted ? a : f.dayOfWeekRestricted ? b : true;
        if (day) {
          fired[i] = true;
          out[i]!.push(u);
        }
      }
    }
    maxLocal = local;
  }
  return out;
}

function transitions(zone: string, from: number, to: number): number[] {
  const out: number[] = [];
  let prev = offsetAt(zone, from);
  for (let t = from + 15 * MIN; t < to; t += 15 * MIN) {
    const o = offsetAt(zone, t);
    if (o !== prev) out.push(t);
    prev = o;
  }
  return out;
}

const ZONES = [
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Paris",
  "Australia/Sydney",
  "Australia/Lord_Howe",
  "America/Santiago",
  "America/Havana",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "UTC",
  "Pacific/Apia",
];

const SPARSE = [
  "30 2 * * *",
  "*/15 2 * * *",
  "0 3 * * *",
  "30 1 * * *",
  "0 0 * * *",
  "30 0 * * *",
  "59 23 * * *",
  "45 23 * * 6",
  "0 9 * * 1-5",
  "0 0 29 2 *",
  "15,45 0-3 * * 0",
  "0 12 1 * *",
  "0 2 1,15 * 1",
];
const DENSE = ["*/7 * * * *", "* 1-3 * * *", "0,30 * * * *"];

const FROM = Date.UTC(2026, 0, 1);
const TO = Date.UTC(2028, 0, 1);

function sequence(expr: string, zone: string, from: number, to: number): number[] {
  const s = compileSchedule(cron(expr, zone), 0);
  return firesBetween(s, from - 1, to - 1);
}

describe("cron-next matches a minute-by-minute oracle (§8)", () => {
  for (const zone of ZONES) {
    test(`${zone}: 2026–2027, and every DST transition minute by minute`, () => {
      const fields = SPARSE.map((c) => (parseCron(c) as { ok: true; fields: CronFields }).fields);
      const want = oracle(zone, fields, FROM, TO);
      SPARSE.forEach((c, i) => {
        const got = sequence(c, zone, FROM, TO);
        if (got.length !== want[i]!.length || got.some((t, j) => t !== want[i]![j])) {
          const j = got.findIndex((t, k) => t !== want[i]![k]);
          throw new Error(`${zone} "${c}": first difference at ${j}: got ${got[j] && iso(got[j]!)}, want ${want[i]![j] && iso(want[i]![j]!)}`);
        }
      });
      const denseFields = DENSE.map((c) => (parseCron(c) as { ok: true; fields: CronFields }).fields);
      for (const tr of transitions(zone, FROM, TO)) {
        const a = tr - 2 * DAY;
        const b = tr + 2 * DAY;
        const w = oracle(zone, denseFields, a, b);
        DENSE.forEach((c, i) => expect(sequence(c, zone, a, b).map(iso)).toEqual(w[i]!.map(iso)));
      }
    });
  }
});

describe("the DST rules, spelled out (§8)", () => {
  const ny = "America/New_York";

  test("a time in the spring-forward gap fires once, at the transition", () => {
    const s = compileSchedule(cron("30 2 * * *", ny), 0);
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT at 07:00Z.
    expect(iso(nextFire(s, Date.UTC(2026, 2, 8, 0)))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(nextFire(s, Date.UTC(2026, 2, 8, 7)))).toBe("2026-03-09T06:30:00.000Z");
  });

  test("several gap times and the first valid time collapse into one fire", () => {
    const s = compileSchedule(cron("*/15 2,3 * * *", ny), 0);
    const fires = firesBetween(s, Date.UTC(2026, 2, 8, 0), Date.UTC(2026, 2, 8, 12)).map(iso);
    expect(fires).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-08T07:15:00.000Z", "2026-03-08T07:30:00.000Z", "2026-03-08T07:45:00.000Z"]);
  });

  test("a time in the fall-back overlap fires once, on its first occurrence", () => {
    const s = compileSchedule(cron("30 1 * * *", ny), 0);
    // 2026-11-01: 01:30 EDT is 05:30Z; 01:30 EST (06:30Z) does not fire.
    const fires = firesBetween(s, Date.UTC(2026, 10, 1, 0), Date.UTC(2026, 10, 2, 0)).map(iso);
    expect(fires).toEqual(["2026-11-01T05:30:00.000Z"]);
  });

  test("Lord Howe's half-hour shift", () => {
    const lh = "Australia/Lord_Howe";
    // 2026-10-04: 02:00 +10:30 jumps to 02:30 +11:00 at 15:30Z the day before.
    const gap = compileSchedule(cron("15 2 * * *", lh), 0);
    expect(iso(nextFire(gap, Date.UTC(2026, 9, 3, 12)))).toBe("2026-10-03T15:30:00.000Z");
  });

  test("Santiago's midnight transition: the missing midnight fires at 01:00", () => {
    const s = compileSchedule(cron("0 0 * * *", "America/Santiago"), 0);
    // 2026-09-06: 00:00 -04 jumps to 01:00 -03 at 04:00Z.
    expect(iso(nextFire(s, Date.UTC(2026, 8, 5, 12)))).toBe("2026-09-06T04:00:00.000Z");
  });

  test("an interval is elapsed time, across both transitions", () => {
    const anchor = Date.UTC(2026, 2, 7, 23, 59);
    const s = compileSchedule({ kind: "interval", every_minutes: 15, catchup: "skip", max_catchup: 1 }, anchor);
    const fires = firesBetween(s, Date.UTC(2026, 2, 8, 5), Date.UTC(2026, 2, 8, 9));
    for (let i = 1; i < fires.length; i++) expect(fires[i]! - fires[i - 1]!).toBe(15 * MIN);
    expect(fires.length).toBe(16);
    expect(countFires(s, Date.UTC(2026, 2, 8, 5), Date.UTC(2026, 2, 8, 9))).toBe(16);
    expect(nextFire(s, anchor - HOUR)).toBe(anchor + 15 * MIN);
  });

  test("countFires agrees with firesBetween for cron", () => {
    const s = compileSchedule(cron("*/5 * * * *", "Europe/London"), 0);
    const a = Date.UTC(2026, 2, 28);
    const b = Date.UTC(2026, 2, 30);
    expect(countFires(s, a, b)).toBe(firesBetween(s, a, b).length);
  });

  test("local days and their starts", () => {
    expect(localDay("America/Los_Angeles", Date.UTC(2026, 0, 2, 7, 59))).toBe("2026-01-01");
    expect(localDay("America/Los_Angeles", Date.UTC(2026, 0, 2, 8, 0))).toBe("2026-01-02");
    expect(iso(dayStartInstant("America/Santiago", "2026-09-06"))).toBe("2026-09-06T04:00:00.000Z");
    expect(iso(resolveWall("Asia/Kathmandu", Date.UTC(2026, 0, 1, 5, 45)))).toBe("2026-01-01T00:00:00.000Z");
  });

  test("the device's own timezone never matters", () => {
    const before = process.env.TZ;
    try {
      const s = compileSchedule(cron("0 9 * * *", "Europe/Paris"), 0);
      const out: string[] = [];
      for (const tz of ["America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = tz;
        out.push(iso(nextFire(s, Date.UTC(2026, 5, 1))));
      }
      expect(new Set(out).size).toBe(1);
      expect(out[0]).toBe("2026-06-01T07:00:00.000Z");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});
