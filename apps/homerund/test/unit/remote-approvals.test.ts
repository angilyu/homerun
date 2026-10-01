import { describe, expect, test } from "bun:test";
import type { InputRequest, InputResponse } from "@homerun/core";
import { testApprovalKey } from "@homerun/protocol/testing";
import { approvalRefusal } from "../../src/remote/approvals";
import type { DeviceRow } from "../../src/remote/devices";

/** Face ID approvals (§18 row 115): what the runtime accepts from an iPhone. The e2e suite covers the wiring. */

const key = testApprovalKey();
const NOW = 1_800_000_000_000;
const phone = (o: Partial<DeviceRow> = {}): DeviceRow => ({
  device_id: "11111111-1111-4111-8111-111111111111",
  name: "iPhone",
  platform: "ios",
  claimed_platform: "ios",
  method: "qr",
  static_public_key: "",
  signing_public_key: "",
  paired_at: 0,
  last_seen_at: null,
  attest_key: "k",
  attest_counter: 0,
  approval_key: key.publicKey,
  ...o,
});
const DESKTOP = "22222222-2222-4222-8222-222222222222";
const request = (cls: string, type = "approval", expires_at: number | null = NOW + 3_600_000) =>
  ({ request_id: "33333333-3333-4333-8333-333333333333", prompt: { type, class: cls }, expires_at }) as unknown as InputRequest;
const allow: InputResponse = { type: "approval", decision: "allow" } as InputResponse;
const proof = (o: { decision?: string; expires_at?: number; signer?: typeof key; desktop?: string } = {}) => {
  const expires_at = o.expires_at ?? NOW + 60_000;
  const signature = (o.signer ?? key).sign({
    device_id: phone().device_id,
    desktop_id: o.desktop ?? DESKTOP,
    request_id: request("destructive").request_id,
    decision: o.decision ?? "allow",
    expires_at,
  });
  return { signature, expires_at };
};
const check = (o: { device?: DeviceRow | null; req?: InputRequest; response?: InputResponse; p?: ReturnType<typeof proof> } = {}) =>
  approvalRefusal(o.device === undefined ? phone() : o.device, DESKTOP, o.req ?? request("destructive"), o.response ?? allow, o.p, NOW);

describe("approvalRefusal", () => {
  test("only allowing a destructive call needs a proof", () => {
    expect(check({ req: request("write") })).toBeNull();
    expect(check({ response: { type: "approval", decision: "deny" } as InputResponse })).toBeNull();
    expect(check({ req: request("destructive", "question") })).toBeNull();
    expect(check()).toContain("Confirm with Face ID");
    expect(check({ p: proof() })).toBeNull();
  });

  test("no pinned key, or not an iPhone: the Mac decides", () => {
    expect(check({ device: phone({ approval_key: null }), p: proof() })).toContain("Approve on your Mac");
    expect(check({ device: phone({ platform: "web" }), p: proof() })).toContain("Approve on your Mac");
    expect(check({ device: null, p: proof() })).toContain("Approve on your Mac");
  });

  test("another key, decision or desktop doesn't verify; a stale or too long-lived proof has expired", () => {
    expect(check({ p: proof({ signer: testApprovalKey() }) })).toContain("didn't verify");
    expect(check({ p: proof({ decision: "allow_always" }) })).toContain("didn't verify");
    expect(check({ p: proof({ desktop: phone().device_id }) })).toContain("didn't verify");
    expect(check({ p: proof({ expires_at: NOW - 10 * 60_000 }) })).toContain("expired");
    expect(check({ p: proof({ expires_at: NOW + 60 * 60_000 }) })).toContain("expired");
    expect(check({ req: request("destructive", "approval", NOW + 30_000), p: proof({ expires_at: NOW + 60_000 }) })).toContain("expired");
  });
});
