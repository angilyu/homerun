import { afterEach, describe, expect, test } from "bun:test";
import type { VersionGateStatus } from "@homerun/core";
import { FakeClock } from "../../src/schedule/clock";
import { getSetting } from "../../src/store/schedule-rows";
import { POLICY_SETTING, VersionGate, type VersionGateOptions } from "../../src/version/gate";
import { policyPlatform } from "../../src/version/target";
import { testRuntime, type TestRuntime } from "../helpers";
import { DAY, fakeRelay, HOUR, OTHER, policy, POLICY_KEYS, RELEASE, sign, T0 } from "../version-policy";

const PLATFORM = policyPlatform();

let t: TestRuntime | null = null;
afterEach(() => {
  t?.close();
  t = null;
});

function gate(o: Partial<VersionGateOptions> & { relay: ReturnType<typeof fakeRelay>; clock: FakeClock; changes?: VersionGateStatus[] }) {
  t ??= testRuntime();
  return new VersionGate({
    store: t.store,
    url: "https://relay.test/v1/version-policy",
    keys: POLICY_KEYS,
    version: "0.3.0",
    platform: PLATFORM,
    channel: "stable",
    fetch: o.relay.fetch,
    onChange: (s) => o.changes?.push(s),
    ...o,
  });
}

describe("the version gate (§11)", () => {
  test("a signed policy below the minimum stops unattended work only, and is cached", async () => {
    const clock = new FakeClock(T0);
    const relay = fakeRelay();
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "stable", min_version: "0.4.0", message: "Update to 0.4.0." }]));
    const changes: VersionGateStatus[] = [];
    const g = gate({ relay, clock, changes });
    expect(g.verdict().state).toBe("ok");
    const s = await g.check();
    expect(s.verdict).toMatchObject({ state: "update_required", reason: "below_minimum", unattended_allowed: false, interactive_allowed: true, min_version: "0.4.0", message: "Update to 0.4.0." });
    expect(s.policy).toMatchObject({ source: "relay", issued_at: T0 - HOUR });
    expect(changes.map((c) => c.verdict.state)).toEqual(["update_required"]);
    expect(getSetting(t!.store, POLICY_SETTING)).toMatchObject({ signed: relay.body, fetched_at: T0 });
    // The same verdict again: no second change.
    await g.check();
    expect(changes.length).toBe(1);
  });

  test("a kill matches a version range; kill_interactive also stops chat", async () => {
    const clock = new FakeClock(T0);
    const relay = fakeRelay();
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: [">=0.3.0 <0.3.1"] }]));
    const g = gate({ relay, clock });
    expect((await g.check()).verdict).toMatchObject({ state: "killed", reason: "killed", unattended_allowed: false, interactive_allowed: true });
    relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["0.3.0"], kill_interactive: true }], { issued_at: T0 - HOUR + 1 }));
    expect((await g.check()).verdict).toMatchObject({ state: "killed", interactive_allowed: false });
  });

  test("rules for another platform or channel don't apply", async () => {
    const clock = new FakeClock(T0);
    const relay = fakeRelay();
    relay.body = await sign(policy([
      { platform: PLATFORM === "ios" ? "web" : "ios", channel: "*", kill: ["*"] },
      { platform: PLATFORM, channel: "beta", kill: ["*"] },
    ]));
    expect((await gate({ relay, clock }).check()).verdict.state).toBe("ok");
  });

  describe("signature", () => {
    test("an unknown key, a forged signature or a tampered body fails open", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      const kill = policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }]);
      const g = gate({ relay, clock });

      relay.body = await sign(kill, OTHER, "2026-01"); // right key id, wrong key
      expect((await g.check()).verdict.state).toBe("ok");
      expect(g.status().last_error).toMatch(/^invalid:/);

      relay.body = await sign(kill, RELEASE, "2099-01"); // a key id this build doesn't trust
      expect((await g.check()).verdict.state).toBe("ok");

      const good = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.1.0" }]));
      relay.body = { ...good, body: good.body.replace('"min_version":"0.1.0"', '"kill":["*"]') };
      expect((await g.check()).verdict.state).toBe("ok");
      expect(getSetting(t!.store, POLICY_SETTING)).toBeNull();

      relay.body = "<html>captive portal</html>";
      expect((await g.check()).verdict.state).toBe("ok");
    });

    test("a cached policy whose key was retired from the build no longer counts", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }]));
      expect((await gate({ relay, clock }).check()).verdict.state).toBe("killed");
      expect(gate({ relay, clock }).verdict().state).toBe("killed");
      expect(gate({ relay, clock, keys: { "2027-01": POLICY_KEYS["2026-01"]!.replace(/^./, "A") } }).verdict().state).toBe("ok");
    });

    test("a build without a policy key never fetches, and fails open", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      const g = gate({ relay, clock, keys: {} });
      const s = await g.check();
      expect(relay.hits).toBe(0);
      expect(s.verdict.state).toBe("ok");
      expect(s.last_error).toBe("no version policy key in this build");
    });
  });

  describe("expiry and replay", () => {
    test("an expired policy fails open without a fetch, and status shows no policy", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }], { expires_at: T0 + DAY }));
      const changes: VersionGateStatus[] = [];
      const g = gate({ relay, clock, changes, intervalMs: 10 * DAY });
      expect((await g.check()).verdict.state).toBe("killed");
      clock.sleep(DAY);
      expect(g.verdict().state).toBe("ok");
      expect(g.status().policy).toBeNull();
      // The periodic re-evaluation reports it.
      g.reevaluate();
      expect(changes.map((c) => c.verdict.state)).toEqual(["killed", "ok"]);
    });

    test("a replayed older policy can't lift a newer kill", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      const old = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.1.0" }], { issued_at: T0 - 2 * DAY }));
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }], { issued_at: T0 - HOUR }));
      const g = gate({ relay, clock });
      expect((await g.check()).verdict.state).toBe("killed");
      relay.body = old;
      const s = await g.check();
      expect(s.verdict.state).toBe("killed");
      expect(s.last_error).toBe("stale: issued before the cached policy");
      // …and across a restart: the cache holds the newer one.
      expect((await gate({ relay, clock }).check()).verdict.state).toBe("killed");
    });

    test("a policy issued far in the future isn't in effect", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }], { issued_at: T0 + 2 * DAY }));
      const g = gate({ relay, clock });
      expect((await g.check()).verdict.state).toBe("ok");
      expect(g.status().last_error).toBe("invalid: issued in the future");
      // Not adopted, so it can't make the next real policy look stale.
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "9.0.0" }]));
      expect((await g.check()).verdict.state).toBe("update_required");
    });

    test("a published policy that has already expired isn't adopted", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", kill: ["*"] }], { issued_at: T0 - 10 * DAY, expires_at: T0 - DAY }));
      const g = gate({ relay, clock });
      expect((await g.check()).verdict.state).toBe("ok");
      expect(g.status().last_error).toMatch(/^expired/);
      expect(getSetting(t!.store, POLICY_SETTING)).toBeNull();
    });
  });

  describe("failing open", () => {
    test("offline with nothing cached: ok, and the error is reported", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.offline = true;
      const s = await gate({ relay, clock }).check();
      expect(s.verdict.state).toBe("ok");
      expect(s.last_error).toMatch(/^offline: /);
      expect(s.checked_at).toBe(T0);
    });

    test("offline, a 5xx or a 404 keeps the last valid policy until it expires", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.4.0" }], { expires_at: T0 + 2 * DAY }));
      const g = gate({ relay, clock });
      await g.check();
      relay.offline = true;
      expect((await g.check()).verdict.state).toBe("update_required");
      relay.offline = false;
      relay.status = 503;
      expect((await g.check()).verdict.state).toBe("update_required");
      relay.body = null; // 404: none published
      expect((await g.check()).verdict.state).toBe("update_required");
      // A restart offline uses the cache too.
      relay.offline = true;
      const g2 = gate({ relay, clock });
      expect(g2.status().policy?.source).toBe("cache");
      expect(g2.verdict().state).toBe("update_required");
      clock.sleep(2 * DAY);
      expect(g2.verdict().state).toBe("ok");
    });

    test("an update clears it: the same policy, a newer version", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      relay.body = await sign(policy([{ platform: PLATFORM, channel: "*", min_version: "0.4.0", kill: ["<0.3.5"] }]));
      expect((await gate({ relay, clock }).check()).verdict.state).toBe("killed");
      relay.offline = true;
      expect(gate({ relay, clock, version: "0.4.0" }).verdict().state).toBe("ok");
    });

    test("it checks at start and then periodically", async () => {
      const clock = new FakeClock(T0);
      const relay = fakeRelay();
      const g = gate({ relay, clock, intervalMs: HOUR });
      g.start();
      await clock.advance(0);
      expect(relay.hits).toBe(1);
      await clock.advance(HOUR);
      await clock.advance(HOUR);
      expect(relay.hits).toBe(3);
      g.stop();
      await clock.advance(3 * HOUR);
      expect(relay.hits).toBe(3);
    });
  });
});
