import type { VersionPolicy } from "@homerun/core";
import { ed25519Key, fromHex, signVersionPolicy, toB64url } from "@homerun/protocol";

/** Signed version policies and a fake relay for the gate's tests (§11). */

// The protocol vectors' test keys (packages/protocol/vectors/version-policy.json).
export const RELEASE = ed25519Key(fromHex("bdb6c71b6cacab4dc675545a612c3ae40560d78310aeb26c9a7ec95b2736a953"));
export const OTHER = ed25519Key(fromHex("a3d1879105860d567e01cab1f5867ca00d0696ab3ecb789ede884c3c4a84ae8d"));
export const POLICY_KEYS = { "2026-01": toB64url(RELEASE.publicKey) };
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const T0 = Date.UTC(2026, 0, 5, 0, 1);

export function policy(rules: VersionPolicy["rules"], o: { issued_at?: number; expires_at?: number } = {}): VersionPolicy {
  const issued_at = o.issued_at ?? T0 - HOUR;
  return { v: 1, issued_at, expires_at: o.expires_at ?? issued_at + 30 * DAY, rules };
}

export const sign = (p: VersionPolicy, key = RELEASE, keyId = "2026-01") => signVersionPolicy(p, keyId, key);

/** A relay that serves whatever the test says. */
export function fakeRelay() {
  const r = {
    body: null as unknown,
    status: 200,
    offline: false,
    hits: 0,
    fetch: (async () => {
      r.hits++;
      if (r.offline) throw new TypeError("fetch failed: ECONNREFUSED");
      return new Response(r.body === null ? "not found" : JSON.stringify(r.body), { status: r.body === null ? 404 : r.status });
    }) as unknown as typeof fetch,
  };
  return r;
}
