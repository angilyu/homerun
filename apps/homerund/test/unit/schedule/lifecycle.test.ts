import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { RPC_ERROR } from "@homerun/core";
import type { FakeScript } from "../../../src/agent/fake-engine";
import { every5, HOUR, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await r?.close();
  r = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 0, 5, 0, 1);
const hourly = (catchup: "run_once" | "run_all" | "skip" = "run_once") => ({ kind: "cron", cron: "0 * * * *", timezone: "UTC", catchup, max_catchup: 3 });

/** An act step that waits for `release()` before ending its turn. */
function gated() {
  let open: () => void = () => {};
  let gate = new Promise<void>((res) => (open = res));
  const script: FakeScript = async (s) => {
    for (let i = await s.nextInput(); i; i = await s.nextInput()) {
      await gate;
      s.emit({ type: "message", messageId: `m-${i.uuid}`, text: "acted" });
      s.result([i.uuid]);
    }
  };
  return {
    script,
    release() {
      open();
      gate = new Promise<void>((res) => (open = res));
    },
  };
}

describe("not running", () => {
  test("slots while Homerun was stopped are missed as not_running and caught up on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-life-"));
    dirs.push(dir);
    r = await rig({ start: T0, dir });
    const m = await r.fileMonitor(every5("run_once"));
    await r.step(4 * MIN);
    await r.close();
    r = await rig({ start: T0 + 4 * MIN + 20 * MIN + 30_000, dir });
    await r.idle();
    const runs = r.runs(m.taskId);
    expect(runs.map((x) => [x.trigger, x.scheduled_for])).toEqual([
      ["schedule", T0 + 4 * MIN],
      ["catchup", T0 + 24 * MIN],
    ]);
    const missed = r.events(m.threadId, "schedule.missed");
    expect(missed.map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "not_running", count: 4, caught_up: 1 })]);
    expect(r.coverage(m.taskId)[0]).toMatchObject({ expected: 5, ran: 1, missed_not_running: 4 });
  });

  test("after a crash, downtime starts at the last heartbeat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-life-"));
    dirs.push(dir);
    r = await rig({ start: T0, dir });
    const m = await r.fileMonitor(every5("skip"));
    await r.step(4 * MIN);
    await r.step(2 * MIN); // a heartbeat at ~00:06
    r.sr.crash();
    await r.close();
    r = await rig({ start: T0 + HOUR, dir });
    await r.idle();
    const d = r.sr.rt.store.db.query<{ start_at: number; cause: string }, []>("SELECT start_at, cause FROM downtime").all();
    expect(d.length).toBe(1);
    expect(d[0]!.cause).toBe("not_running");
    expect(d[0]!.start_at).toBeGreaterThanOrEqual(T0 + 5 * MIN);
    expect(d[0]!.start_at).toBeLessThanOrEqual(T0 + 6 * MIN);
    expect(r.events(m.threadId, "schedule.missed")[0]!.payload).toMatchObject({ reason: "not_running" });
  });
});

