import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { APPROVAL_PROOF_MAX_MS, CLOCK_SKEW_MS } from "@homerun/core";
import { framed, fromB64url, toB64url } from "./bytes";
import { hmacSha256 } from "./crypto";

/**
 * Face ID approvals (§9.8, §18). An iPhone that allows a destructive call signs the answer with
 * its Secure Enclave approval key, whose access control requires the current Face ID enrolment.
 * The desktop pinned that key only because an App Attest attestation bound it to the phone's
 * identity, so a valid signature proves a person looked at this phone and approved this request.
 * The relay can't forge it, and a stolen bearer token or device key can't produce it.
 *
 * The signature is ECDSA P-256 with SHA-256 over `approvalMessage` (what
 * `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` produces), DER, base64url.
 */

export const APPROVAL_LABEL = "homerun-approval-v1";
/** The App Attest `clientDataHash` domain for replacing an approval key. */
export const APPROVAL_RENEW_LABEL = "homerun-se-rekey-v1";

export interface ApprovalFields {
  /** The iPhone answering. */
  device_id: string;
  /** The desktop the request belongs to. */
  desktop_id: string;
  request_id: string;
  /** The approval's decision, or the ambiguous call's outcome (`approvalDecision`). */
  decision: string;
  expires_at: number;
}

export function approvalMessage(f: ApprovalFields): Uint8Array {
  return framed(APPROVAL_LABEL, f.device_id, f.desktop_id, f.request_id, f.decision, String(f.expires_at));
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: "malformed" | "signature" | "expired" | "too_long" };

/**
 * Checks a proof against the pinned approval key (65-byte uncompressed P-256, base64url). A bad
 * signature, key or DER is `signature`; `malformed` is only for bad base64url. The proof must
 * not have expired, may claim at most `APPROVAL_PROOF_MAX_MS` and must not outlive the request.
 * Never throws. Replays are harmless: the first answer to a request wins.
 */
export function checkApprovalProof(
  proof: { signature: string; expires_at: number },
  f: Omit<ApprovalFields, "expires_at">,
  approvalKey: string,
  o: { now: number; requestExpiresAt: number | null },
): ApprovalCheck {
  if (proof.expires_at + CLOCK_SKEW_MS < o.now) return { ok: false, reason: "expired" };
  if (proof.expires_at > o.now + APPROVAL_PROOF_MAX_MS + CLOCK_SKEW_MS) return { ok: false, reason: "too_long" };
  // The phone caps its expiry at the request's, which it got from the desktop: no skew here.
  if (o.requestExpiresAt !== null && proof.expires_at > o.requestExpiresAt) return { ok: false, reason: "too_long" };
  try {
    const sig = fromB64url(proof.signature);
    const key = fromB64url(approvalKey);
    const msg = approvalMessage({ ...f, expires_at: proof.expires_at });
    return p256.verify(sig, msg, key, { prehash: true, lowS: false, format: "der" }) ? { ok: true } : { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Signs an approval with a raw P-256 secret: tests and vectors only; phones sign in the Secure Enclave. */
export function signApprovalForTesting(secretKey: Uint8Array, f: ApprovalFields): string {
  return toB64url(p256.sign(approvalMessage(f), secretKey, { prehash: true, format: "der" }));
}

/** The `clientDataHash` of the App Attest assertion that vouches for a new approval key. */
export function approvalRenewalClientDataHash(deviceId: string, approvalKey: string): Uint8Array {
  return sha256(framed(APPROVAL_RENEW_LABEL, deviceId, fromB64url(approvalKey)));
}

// ---------------------------------------------------------------- collapse ids

export const COLLAPSE_LABEL = "homerun-collapse-v1";

/**
 * An APNs collapse id for the pushes about one request to one phone (§9.7), so a withdrawal
 * replaces the original in place. It is an HMAC under a secret only the desktop holds, so the
 * relay and Apple learn nothing from it but which pushes belong together. 16 bytes, base64url.
 */
export function collapseId(secret: Uint8Array, toDeviceId: string, requestId: string): string {
  return toB64url(hmacSha256(secret, framed(COLLAPSE_LABEL, toDeviceId, requestId)).subarray(0, 16));
}
