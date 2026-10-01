import { type AppAttestPolicy, type AttestedIdentity, attestedRole, type RemotePlatform, toB64url, verifyAttestation } from "@homerun/protocol";
import { log } from "../log";
import type { DeviceRow } from "./devices";

/**
 * A linking device's role (§9.8, §12). The desktop decides it, not the relay: a device that
 * says it is an iPhone gets the iPhone's authority only with an App Attest attestation for
 * the keys it is pairing with, verified here against Apple's root. Anything else is a browser.
 */

export type DeviceRole = Pick<DeviceRow, "platform" | "claimed_platform" | "attest_key" | "attest_counter" | "approval_key">;

export function deviceRole(
  claimed: RemotePlatform,
  attestation: unknown,
  identity: AttestedIdentity,
  policy: AppAttestPolicy,
  now: number,
): DeviceRole {
  const unattested: DeviceRole = { platform: "web", claimed_platform: claimed, attest_key: null, attest_counter: null, approval_key: null };
  if (claimed !== "ios") return unattested;
  if (attestation === undefined) {
    log.info("an iPhone without an App Attest attestation links as a browser");
    return unattested;
  }
  const r = verifyAttestation(attestation, identity, policy, now);
  if (!r.ok) {
    log.warn("an iPhone's App Attest attestation didn't verify; it links as a browser", { reason: r.reason });
    return unattested;
  }
  const approvalKey = (attestation as { approval_key?: string }).approval_key ?? null;
  return { platform: attestedRole(claimed, r), claimed_platform: claimed, attest_key: toB64url(r.credentialPublicKey), attest_counter: r.counter, approval_key: approvalKey };
}

/**
 * The role to pin, given the one the relay registered the device with (§18 row 102). The lower
 * of the two: an iPhone the relay didn't register as one links as a browser here too, since the
 * relay takes no push token or lock-screen answer from it. One the relay registered as an
 * iPhone but this desktop couldn't verify stays a browser; the relay accepts that downgrade.
 * Either way it pairs, with a browser's authority, rather than being refused.
 */
export function agreeWithRelay(role: DeviceRole, relay: string | null | undefined): DeviceRole {
  if (role.platform !== "ios" || relay == null || relay === "ios") return role;
  log.info("the relay registered this iPhone as a browser; it links as one", { relay });
  return { platform: "web", claimed_platform: role.claimed_platform, attest_key: null, attest_counter: null, approval_key: null };
}
