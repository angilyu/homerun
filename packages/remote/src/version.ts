import { VERDICT_OK, VERSION_POLICY_MAX_BYTES, evaluateVersionPolicy, isPolicyCurrent, type VersionPolicy, type VersionVerdict } from "@homerun/core";
import { RELAY_PATHS, VERSION_POLICY_KEYS, verifySignedVersionPolicy, type VersionPolicyKeys } from "@homerun/protocol";

/**
 * The minimum-version gate for the phone and web clients (§11 "Updates and control"): the same
 * signed policy the runtime reads, from the relay's public endpoint, evaluated for this client's
 * own platform. The rules match homerund's gate: verify the signature against the compiled-in
 * keys, ignore a policy that isn't current, never go back to an older `issued_at` than the one
 * kept, and fail open. A client only shows "Update Homerun"; it never stops anything itself, and
 * the Mac's runtime enforces its own gate.
 */

export interface ClientVersionTarget {
  /** The relay's base URL, without a trailing slash. */
  relayUrl: string;
  platform: "ios" | "web";
  /** "stable", or "development" for a development build, so stable rules never stop it. */
  channel: string;
  version: string;
  keys?: VersionPolicyKeys;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

export interface ClientVersionCheck {
  verdict: VersionVerdict;
  /** The signed policy to keep for the next check: the new one, or the one passed in. */
  keep: unknown;
  /** Why the fetched policy wasn't used, or null. The verdict then comes from `keep`. */
  error: string | null;
}

/** Fetch the policy and evaluate it, against the kept one (`cached`, as returned in `keep` last time). Never rejects. */
export async function checkVersionPolicy(t: ClientVersionTarget, cached: unknown = null): Promise<ClientVersionCheck> {
  const keys = t.keys ?? VERSION_POLICY_KEYS;
  const now = (t.now ?? Date.now)();
  const kept = cached ? verifySignedVersionPolicy(cached, keys) : null;
  const result = (policy: VersionPolicy | null, keep: unknown, error: string | null): ClientVersionCheck => ({ verdict: verdictFor(policy, t, now), keep, error });
  const keepOld = (error: string | null) => result(kept, kept ? cached : null, error);
  if (!Object.keys(keys).length) return keepOld("no version policy key in this build");
  let raw: unknown;
  try {
    const res = await (t.fetch ?? fetch)(t.relayUrl.replace(/\/+$/, "") + RELAY_PATHS.versionPolicy, {
      signal: AbortSignal.timeout(t.timeoutMs ?? 15_000),
      headers: { accept: "application/json" },
    });
    // None published: keep what we have, so a relay that loses its config doesn't lift a policy early.
    if (res.status === 404) return keepOld(null);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > VERSION_POLICY_MAX_BYTES * 2) throw new Error("too large");
    raw = JSON.parse(text);
  } catch (e) {
    return keepOld(`offline: ${e instanceof Error ? e.message : String(e)}`);
  }
  const policy = verifySignedVersionPolicy(raw, keys);
  if (!policy) return keepOld("invalid: the policy's signature or format didn't verify");
  if (!isPolicyCurrent(policy, now)) return keepOld(policy.expires_at <= now ? "expired" : "invalid: issued in the future");
  if (kept && policy.issued_at < kept.issued_at) return keepOld("stale: issued before the kept policy");
  return result(policy, raw, null);
}

/** What `policy` means for this client now; ok without one, or if it can't be evaluated. */
export function verdictFor(policy: VersionPolicy | null, t: Pick<ClientVersionTarget, "platform" | "channel" | "version">, now: number): VersionVerdict {
  try {
    return evaluateVersionPolicy(policy, { platform: t.platform, channel: t.channel, version: t.version, now });
  } catch {
    return VERDICT_OK;
  }
}

/** The text of the clients' "Update Homerun" banner, or null when this version is fine. */
export function updateBannerText(v: VersionVerdict): string | null {
  if (v.state === "ok") return null;
  if (v.message) return v.message;
  if (v.reason === "killed") return "This version of Homerun has been stopped. Update Homerun to keep using it.";
  if (v.reason === "blocked_version") return "This version of Homerun has a known problem. Update Homerun.";
  return v.min_version ? `This version of Homerun is no longer supported. Update to ${v.min_version} or later.` : "This version of Homerun is no longer supported. Update Homerun.";
}
