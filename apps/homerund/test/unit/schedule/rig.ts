import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PersistedThreadEvent } from "@homerun/core";
import type { FakeScript } from "../../../src/agent/fake-engine";
import { FakeAssertions } from "../../../src/power/power";
import { FakeClock } from "../../../src/schedule/clock";
import { eventsAfter } from "../../../src/store/events";
import { getMonitorState, scheduleForTask, type FireRow, type ScheduleRow } from "../../../src/store/schedule-rows";
import type { RpcClient } from "../../../src/rpc/client";
import { MOCK_KEY, monitorSpec, socketRuntime, until, type SocketRuntime } from "../../helpers";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Rig {
  sr: SocketRuntime;
  clock: FakeClock;
  power: FakeAssertions;
  shell: RpcClient;
  /** The watched file of `fileMonitor`. */
  file: string;
  write(text: string): void;
  fileMonitor(schedule: unknown, o?: { name?: string; monthly_cap_usd?: number; max_run_usd?: number; builtin?: string[] }): Promise<{ taskId: string; threadId: string; schedule(): ScheduleRow }>;
  /** Advance awake time, then wait for the runs it started to settle. */
  step(ms: number): Promise<void>;
  /** The computer sleeps for `ms` (no timers), optionally telling the runtime as the shell would. */
  sleep(ms: number, o?: { notify?: boolean }): Promise<void>;
  idle(): Promise<void>;
  fires(taskId: string): FireRow[];
  runs(taskId: string): Array<{ run_id: string; state: string; trigger: string; scheduled_for: number | null; attempt: number; outcome: string | null; started_at: number | null; monitor_phase: string | null; created_at: number }>;
  events(threadId: string, type?: string): PersistedThreadEvent[];
  coverage(taskId: string): Array<{ day: string; expected: number; ran: number; missed_asleep: number; missed_not_running: number; merged: number }>;
  state(taskId: string): unknown;
  close(): Promise<void>;
}

export async function rig(o: { start: number; zone?: string; script?: FakeScript; dir?: string; env?: Record<string, string> }): Promise<Rig> {
  const clock = new FakeClock(o.start);
  const power = new FakeAssertions(() => clock.now());
  const sr = await socketRuntime({ clock, power, deviceZone: o.zone ?? "UTC", ...(o.script ? { script: o.script } : {}), ...(o.dir ? { dir: o.dir } : {}), ...(o.env ? { env: o.env } : {}) });
  const shell = await sr.shell();
  await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
  // Under workspaces/: the rest of the data dir is on the hard denylist (§5.5).
  mkdirSync(join(sr.dir, "workspaces"), { recursive: true });
  const file = join(sr.dir, "workspaces", "watched.txt");
  writeFileSync(file, "v1");
  const store = () => sr.rt.store;
  // A test that timed out keeps running after `afterEach` closed the rig. Its next step waits forever
  // instead of querying a closed database, so nothing is reported between tests.
  let closed = false;
  const halt = () => new Promise<never>(() => {});
  const idle = async () => {
    if (closed) return halt();
    await until(
      () => closed || store().db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs WHERE state IN ('pending','running')").get()!.n === 0,
      5000,
      "runs to settle",
    );
    if (closed) return halt();
  };
  const r: Rig = {
    sr,
    clock,
    power,
    shell,
    file,
    write: (text) => writeFileSync(file, text),
    async fileMonitor(schedule, x = {}) {
      const spec = monitorSpec({
        schedule,
        roots: [sr.dir],
        check: { kind: "rule", source: { type: "file_hash", path: file }, comparator: { op: "changed" } },
        ...x,
      });
      const { task, thread_id } = await shell.call("tasks.create", { spec } as never);
      const taskId = (task as { task_id: string }).task_id;
      return { taskId, threadId: thread_id as string, schedule: () => scheduleForTask(store(), taskId)! };
    },
    async step(ms) {
      if (closed) return halt();
      await clock.advance(ms);
      await idle();
    },
    async sleep(ms, s = {}) {
      const at = clock.now();
      if (s.notify) sr.rt.fires.willSleep(at);
      clock.sleep(ms);
      if (s.notify) sr.rt.fires.didWake(clock.now(), at);
      await clock.advance(0);
      await idle();
    },
    idle,
    fires: (taskId) =>
      store()
        .db.query<FireRow, [string]>(
          "SELECT f.* FROM schedule_fires f JOIN schedules s USING (schedule_id) WHERE s.task_id = ? ORDER BY f.scheduled_for, f.attempt",
        )
        .all(taskId),
    runs: (taskId) =>
      store()
        .db.query<ReturnType<Rig["runs"]>[number], [string]>(
          "SELECT run_id, state, trigger, scheduled_for, attempt, outcome, started_at, monitor_phase, created_at FROM runs WHERE task_id = ? ORDER BY created_at, rowid",
        )
        .all(taskId),
    events: (threadId, type) => eventsAfter(store(), threadId, 0).filter((e) => !type || e.type === type),
    coverage: (taskId) =>
      store()
        .db.query<ReturnType<Rig["coverage"]>[number], [string]>(
          "SELECT c.day, c.expected, c.ran, c.missed_asleep, c.missed_not_running, c.merged FROM schedule_coverage c JOIN schedules s USING (schedule_id) WHERE s.task_id = ? ORDER BY c.day",
        )
        .all(taskId),
    state: (taskId) => getMonitorState(store(), taskId),
    close: () => {
      closed = true;
      return sr.close();
    },
  };
  return r;
}

export const every5 = (catchup: "run_once" | "run_all" | "skip" = "run_once", max_catchup = 3, timezone = "UTC") => ({
  kind: "cron",
  cron: "*/5 * * * *",
  timezone,
  catchup,
  max_catchup,
});
