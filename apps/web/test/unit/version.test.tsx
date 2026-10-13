import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "@homerun/app-state";
import { VERDICT_OK, type VersionVerdict } from "@homerun/core";
import { fakeRelay, policy, POLICY_KEYS, sign, T0 } from "../../../homerund/test/version-policy";
import type { WebConfig } from "../../src/config";
import { MemoryKv } from "../../src/storage";
import { WebUpdateBanner } from "../../src/ui";
import { WebVersionGate } from "../../src/version";

const CONFIG: WebConfig = { relayUrl: "https://relay.test", issuer: "https://id.test", clientId: "c", dev: false, version: "1.0.0" };

function gate(kv = new MemoryKv(), relay = fakeRelay(), config = CONFIG) {
  return { kv, relay, gate: WebVersionGate.forConfig(kv, config, { keys: POLICY_KEYS, fetch: relay.fetch, now: () => T0 }) };
}

describe("the web client's version gate (§11)", () => {
  test("below the web minimum: update required, and the policy is kept for offline", async () => {
    const { kv, relay, gate: g } = gate();
    relay.body = await sign(policy([{ platform: "web", channel: "stable", min_version: "1.1.0", url: "https://homerun.test/update" }, { platform: "macos", channel: "*", kill: ["*"] }]));
    expect(await g.check()).toMatchObject({ state: "update_required", reason: "below_minimum", url: "https://homerun.test/update" });
    expect(await kv.get<unknown>("state", "version_policy")).toEqual(relay.body);

    // Offline later, in a new tab: the kept policy still applies.
    relay.offline = true;
    const again = gate(kv, relay).gate;
    expect((await again.check()).state).toBe("update_required");
    expect(again.verdict.get().min_version).toBe("1.1.0");
  });

  test("a development build, another platform's rules, or no policy: no banner", async () => {
    const { relay, gate: g } = gate();
    relay.body = await sign(policy([{ platform: "ios", channel: "*", kill: ["*"] }, { platform: "web", channel: "stable", min_version: "9.0.0" }]));
    expect((await gate(new MemoryKv(), relay, { ...CONFIG, dev: true }).gate.check()).state).toBe("ok");
    relay.body = await sign(policy([{ platform: "ios", channel: "*", kill: ["*"] }]));
    expect((await g.check()).state).toBe("ok");
    relay.body = null;
    expect((await g.check()).state).toBe("ok");
  });

  test("offline with nothing kept, or a forged policy: fails open", async () => {
    const { relay, gate: g } = gate();
    relay.offline = true;
    expect(await g.check()).toEqual(VERDICT_OK);
    relay.offline = false;
    relay.body = { ...(await sign(policy([{ platform: "web", channel: "*", kill: ["*"] }]))), key_id: "2099-01" };
    expect((await g.check()).state).toBe("ok");
  });

  test("the banner: hidden when ok; Update Homerun reloads", async () => {
    const v = new Store<VersionVerdict>(VERDICT_OK);
    expect(renderToStaticMarkup(<WebUpdateBanner verdict={v} />)).toBe("");
    v.set({ ...VERDICT_OK, state: "killed", reason: "killed", message: "A known problem; please update.", url: "https://homerun.test/x" });
    const html = renderToStaticMarkup(<WebUpdateBanner verdict={v} reload={() => {}} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("banner web-version danger");
    expect(html).toContain("A known problem; please update.");
    expect(html).toContain("Update Homerun</button>");
    expect(html).toContain('href="https://homerun.test/x"');
  });
});
