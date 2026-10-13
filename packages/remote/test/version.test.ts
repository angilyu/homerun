import { describe, expect, test } from "bun:test";
import type { VersionPolicy } from "@homerun/core";
import { ed25519Key, fromHex, signVersionPolicy, toB64url } from "@homerun/protocol";
import { checkVersionPolicy, updateBannerText, type ClientVersionTarget } from "../src/version";

// The protocol vectors' test keys (packages/protocol/vectors/version-policy.json).
const RELEASE = ed25519Key(fromHex("bdb6c71b6cacab4dc675545a612c3ae40560d78310aeb26c9a7ec95b2736a953"));
const OTHER = ed25519Key(fromHex("a3d1879105860d567e01cab1f5867ca00d0696ab3ecb789ede884c3c4a84ae8d"));
const KEYS = { "2026-01": toB64url(RELEASE.publicKey) };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 2, 1);

const policy = (rules: VersionPolicy["rules"], issued_at = T0 - DAY, expires_at = issued_at + 30 * DAY): VersionPolicy => ({ v: 1, issued_at, expires_at, rules });
const sign = (p: VersionPolicy, key = RELEASE) => signVersionPolicy(p, "2026-01", key);

function relay(body: unknown, status = 200) {
  const r = {
    body,
    status,
    offline: false,
    urls: [] as string[],
    fetch: (async (url: string) => {
      r.urls.push(url);
      if (r.offline) throw new TypeError("Load failed");
      return new Response(r.body === null ? "" : JSON.stringify(r.body), { status: r.body === null ? 404 : r.status });
    }) as unknown as typeof fetch,
  };
  return r;
}

const target = (r: ReturnType<typeof relay>, o: Partial<ClientVersionTarget> = {}): ClientVersionTarget => ({
  relayUrl: "https://relay.test/",
  platform: "ios",
  channel: "stable",
  version: "1.2.0",
  keys: KEYS,
  fetch: r.fetch,
  now: () => T0,
  ...o,
});

describe("the clients' version check (§11)", () => {
  test("reads the relay's endpoint and applies only its own platform's rules", async () => {
    const r = relay(await sign(policy([{ platform: "ios", channel: "stable", min_version: "1.3.0" }, { platform: "web", channel: "*", min_version: "9.0.0" }])));
    const ios = await checkVersionPolicy(target(r));
    expect(r.urls).toEqual(["https://relay.test/v1/version-policy"]);
    expect(ios.verdict).toMatchObject({ state: "update_required", reason: "below_minimum", min_version: "1.3.0" });
    expect(ios.error).toBeNull();
    expect(updateBannerText(ios.verdict)).toBe("This version of Homerun is no longer supported. Update to 1.3.0 or later.");
    const web = await checkVersionPolicy(target(r, { platform: "web", version: "8.0.0" }));
    expect(web.verdict.min_version).toBe("9.0.0");
    // A development build is its own channel: a stable rule doesn't stop it.
    expect((await checkVersionPolicy(target(r, { channel: "development" }))).verdict.state).toBe("ok");
    expect((await checkVersionPolicy(target(r, { version: "1.3.0" }))).verdict.state).toBe("ok");
  });

  test("a forged or unsigned policy is ignored, and the kept one stays in effect", async () => {
    const good = await sign(policy([{ platform: "ios", channel: "*", min_version: "1.3.0" }]));
    const forged = await sign(policy([{ platform: "ios", channel: "*", kill: ["*"] }], T0 - 1000), OTHER);
    const r = relay(forged);
    const c = await checkVersionPolicy(target(r), good);
    expect(c.error).toContain("invalid");
    expect(c.verdict.reason).toBe("below_minimum");
    expect(c.keep).toBe(good);
    r.body = { ...good, body: good.body.replace("1.3.0", "1.9.0") };
    expect((await checkVersionPolicy(target(r))).verdict.state).toBe("ok");
  });

  test("replay: an older policy than the kept one can't lift it; an expired one fails open", async () => {
    const newer = await sign(policy([{ platform: "ios", channel: "*", kill: ["<2.0.0"] }], T0 - DAY));
    const older = await sign(policy([], T0 - 2 * DAY));
    const r = relay(older);
    const c = await checkVersionPolicy(target(r), newer);
    expect(c.error).toContain("stale");
    expect(c.verdict.state).toBe("killed");
    expect(updateBannerText(c.verdict)).toContain("stopped");

    // Past its expiry, the kept kill no longer applies, and an expired one from the relay isn't adopted.
    const later = () => T0 + 40 * DAY;
    r.body = older;
    const e = await checkVersionPolicy(target(r, { now: later }), newer);
    expect(e.verdict.state).toBe("ok");
    expect(e.error).toBe("expired");
  });

  test("a newer policy replaces the kept one", async () => {
    const kill = await sign(policy([{ platform: "web", channel: "*", kill: ["*"] }], T0 - 2 * DAY));
    const lifted = await sign(policy([], T0 - DAY));
    const c = await checkVersionPolicy(target(relay(lifted), { platform: "web" }), kill);
    expect(c.verdict.state).toBe("ok");
    expect(c.keep).toEqual(lifted);
  });

  test("fails open: offline, an HTTP error, garbage, or a build without a key", async () => {
    const kept = await sign(policy([{ platform: "ios", channel: "*", min_version: "1.3.0" }]));
    const r = relay(null);
    r.offline = true;
    let c = await checkVersionPolicy(target(r));
    expect(c.verdict.state).toBe("ok");
    expect(c.error).toContain("offline");
    // Offline with a kept policy: it still applies, as on the Mac.
    expect((await checkVersionPolicy(target(r), kept)).verdict.state).toBe("update_required");
    r.offline = false;
    r.status = 500;
    r.body = { nope: 1 };
    expect((await checkVersionPolicy(target(r))).verdict.state).toBe("ok");
    r.status = 200;
    r.body = "not a policy";
    expect((await checkVersionPolicy(target(r))).verdict.state).toBe("ok");
    // None published keeps the kept one without an error.
    r.body = null;
    c = await checkVersionPolicy(target(r), kept);
    expect(c).toMatchObject({ error: null, keep: kept, verdict: { state: "update_required" } });
    // No compiled-in key: nothing verifies, nothing is fetched.
    const before = r.urls.length;
    expect((await checkVersionPolicy(target(r, { keys: {} }), kept)).verdict.state).toBe("ok");
    expect(r.urls.length).toBe(before);
  });
});
