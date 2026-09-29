import { afterEach, describe, expect, test } from "bun:test";
import { Bus } from "../../../src/bus";
import { FakeClock } from "../../../src/schedule/clock";
import { FireScheduler, fireKey } from "../../../src/schedule/fire-scheduler";
import { openDb } from "../../../src/store/db";
import { tryInsertRun, getTask } from "../../../src/store/rows";
import { queuedFires, type FireRow } from "../../../src/store/schedule-rows";
import { Store } from "../../../src/store/store";
import { every5, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
const extra: Store[] = [];
afterEach(async () => {
  for (const s of extra.splice(0)) s.db.close();
  await r?.close();
  r = null;
});

const T0 = Date.UTC(2026, 0, 5, 0, 1);

/** A second connection to the same database, with its own scheduler that never ticks. */
function second(rr: Rig, clock: FakeClock) {
  const store = new Store(openDb(rr.sr.rt.config.dbPath), new Bus());
  extra.push(store);
  return { store, fires: new FireScheduler(store, clock, { kick: () => {} }, () => "UTC") };
}

describe("two claimants for the same slot", () => {
  test("two connections evaluating the same window queue each slot once and count it once", async () => {
    r = await rig({ start: T0 });
    await r.shell.call("schedules.list", {} as never);
    const m = await r.fileMonitor(every5("run_all", 10));
    r.sr.rt.fires.halt(); // drive both by hand
    const b = second(r, r.clock);
    r.clock.sleep(30 * MIN);
    const s = m.schedule();
    r.sr.rt.fires.evaluate(s.schedule_id, r.clock.now());
    b.fires.evaluate(s.schedule_id, r.clock.now());
    const fires = r.fires(m.taskId);
    expect(new Set(fires.map((f) => f.scheduled_for)).size).toBe(fires.length);
    expect(r.coverage(m.taskId)[0]!.expected).toBe(6);
  });

  test("promote after a run was inserted but the fire not marked: the fire adopts that run", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    r.sr.rt.fires.halt();
    r.clock.sleep(4 * MIN);
    const s = m.schedule();
    r.sr.rt.fires.evaluate(s.schedule_id, r.clock.now());
    const [fire] = queuedFires(r.sr.rt.store, s.schedule_id) as [FireRow];
    const task = getTask(r.sr.rt.store, m.taskId)!;
    // What the other claimant got as far as before it died: the run, not the fire's own row.
    const won = tryInsertRun(r.sr.rt.store, {
      threadId: m.threadId,
      taskId: m.taskId,
      taskVersion: task.version,
      deviceId: task.device_id,
      trigger: "schedule",
      originDevice: null,
      originSurface: null,
      authority: "full",
      pool: "monitor",
      now: r.clock.now(),
      scheduledFor: fire.scheduled_for,
      dedupeKey: fireKey(fire),
      attempt: 0,
      monitorPhase: "rule_check",
    })!;
    const b = second(r, r.clock);
    expect(b.fires.promote(s.schedule_id, r.clock.now())).toBe(false);
    r.sr.rt.scheduler.kick();
    await r.idle();
    expect(r.fires(m.taskId)).toEqual([expect.objectContaining({ state: "done", run_id: won.run_id })]);
    expect(r.runs(m.taskId).length).toBe(1);
    expect(r.coverage(m.taskId)[0]).toMatchObject({ expected: 1, ran: 1 });
  });

  test("two connections promoting the same fire start one run", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    r.sr.rt.fires.halt();
    r.clock.sleep(4 * MIN);
    const s = m.schedule();
    r.sr.rt.fires.evaluate(s.schedule_id, r.clock.now());
    const b = second(r, r.clock);
    const got = [r.sr.rt.fires.promote(s.schedule_id, r.clock.now()), b.fires.promote(s.schedule_id, r.clock.now())];
    expect(got).toEqual([true, false]);
    expect(r.runs(m.taskId).length).toBe(1);
  });
});

describe("run now from the web", () => {
  test("gets web_read_only authority (§9.9)", async () => {
    r = await rig({ start: T0 });
    const m = await r.fileMonitor(every5());
    const { run_id } = r.sr.rt.manager.runNow(m.taskId, { device_id: r.sr.rt.store.db.query<{ device_id: string }, []>("SELECT device_id FROM device LIMIT 1").get()!.device_id, surface: "web" } as never);
    const row = r.sr.rt.store.db.query<{ authority: string }, [string]>("SELECT authority FROM runs WHERE run_id = ?").get(run_id)!;
    expect(row.authority).toBe("web_read_only");
    await r.idle();
  });
});
