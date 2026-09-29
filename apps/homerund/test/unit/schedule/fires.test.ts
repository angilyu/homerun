import { afterEach, describe, expect, test } from "bun:test";
import { DAY, every5, HOUR, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

// 2026-01-05 00:01 UTC, a Monday: one minute after a slot.
const T0 = Date.UTC(2026, 0, 5, 0, 1);

describe("on-time fires", () => {
  test("a */5 monitor fires at each slot, on time, and a baseline check writes nothing", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    expect(m.schedule().next_fire_at).toBe(T0 + 4 * MIN);
    await r.step(4 * MIN);
    await r.step(5 * MIN);
    await r.step(5 * MIN);
    const runs = r.runs(m.taskId);
    expect(runs.map((x) => x.scheduled_for)).toEqual([T0 + 4 * MIN, T0 + 9 * MIN, T0 + 14 * MIN]);
    expect(runs.every((x) => x.state === "succeeded" && x.trigger === "schedule")).toBe(true);
    // Quiet no-change runs (§8.3 step 6): no thread events at all.
    expect(r.events(m.threadId).filter((e) => e.type.startsWith("run."))).toEqual([]);
    expect(r.coverage(m.taskId)).toEqual([{ day: "2026-01-05", expected: 3, ran: 3, missed_asleep: 0, missed_not_running: 0, merged: 0 }]);
    expect(r.fires(m.taskId).map((f) => f.state)).toEqual(["done", "done", "done"]);
    expect(m.schedule().last_fired_at).toBe(T0 + 14 * MIN);
  });

  test("a change is reported once: the check result, the act turn, and the saved state", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    const baseline = r.state(m.taskId) as { version: number };
    expect(baseline.version).toBe(1);
    r.write("v2");
    await r.step(5 * MIN);
    const runs = r.runs(m.taskId);
    expect(runs[1]).toMatchObject({ state: "succeeded", outcome: "changed", monitor_phase: "act" });
    // The evidence lives on the run (runs.get); the thread shows the act turn.
    expect(r.events(m.threadId).map((e) => e.type)).toEqual(["run.started", "message.final", "run.end"]);
    expect(r.events(m.threadId, "run.end")[0]!.payload).toMatchObject({ state: "succeeded" });
    expect((r.state(m.taskId) as { version: number }).version).toBe(2);
    // Unchanged afterwards: quiet again.
    const before = r.events(m.threadId).length;
    await r.step(5 * MIN);
    expect(r.events(m.threadId).length).toBe(before);
  });

  test("power assertions are held exactly while a monitor run is running (§8.1)", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    r.write("v2");
    await r.step(5 * MIN);
    expect(r.power.held).toBe(false);
    const tl = r.power.timeline;
    expect(tl.length).toBeGreaterThanOrEqual(4);
    for (let i = 0; i < tl.length; i++) expect(tl[i]!.held).toBe(i % 2 === 0);
    expect(tl[0]!.at).toBe(T0 + 4 * MIN);
    expect(r.runs(m.taskId).length).toBe(2);
  });
});