describe("DST and timezones", () => {
  // America/Los_Angeles springs forward on 2026-03-08 at 02:00 and falls back on 2026-11-01 at 02:00.
  test("02:30 daily in Los Angeles fires at 03:00 on spring-forward day, once on fall-back day", async () => {
    const start = Date.UTC(2026, 2, 7, 9, 0); // 2026-03-07 01:00 PST
    r = await rig({ start, zone: "America/Los_Angeles" });
    const m = await r.fileMonitor({ kind: "cron", cron: "30 2 * * *", timezone: "America/Los_Angeles", catchup: "skip", max_catchup: 1 });
    for (let i = 0; i < 3 * 24; i++) await r.step(HOUR);
    const at = r.runs(m.taskId).map((x) => new Date(x.scheduled_for!).toISOString());
    expect(at).toEqual(["2026-03-07T10:30:00.000Z", "2026-03-08T10:00:00.000Z", "2026-03-09T09:30:00.000Z"]);
  });

  test("fall-back: 01:30 fires on its first occurrence only", async () => {
    const start = Date.UTC(2026, 10, 1, 7, 0); // 2026-11-01 00:00 PDT
    r = await rig({ start, zone: "America/Los_Angeles" });
    const m = await r.fileMonitor({ kind: "cron", cron: "30 1 * * *", timezone: "America/Los_Angeles", catchup: "skip", max_catchup: 1 });
    for (let i = 0; i < 6; i++) await r.step(HOUR);
    expect(r.runs(m.taskId).map((x) => new Date(x.scheduled_for!).toISOString())).toEqual(["2026-11-01T08:30:00.000Z"]);
    expect(r.coverage(m.taskId)).toEqual([{ day: "2026-11-01", expected: 1, ran: 1, missed_asleep: 0, missed_not_running: 0, merged: 0 }]);
  });

  test("a travelling device does not move a schedule with a named zone", async () => {
    const start = Date.UTC(2026, 0, 5, 16, 30);
    r = await rig({ start, zone: "America/New_York" });
    const m = await r.fileMonitor({ kind: "cron", cron: "0 9 * * *", timezone: "America/Los_Angeles", catchup: "skip", max_catchup: 1 });
    // The device flies to Tokyo; the runtime is restarted there with a new device zone.
    const next = m.schedule().next_fire_at;
    expect(next).toBe(Date.UTC(2026, 0, 5, 17, 0));
    await r.step(HOUR);
    expect(r.runs(m.taskId).map((x) => x.scheduled_for)).toEqual([Date.UTC(2026, 0, 5, 17, 0)]);
  });

  test("editing the schedule's zone re-evaluates from now: no misses for the past", async () => {
    const start = Date.UTC(2026, 0, 5, 16, 30);
    r = await rig({ start });
    const m = await r.fileMonitor({ kind: "cron", cron: "0 9 * * *", timezone: "America/Los_Angeles", catchup: "run_once", max_catchup: 1 });
    const { task } = (await r.shell.call("tasks.get", { task_id: m.taskId } as never)) as { task: { version: number; spec: Record<string, unknown> } };
    // 09:00 in New York was 14:00 UTC, already past: it must not count as missed.
    const spec = { ...task.spec, schedule: { kind: "cron", cron: "0 9 * * *", timezone: "America/New_York", catchup: "run_once", max_catchup: 1 } };
    await r.shell.call("tasks.update", { task_id: m.taskId, spec, expected_version: task.version } as never);
    expect(m.schedule().timezone).toBe("America/New_York");
    expect(m.schedule().next_fire_at).toBe(Date.UTC(2026, 0, 6, 14, 0));
    await r.step(HOUR);
    expect(r.runs(m.taskId)).toEqual([]);
    expect(r.events(m.threadId, "schedule.missed")).toEqual([]);
  });

  test("an interval schedule ignores DST: every 60 minutes stays 60 minutes apart", async () => {
    const start = Date.UTC(2026, 2, 8, 8, 0); // 00:00 PST, spring-forward day
    r = await rig({ start, zone: "America/Los_Angeles" });
    const m = await r.fileMonitor({ kind: "interval", every_minutes: 60, catchup: "skip", max_catchup: 1 });
    for (let i = 0; i < 5; i++) await r.step(HOUR);
    const at = r.runs(m.taskId).map((x) => x.scheduled_for!);
    expect(at.length).toBe(5);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBe(HOUR);
  });
});

describe("busy monitors", () => {
  test("slots that come due while the previous run is still going merge into one waiting fire (§5.3)", async () => {
    const g = gated();
    r = await rig({ start: T0, script: g.script });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN); // baseline
    r.write("v2");
    await r.clock.advance(5 * MIN); // 00:10: changed, act waits
    await r.clock.advance(15 * MIN); // 00:15 queued; 00:20, 00:25 merged
    expect(r.fires(m.taskId).map((f) => [f.state, f.kind])).toEqual([
      ["done", "schedule"],
      ["started", "schedule"],
      ["queued", "schedule"],
      ["merged", "schedule"],
      ["merged", "schedule"],
    ]);
    g.release();
    await r.idle();
    await r.clock.advance(0);
    await r.idle();
    expect(r.runs(m.taskId).map((x) => x.scheduled_for)).toEqual([T0 + 4 * MIN, T0 + 9 * MIN, T0 + 14 * MIN]);
    expect(r.coverage(m.taskId)[0]).toMatchObject({ expected: 5, ran: 3, merged: 2 });
    expect(r.events(m.threadId, "schedule.missed").map((e) => e.payload)).toEqual([
      expect.objectContaining({ reason: "skipped_by_policy", count: 1 }),
      expect.objectContaining({ reason: "skipped_by_policy", count: 1 }),
    ]);
  });
});

