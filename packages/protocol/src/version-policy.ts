import { z } from "zod";
import { VERSION_POLICY_MAX_BYTES, VersionPolicy } from "@homerun/core";
import { framed, fromB64url, toB64url } from "./bytes";
import { ed25519Verify, type SigningKey } from "./crypto";

/**
 * The signed version policy (§11 "Updates and control"). The policy is signed offline with an
 * Ed25519 key whose public half is compiled into the runtime and every client
 * (`VERSION_POLICY_KEYS`), so a compromised relay or CDN can serve old policies but can't forge a
 * kill or a minimum. Replay is bounded by the body's `issued_at` (clients keep the newest they
 * have seen) and `expires_at` (at most 90 days).
 *
 * The signature covers the body's exact bytes, carried as a string: no JSON canonicalization for
 * another implementation to get wrong. The key id is signed too, so a body can't be moved to a key
 * it wasn't signed for.
 */

export const VERSION_POLICY_LABEL = "homerun/version-policy/v1";

export const PolicyKeyId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/);

export const SignedVersionPolicy = z.strictObject({
  /** A serialized `VersionPolicy`, exactly as signed. */
  body: z.string().min(2).max(VERSION_POLICY_MAX_BYTES),
  key_id: PolicyKeyId,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
export type SignedVersionPolicy = z.infer<typeof SignedVersionPolicy>;

/** Trusted policy keys: key id → base64url Ed25519 public key. */
export type VersionPolicyKeys = Readonly<Record<string, string>>;

/**
 * The production policy keys, compiled into the runtime and the clients. Empty until the release
 * owner generates the offline key (`scripts/release/sign-policy.ts keygen`) and adds its public
 * half here; with no key, no policy verifies and every client fails open. Keep a retired key here
 * until every policy it signed has expired.
 */
export const VERSION_POLICY_KEYS: VersionPolicyKeys = Object.freeze({});

export function versionPolicyBytes(keyId: string, body: string): Uint8Array {
  return framed(VERSION_POLICY_LABEL, keyId, body);
}

/** Signs `policy` (validated first) with `key`. The body is the policy's compact JSON. */
export async function signVersionPolicy(policy: VersionPolicy, keyId: string, key: SigningKey): Promise<SignedVersionPolicy> {
  const body = JSON.stringify(VersionPolicy.parse(policy));
  PolicyKeyId.parse(keyId);
  return { body, key_id: keyId, signature: toB64url(await key.sign(versionPolicyBytes(keyId, body))) };
}

/**
 * The policy inside `raw` if it is well formed, signed by one of `keys`, and its body is a valid
 * policy; otherwise null. Does not check expiry: `evaluateVersionPolicy` does, so an expired
 * policy fails open there.
 */
export function verifySignedVersionPolicy(raw: unknown, keys: VersionPolicyKeys): VersionPolicy | null {
  const s = SignedVersionPolicy.safeParse(raw);
  if (!s.success || !Object.hasOwn(keys, s.data.key_id)) return null;
  try {
    if (!ed25519Verify(fromB64url(s.data.signature), versionPolicyBytes(s.data.key_id, s.data.body), fromB64url(keys[s.data.key_id]!))) return null;
    const p = VersionPolicy.safeParse(JSON.parse(s.data.body));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
