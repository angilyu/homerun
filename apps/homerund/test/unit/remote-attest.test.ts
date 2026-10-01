import { describe, expect, test } from "bun:test";
import type { DeviceId } from "@homerun/core";
import { fromB64url, generateDeviceKeys, identityFromStored, productionAppAttestPolicy, publicOf, toB64url } from "@homerun/protocol";
import { testAppAttestCA } from "@homerun/protocol/testing";
import { type DeviceRole, deviceRole } from "../../src/remote/attest";

const ca = testAppAttestCA();
const now = Date.now();

function keys() {
  const id = identityFromStored(crypto.randomUUID() as DeviceId, "ios", generateDeviceKeys());
  const p = publicOf(id);
  return { device_id: id.deviceId, static_public_key: p.static_public_key, signing_public_key: p.signing_public_key };
}

describe("a linking device's role (§9.8, §12)", () => {
  test("an iPhone with a valid attestation of its keys is an iPhone, with its credential and approval keys", () => {
    const k = keys();
    const approval = toB64url(ca.attest(keys()).credentialPublicKey);
    const cred = ca.attest(k, { approvalKey: approval });
    const r = deviceRole("ios", cred.attestation, k, ca.policy(), now);
    expect(r).toMatchObject({ platform: "ios", claimed_platform: "ios", attest_counter: 0 });
    expect(fromB64url(r.attest_key!)).toEqual(cred.credentialPublicKey);
    expect(r.approval_key).toBe(approval);
  });

  test("anything less is a browser that said it was an iPhone", () => {
    const k = keys();
    const unattested: DeviceRole = { platform: "web", claimed_platform: "ios", attest_key: null, attest_counter: null, approval_key: null };
    expect(deviceRole("ios", undefined, k, ca.policy(), now)).toEqual(unattested);
    // Another device's attestation, Apple's root (not the test CA), development keys, garbage.
    expect(deviceRole("ios", ca.attest(keys()).attestation, k, ca.policy(), now)).toEqual(unattested);
    expect(deviceRole("ios", ca.attest(k).attestation, k, productionAppAttestPolicy(true), now)).toEqual(unattested);
    expect(deviceRole("ios", ca.attest(k, { environment: "development" }).attestation, k, ca.policy(false), now)).toEqual(unattested);
    expect(deviceRole("ios", { key_id: "x" }, k, ca.policy(), now)).toEqual(unattested);
    expect(deviceRole("ios", ca.attest(k, { environment: "development" }).attestation, k, ca.policy(true), now).platform).toBe("ios");
  });

  test("a browser stays a browser, attested or not", () => {
    const k = keys();
    expect(deviceRole("web", ca.attest(k).attestation, k, ca.policy(), now)).toMatchObject({ platform: "web", claimed_platform: "web", attest_key: null });
  });
});