describe("failures", () => {
  test("a failed check retries after 1 and 5 minutes, then counts one failed fire", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(hourly());
    unlinkSync(r.file);
    await r.step(59 * MIN); // 01:00 attempt 0
    await r.step(MIN); // attempt 1
    await r.step(5 * MIN); // attempt 2
    await r.step(10 * MIN);
    const runs = r.runs(m.taskId);
    expect(runs.map((x) => [x.attempt, x.state])).toEqual([
      [0, "failed"],
      [1, "failed"],
      [2, "failed"],
    ]);
    const due = T0 + 59 * MIN;
    expect(runs.map((x) => x.created_at)).toEqual([due, due + MIN, due + 6 * MIN]);
    expect(m.schedule().consecutive_failures).toBe(1);
    expect(r.fires(m.taskId).map((f) => [f.state, f.attempt])).toEqual([["failed", 2]]);
  });

  test("three failed fires in a row pause the schedule, with a notice", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(hourly());
    unlinkSync(r.file);
    for (let i = 0; i < 4 * 12; i++) await r.step(5 * MIN);
    expect(m.schedule()).toMatchObject({ enabled: 0, paused_reason: "failures", consecutive_failures: 3 });
    expect(r.events(m.threadId, "schedule.paused").map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "failures" })]);
    expect(r.runs(m.taskId).length).toBe(9);
    // Resuming clears the count and evaluates from now.
    r.write("back");
    await r.shell.call("schedules.set_enabled", { schedule_id: m.schedule().schedule_id, enabled: true } as never);
    expect(m.schedule()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
    await r.step(HOUR);
    expect(r.runs(m.taskId).at(-1)).toMatchObject({ state: "succeeded" });
  });

  test("a failed act leaves the state alone, so the retry reports the change again", async () => {
    let acts = 0;
    r = await rig({
      start: T0,
      script: async (s) => {
        for (let i = await s.nextInput(); i; i = await s.nextInput()) {
          acts++;
          if (acts === 1) s.result([i.uuid], { ok: false, subtype: "error_during_execution" });
          else s.result([i.uuid]);
        }
      },
    });
    const m = await r.fileMonitor(hourly());
    await r.step(59 * MIN); // baseline
    const v1 = (r.state(m.taskId) as { version: number; state: unknown }).state;
    r.write("v2");
    await r.step(HOUR); // changed → act fails
    expect((r.state(m.taskId) as { state: unknown }).state).toEqual(v1);
    await r.step(MIN); // retry: changed again → act succeeds
    expect(acts).toBe(2);
    expect(r.runs(m.taskId).slice(1).map((x) => [x.attempt, x.state, x.outcome])).toEqual([
      [0, "failed", null],
      [1, "succeeded", "changed"],
    ]);
    expect((r.state(m.taskId) as { version: number }).version).toBe(2);
    expect(m.schedule().consecutive_failures).toBe(0);
  });

  test("the monthly cap pauses the schedule before a fire would start (§7.4)", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(hourly(), { monthly_cap_usd: 0.001 });
    await r.step(59 * MIN);
    r.write("v2");
    await r.step(HOUR); // act costs the fake's $0.001
    await r.step(HOUR);
    expect(m.schedule()).toMatchObject({ enabled: 0, paused_reason: "budget_cap" });
    expect(r.events(m.threadId, "schedule.paused").map((e) => e.payload)).toEqual([expect.objectContaining({ reason: "budget_cap" })]);
    expect(r.runs(m.taskId).length).toBe(2);
    const err = await r.shell.call("tasks.run_now", { task_id: m.taskId } as never).catch((e) => e);
    expect(err.code).toBe(RPC_ERROR.BUDGET_EXCEEDED);
  });
});

describe("monitor state (§8.3)", () => {
  test("a user edit made while a run is going wins over the run's new state", async () => {
    const g = gated();
    r = await rig({ start: T0, script: g.script });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    r.write("v2");
    await r.clock.advance(5 * MIN);
    const cur = (await r.shell.call("monitors.state.get", { task_id: m.taskId } as never)) as { state: { version: number } };
    await r.shell.call("monitors.state.set", { task_id: m.taskId, state: { hash: "mine" }, expected_version: cur.state.version } as never);
    g.release();
    await r.idle();
    expect(r.state(m.taskId)).toMatchObject({ version: 2, state: { hash: "mine" } });
    expect(r.runs(m.taskId)[1]).toMatchObject({ state: "succeeded" });
  });

  test("a stale expected_version is a conflict", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    const err = await r.shell.call("monitors.state.set", { task_id: m.taskId, state: {}, expected_version: 7 } as never).catch((e) => e);
    expect(err.code).toBe(RPC_ERROR.CONFLICT);
    const reset = await r.shell.call("monitors.state.reset", { task_id: m.taskId, expected_version: 1 } as never);
    expect(reset).toEqual({ ok: true });
  });

  test("run now starts a manual check, and returns the active run if one is going", async () => {
    const g = gated();
    r = await rig({ start: T0, script: g.script });
    const m = await r.fileMonitor(hourly());
    await r.shell.call("tasks.run_now", { task_id: m.taskId } as never);
    await r.idle();
    expect(r.runs(m.taskId)).toEqual([expect.objectContaining({ trigger: "manual", state: "succeeded", scheduled_for: null })]);
    r.write("v2");
    const a = (await r.shell.call("tasks.run_now", { task_id: m.taskId } as never)) as { run_id: string };
    await r.clock.advance(0);
    const b = (await r.shell.call("tasks.run_now", { task_id: m.taskId } as never)) as { run_id: string };
    expect(b.run_id).toBe(a.run_id);
    g.release();
    await r.idle();
    expect(r.coverage(m.taskId)).toEqual([]);
  });
});
