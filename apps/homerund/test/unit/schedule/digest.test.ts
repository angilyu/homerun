import { afterEach, describe, expect, test } from "bun:test";
import type { HealthDigest } from "@homerun/core";
import { every5, HOUR, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const digests = (rr: Rig) =>
  rr.sr.rt.store.db
    .query<{ to_at: number; from_at: number; digest: string }, []>("SELECT to_at, from_at, digest FROM health_digests ORDER BY to_at")
    .all()
    .map((d) => ({ ...d, digest: JSON.parse(d.digest) as HealthDigest }));

describe("the health digest (§8.3)", () => {
  test("daily at 08:00 local across spring-forward: 23 hours apart, and pushed to the shell", async () => {
    const start = Date.UTC(2026, 2, 7, 9, 0); // 2026-03-07 01:00 PST
    r = await rig({ start, zone: "America/Los_Angeles" });
    const seen: HealthDigest[] = [];
    r.shell.onNotification((method, params) => {
      if (method === "health.digest_ready") seen.push((params as { digest: HealthDigest }).digest);
    });
    for (let i = 0; i < 48; i++) await r.step(HOUR);
    const d = digests(r);
    expect(d.map((x) => new Date(x.to_at).toISOString())).toEqual(["2026-03-07T16:00:00.000Z", "2026-03-08T15:00:00.000Z"]);
    expect(d[1]!.to_at - d[1]!.from_at).toBe(23 * HOUR);
    expect(d[0]!.to_at - d[0]!.from_at).toBe(24 * HOUR);
    await Bun.sleep(20);
    expect(seen.map((x) => x.to)).toEqual(d.map((x) => x.to_at));
  });

  test("a Mac asleep at 08:00 gets that morning's digest on wake, once", async () => {
    const start = Date.UTC(2026, 0, 5, 6, 0);
    r = await rig({ start });
    await r.sleep(2 * 24 * HOUR + 3 * HOUR, { notify: true });
    const d = digests(r);
    expect(d.map((x) => new Date(x.to_at).toISOString())).toEqual(["2026-01-07T08:00:00.000Z"]);
    expect(d[0]!.digest.downtime).toEqual([{ start_at: Date.UTC(2026, 0, 6, 8, 0), end_at: Date.UTC(2026, 0, 7, 8, 0), cause: "asleep" }]); // clipped to the day it covers
  });

  test("counts runs, changes, misses and late runs, and flags what needs attention", async () => {
    const start = Date.UTC(2026, 0, 5, 0, 1);
    r = await rig({ start });
    await r.shell.call("health.settings.set", { settings: { enabled: false, time: "08:00", timezone: "UTC" } } as never);
    const m = await r.fileMonitor(every5("run_once"));
    await r.step(4 * MIN); // 00:05 baseline
    r.write("v2");
    await r.step(5 * MIN); // 00:10 changed
    await r.sleep(30 * MIN + 30_000, { notify: true }); // 00:15 … 00:40 missed, 00:40 caught up
    await r.step(15_000);
    const { digest } = (await r.shell.call("health.digest", { from: start, to: r.clock.now() } as never)) as { digest: HealthDigest };
    expect(digest.monitors).toEqual([
      expect.objectContaining({
        task_id: m.taskId,
        expected: 8,
        succeeded: 3,
        changes: 1,
        failed: 0,
        missed_asleep: 6,
        missed_not_running: 0,
        caught_up: 1,
        needs_attention: true,
      }),
    ]);
    expect(digest.downtime.length).toBe(1);
    expect(digest.cost_usd).toBeGreaterThan(0);
    expect(digest.needs_attention).toBe(true);
  });

  test("changing the settings starts counting from the change", async () => {
    const start = Date.UTC(2026, 0, 5, 6, 0);
    r = await rig({ start });
    await r.step(HOUR);
    await r.shell.call("health.settings.set", { settings: { enabled: true, time: "06:30", timezone: "UTC" } } as never);
    await r.step(HOUR);
    expect(digests(r)).toEqual([]);
    await r.step(24 * HOUR);
    expect(digests(r).map((x) => new Date(x.to_at).toISOString())).toEqual(["2026-01-06T06:30:00.000Z"]);
  });
});