describe("sleep across several fires", () => {
  for (const notify of [true, false]) {
    const how = notify ? "with shell power events" : "found by the gap detector";
    test(`run_once runs the latest missed slot, late, ${how}`, async () => {
      r = await rig({ start: T0 });
      const m = await r.fileMonitor(every5("run_once"));
      await r.step(4 * MIN); // slot 00:05 ran
      await r.sleep(30 * MIN + 30_000, { notify }); // 00:05:30 → 00:36: slots 00:10 … 00:35 (6)
      await r.step(TICK);
      const runs = r.runs(m.taskId);
      expect(runs.map((x) => [x.trigger, x.scheduled_for])).toEqual([
        ["schedule", T0 + 4 * MIN],
        ["catchup", T0 + 34 * MIN],
      ]);
      const missed = r.events(m.threadId, "schedule.missed");
      expect(missed.length).toBe(1);
      expect(missed[0]!.payload).toMatchObject({ reason: "asleep", count: 6, scheduled_for: T0 + 9 * MIN, last_scheduled_for: T0 + 34 * MIN, caught_up: 1 });
      expect(r.coverage(m.taskId)[0]).toMatchObject({ expected: 7, ran: 1, missed_asleep: 6 });
      expect(r.sr.rt.store.db.query("SELECT count(*) AS n FROM downtime").get()).toEqual({ n: 1 });
    });
  }

  test("run_all replays the last max_catchup missed slots, oldest first, one at a time", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5("run_all", 3));
    await r.step(4 * MIN);
    await r.sleep(30 * MIN + 30_000, { notify: true });
    await r.step(TICK);
    await r.step(TICK);
    const late = r.runs(m.taskId).filter((x) => x.trigger === "catchup");
    expect(late.map((x) => x.scheduled_for)).toEqual([T0 + 24 * MIN, T0 + 29 * MIN, T0 + 34 * MIN]);
    expect(r.events(m.threadId, "schedule.missed")[0]!.payload).toMatchObject({ count: 6, caught_up: 3 });
  });

  test("skip runs nothing late and waits for the next slot", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5("skip"));
    await r.step(4 * MIN);
    await r.sleep(30 * MIN + 30_000, { notify: true });
    await r.step(TICK);
    expect(r.runs(m.taskId).length).toBe(1);
    expect(r.events(m.threadId, "schedule.missed")[0]!.payload).toMatchObject({ count: 6, caught_up: 0 });
    await r.step(5 * MIN);
    expect(r.runs(m.taskId).map((x) => x.scheduled_for)).toEqual([T0 + 4 * MIN, T0 + 39 * MIN]);
    expect(m.schedule().missed_since_last_run).toBe(0);
  });

  test("a week-long sleep: 2,016 slots, one notice, one late run", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5("run_once"));
    await r.step(4 * MIN);
    const t = performance.now();
    await r.sleep(7 * DAY + 30_000, { notify: true });
    await r.step(TICK);
    expect(performance.now() - t).toBeLessThan(3000);
    const missed = r.events(m.threadId, "schedule.missed");
    expect(missed.length).toBe(1);
    expect(missed[0]!.payload).toMatchObject({ count: 2016, caught_up: 1 });
    expect(r.runs(m.taskId).filter((x) => x.trigger === "catchup").length).toBe(1);
    const cov = r.coverage(m.taskId);
    expect(cov.reduce((a, c) => a + c.missed_asleep, 0)).toBe(2016);
    expect(cov.length).toBe(8);
  });

  test("the sleep missed-notice counts reset once a fire runs", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5("skip"));
    await r.step(4 * MIN);
    await r.sleep(HOUR + 30_000, { notify: true });
    await r.step(TICK);
    expect(m.schedule().missed_since_last_run).toBe(12);
    await r.step(5 * MIN);
    expect(m.schedule().missed_since_last_run).toBe(0);
  });
});

describe("the wall clock moves by itself", () => {
  test("set back an hour: no slot fires twice", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    await r.step(14 * MIN); // 00:05, 00:10, 00:15
    r.clock.setWall(r.clock.now() - HOUR);
    await r.step(20 * MIN);
    await r.step(HOUR);
    const slots = r.runs(m.taskId).map((x) => x.scheduled_for!);
    expect(new Set(slots).size).toBe(slots.length);
    expect(slots.slice(0, 3)).toEqual([T0 + 4 * MIN, T0 + 9 * MIN, T0 + 14 * MIN]);
  });

  test("set forward: the skipped span is missed as asleep, not run on time", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5("skip"));
    await r.step(4 * MIN);
    r.clock.setWall(r.clock.now() + 2 * HOUR);
    await r.step(TICK);
    expect(r.events(m.threadId, "schedule.missed")[0]!.payload).toMatchObject({ reason: "asleep", count: 24 });
  });
});

const TICK = 15_000;
