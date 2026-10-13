import { afterEach, describe, expect, test } from "bun:test";
import { RPC_ERROR, type HealthDigest, type VersionGateStatus } from "@homerun/core";
import { RpcCallError } from "../../../src/rpc/client";
import { policyPlatform } from "../../../src/version/target";
import { uuid } from "../../helpers";
import { fakeRelay, policy, POLICY_KEYS, sign } from "../../version-policy";
import { DAY, every5, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

// 2026-01-05 00:01 UTC: one minute after a slot.
const T0 = Date.UTC(2026, 0, 5, 0, 1);
const PLATFORM = policyPlatform();

async function gated(relay: ReturnType<typeof fakeRelay>) {
  return rig({
    start: T0,
    versionFetch: relay.fetch,
    env: { HOMERUN_DEV_POLICY_KEYS: JSON.stringify(POLICY_KEYS), HOMERUN_DEV_VERSION: "0.3.0", HOMERUN_VERSION_POLICY_URL: "https://relay.test/v1/version-policy" },
  });
}

const kill = (o: { kill_interactive?: boolean; issued_at?: number } = {}) =>
  sign(policy([{ platform: PLATFORM, channel: "*", kill: ["0.3.0"], message: "0.3.0 can repeat runs. Update Homerun.", url: "https://homerun.example/status", ...(o.kill_interactive ? { kill_interactive: true } : {}) }], o.issued_at ? { issued_at: o.issued_at } : {}));

describe("the version gate in the runtime (§11)", () => {
  test("a kill skips scheduled fires with the reason, in history and the digest; lifting it resumes", async () => {
    const relay = fakeRelay();
    r = await gated(relay);
    const notes: VersionGateStatus[] = [];
    r.shell.onNotification((m, p) => {
      if (m === "version.changed") notes.push((p as { status: VersionGateStatus }).status);
    });
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    expect(r.runs(m.taskId).length).toBe(1);

    relay.body = await kill();
    await r.sr.rt.gate.check();
    await r.step(5 * MIN);
    await r.step(5 * MIN);
    // No run started; each fire is recorded as skipped, with why.
    expect(r.runs(m.taskId).length).toBe(1);
    expect(r.fires(m.taskId).map((f) => f.state)).toEqual(["done", "skipped", "skipped"]);
    const skipped: unknown[] = r.events(m.threadId, "schedule.skipped").map((e) => e.payload);
    expect(skipped).toEqual([
      { schedule_id: m.schedule().schedule_id, scheduled_for: T0 + 9 * MIN, reason: "killed", count: 1 },
      { schedule_id: m.schedule().schedule_id, scheduled_for: T0 + 14 * MIN, reason: "killed", count: 1 },
    ]);
    // The schedule itself is untouched: the gate only holds it.
    expect(m.schedule()).toMatchObject({ enabled: 1, paused_reason: null });

    const { digest } = (await r.shell.call("health.digest", { from: T0 - MIN, to: T0 + 20 * MIN })) as { digest: HealthDigest };
    expect(digest.monitors[0]).toMatchObject({ skipped_by_version: 2, needs_attention: true });

    const status = (await r.shell.call("version.status", {})) as { status: VersionGateStatus };
    expect(status.status.verdict).toMatchObject({ state: "killed", reason: "killed", unattended_allowed: false, interactive_allowed: true, message: "0.3.0 can repeat runs. Update Homerun.", url: "https://homerun.example/status" });
    expect(notes.map((n) => n.verdict.state)).toEqual(["killed"]);

    // A newer policy without the kill: the next fire runs; the skipped ones stay skipped.
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.1.0" }], { issued_at: T0 }));
    const checked = (await r.shell.call("version.check", {})) as { status: VersionGateStatus };
    expect(checked.status.verdict.state).toBe("ok");
    await r.step(5 * MIN);
    expect(r.runs(m.taskId).map((x) => x.scheduled_for)).toEqual([T0 + 4 * MIN, T0 + 19 * MIN]);
    expect(r.fires(m.taskId).map((f) => f.state)).toEqual(["done", "skipped", "skipped", "done"]);
    expect(notes.map((n) => n.verdict.state)).toEqual(["killed", "ok"]);
  });

  test("below the minimum: the same hold, with its own reason", async () => {
    const relay = fakeRelay();
    r = await gated(relay);
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.4.0" }]));
    await r.sr.rt.gate.check();
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    expect(r.runs(m.taskId)).toEqual([]);
    expect(r.events(m.threadId, "schedule.skipped").map((e) => (e.payload as { reason: string }).reason)).toEqual(["below_minimum"]);
  });

  test("restrict only: it never resumes what the user paused, starts anything, or deletes anything", async () => {
    const relay = fakeRelay();
    r = await gated(relay);
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    await r.shell.call("schedules.set_enabled", { schedule_id: m.schedule().schedule_id, enabled: false });
    const counts = () => r!.sr.rt.store.db.query<{ t: number; r: number; e: number }, []>("SELECT (SELECT count(*) FROM tasks) t, (SELECT count(*) FROM runs) r, (SELECT count(*) FROM thread_events) e").get()!;
    const before = counts();

    relay.body = await kill();
    await r.sr.rt.gate.check();
    await r.step(10 * MIN);
    relay.body = await sign(policy([], { issued_at: T0 }));
    await r.sr.rt.gate.check();
    await r.step(10 * MIN);
    // Still paused by the user, nothing ran, nothing skipped (a paused schedule queues no fires), nothing removed.
    expect(m.schedule()).toMatchObject({ enabled: 0, paused_reason: "user" });
    expect(counts()).toEqual(before);
  });

  test("a kill leaves chat and Run now alone unless it says kill_interactive", async () => {
    const relay = fakeRelay();
    r = await gated(relay);
    const m = await r.fileMonitor(every5());
    relay.body = await kill();
    await r.sr.rt.gate.check();
    const { thread } = (await r.shell.call("threads.create", {})) as { thread: { thread_id: string } };
    await r.shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "still here?" });
    await r.shell.call("tasks.run_now", { task_id: m.taskId });
    await r.idle();

    relay.body = await kill({ kill_interactive: true, issued_at: T0 });
    await r.sr.rt.gate.check();
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(RpcCallError);
      expect((e as RpcCallError).code).toBe(RPC_ERROR.VERSION_BLOCKED);
      expect((e as RpcCallError).data).toEqual({ reason: "killed", url: "https://homerun.example/status" });
    };
    const runs = r.sr.rt.store.db.query<{ n: number }, []>("SELECT count(*) n FROM runs").get()!.n;
    await refused(r.shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "and now?" }));
    await refused(r.shell.call("tasks.run_now", { task_id: m.taskId }));
    expect(r.sr.rt.store.db.query<{ n: number }, []>("SELECT count(*) n FROM runs").get()!.n).toBe(runs);
  });

  test("offline at start with a cached kill: the cache holds until the policy expires", async () => {
    const relay = fakeRelay();
    r = await gated(relay);
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }], { expires_at: T0 + DAY }));
    await r.sr.rt.gate.check();
    relay.offline = true;
    const m = await r.fileMonitor(every5());
    await r.step(4 * MIN);
    expect(r.runs(m.taskId)).toEqual([]);
    await r.step(DAY);
    // Expired: fails open, and the next fire runs.
    expect(r.sr.rt.gate.verdict().state).toBe("ok");
    expect(r.runs(m.taskId).length).toBeGreaterThan(0);
  });
});
