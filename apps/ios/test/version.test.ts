import { describe, expect, test } from "bun:test";
import { fakeRelay, HOUR, policy, POLICY_KEYS, sign, T0 } from "../../homerund/test/version-policy";
import type { IosConfig } from "../src/config";
import { IosVersionGate, type PolicyKv } from "../src/version";

const CONFIG: IosConfig = { relayUrl: "https://relay.test", issuer: "https://id.test", clientId: "c", dev: false, version: "1.0.0" };

class MemKv implements PolicyKv {
  readonly m = new Map<string, string>();
  async kvGet(name: string) {
    return this.m.get(name) ?? null;
  }
  async kvSet(name: string, value: string | null) {
    if (value === null) this.m.delete(name);
    else this.m.set(name, value);
  }
}

function setup(kv = new MemKv(), relay = fakeRelay(), config = CONFIG) {
  const clock = { now: T0 };
  const gate = IosVersionGate.forConfig(kv, config, { keys: POLICY_KEYS, fetch: relay.fetch, now: () => clock.now });
  return { kv, relay, gate, clock };
}

describe("the iPhone app's version gate (§11)", () => {
  test("below the iOS minimum: Update Homerun, kept across launches for offline", async () => {
    const { kv, relay, gate } = setup();
    relay.body = await sign(policy([{ platform: "ios", channel: "stable", min_version: "1.0.1" }, { platform: "web", channel: "*", kill: ["*"] }]));
    expect(await gate.check()).toMatchObject({ state: "update_required", min_version: "1.0.1" });
    expect(JSON.parse(kv.m.get("version_policy")!)).toEqual(relay.body);
    relay.offline = true;
    const next = setup(kv, relay).gate;
    expect((await next.check()).state).toBe("update_required");
  });

  test("restrict-only and fail-open: other platforms, development builds, offline, forged", async () => {
    const { relay, gate } = setup();
    relay.body = await sign(policy([{ platform: "web", channel: "*", kill: ["*"] }, { platform: "macos", channel: "*", kill: ["*"] }]));
    expect((await gate.check()).state).toBe("ok");
    relay.body = await sign(policy([{ platform: "ios", channel: "stable", kill: ["*"] }]));
    expect((await setup(new MemKv(), relay, { ...CONFIG, dev: true }).gate.check()).state).toBe("ok");
    relay.offline = true;
    expect((await setup().gate.check()).state).toBe("ok");
    relay.offline = false;
    relay.body = { ...(relay.body as object), sig: "AAAA" };
    expect((await setup().gate.check()).state).toBe("ok");
  });

  test("a garbled kept policy is dropped; foreground checks are at most hourly", async () => {
    const kv = new MemKv();
    kv.m.set("version_policy", "{not json");
    const { relay, gate, clock } = setup(kv);
    relay.body = null;
    expect((await gate.check()).state).toBe("ok");
    expect(kv.m.has("version_policy")).toBe(false);
    const hits = relay.hits;
    gate.maybeCheck();
    clock.now += HOUR / 2;
    gate.maybeCheck();
    expect(relay.hits).toBe(hits);
    clock.now += HOUR;
    gate.maybeCheck();
    await Bun.sleep(0);
    expect(relay.hits).toBe(hits + 1);
  });
});
