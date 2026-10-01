import { type ApprovalProof, approvalDecision, type InputRequest, type InputResponse, needsApprovalProof } from "@homerun/core";
import { checkApprovalProof } from "@homerun/protocol";
import { log } from "../log";
import type { DeviceRow } from "./devices";

/**
 * Face ID approvals (§9.8, §18 row 115). An iPhone may allow a destructive call only with a
 * signature from the Secure Enclave key it bound into its App Attest attestation, which only
 * Face ID unlocks. A stolen, unlocked phone, or a relay pretending to be one, can't make it.
 * Without a pinned key the phone can still deny; allowing is the Mac's.
 *
 * Returns why the answer is refused, or null when it may go ahead.
 */
export function approvalRefusal(
  device: DeviceRow | null,
  desktopId: string,
  request: InputRequest,
  response: InputResponse,
  proof: ApprovalProof | undefined,
  now: number,
): string | null {
  if (!needsApprovalProof(request.prompt, response)) return null;
  if (!device?.approval_key || device.platform !== "ios") return "Approve on your Mac: this iPhone can't confirm destructive actions with Face ID.";
  if (!proof) return "Confirm with Face ID to approve this.";
  const r = checkApprovalProof(
    proof,
    { device_id: device.device_id, desktop_id: desktopId, request_id: request.request_id, decision: approvalDecision(response)! },
    device.approval_key,
    { now, requestExpiresAt: request.expires_at },
  );
  if (r.ok) return null;
  log.warn("a Face ID approval didn't verify", { device_id: device.device_id, reason: r.reason });
  return r.reason === "expired" || r.reason === "too_long" ? "That Face ID confirmation expired. Try again." : "Approve on your Mac: the Face ID confirmation didn't verify.";
}
