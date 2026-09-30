import { describe, expect, test } from "bun:test";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  APPLE_APP_ATTEST_ROOT_CA,
  appleAppAttestRootFingerprint,
  attestationClientDataHash,
  attestedRole,
  type AttestedIdentity,
  cborDecode,
  derRead,
  fromB64url,
  generateDeviceKeys,
  identityFromStored,
  productionAppAttestPolicy,
  publicOf,
  toB64url,
  toHex,
  utf8,
  verifyAssertion,
  verifyAttestation,
} from "../src";
import { testAppAttestCA, testAssertion } from "../src/testing/app-attest";

const NOW = Date.UTC(2030, 0, 1);
const ca = testAppAttestCA();
const other = testAppAttestCA("someone-else");

function identity(_label: string): AttestedIdentity {
  const p = publicOf(identityFromStored(crypto.randomUUID() as never, "ios", generateDeviceKeys()));
  return { device_id: p.device_id, static_public_key: p.static_public_key, signing_public_key: p.signing_public_key };
}
const approvalKey = toB64url(p256.getPublicKey(p256.utils.randomSecretKey(), false));

describe("App Attest attestation (§9.8)", () => {
  const me = identity("a");

  test("a genuine attestation verifies and yields the credential key", () => {
    const c = ca.attest(me, { approvalKey });
    const r = verifyAttestation(c.attestation, me, ca.policy(), NOW);
    expect(r).toMatchObject({ ok: true, environment: "production", counter: 0 });
    if (r.ok) expect(toHex(r.credentialPublicKey)).toBe(toHex(c.credentialPublicKey));
    expect(attestedRole("ios", r)).toBe("ios");
  });

  test("the approval key is bound: dropping or swapping it fails", () => {
    const c = ca.attest(me, { approvalKey });
    const { approval_key: _, ...without } = c.attestation;
    expect(verifyAttestation(without, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "nonce" });
    const swapped = { ...c.attestation, approval_key: toB64url(p256.getPublicKey(p256.utils.randomSecretKey(), false)) };
    expect(verifyAttestation(swapped, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "nonce" });
  });

  test("an attestation copied to another identity fails", () => {
    const c = ca.attest(me);
    expect(verifyAttestation(c.attestation, identity("b"), ca.policy(), NOW)).toEqual({ ok: false, reason: "nonce" });
    expect(verifyAttestation(ca.attest(me, { nonceFor: identity("c") }).attestation, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "nonce" });
  });

  test("every other check rejects", () => {
    const cases: [ReturnType<typeof ca.attest>["attestation"], string][] = [
      [other.attest(me).attestation, "chain"],
      [ca.attest(me, { issuer: other }).attestation, "chain"],
      [ca.attest(me, { fmt: "packed" }).attestation, "format"],
      [ca.attest(me, { appId: "NMJBY8WL8T.com.example.other" }).attestation, "rp_id"],
      [ca.attest(me, { counter: 1 }).attestation, "counter"],
      [ca.attest(me, { environment: "bogus" }).attestation, "environment"],
      [ca.attest(me, { environment: "development" }).attestation, "environment"],
      [ca.attest(me, { keyId: new Uint8Array(32) }).attestation, "key_id"],
      [ca.attest(me, { credentialId: new Uint8Array(32) }).attestation, "credential_id"],
      [ca.attest(me, { validity: { notBefore: Date.UTC(2020, 0, 1), notAfter: Date.UTC(2021, 0, 1) } }).attestation, "expired"],
    ];
    for (const [att, reason] of cases) expect(verifyAttestation(att, me, ca.policy(), NOW)).toEqual({ ok: false, reason: reason as never });
  });

  test("a development attestation is accepted only by a development policy", () => {
    const c = ca.attest(me, { environment: "development" });
    expect(verifyAttestation(c.attestation, me, ca.policy(true), NOW)).toMatchObject({ ok: true, environment: "development" });
  });

  test("garbage never throws", () => {
    const c = ca.attest(me);
    const bytes = fromB64url(c.attestation.object);
    for (const obj of [bytes.subarray(0, 40), bytes.subarray(0, bytes.length - 1), new Uint8Array([0xbf, 0xff]), new Uint8Array(0)]) {
      expect(verifyAttestation({ ...c.attestation, object: toB64url(obj) }, me, ca.policy(), NOW).ok).toBe(false);
    }
    const bad = toB64url(new Uint8Array([4, ...new Uint8Array(64)]));
    expect(verifyAttestation(ca.attest(me, { approvalKey: bad }).attestation, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyAttestation({ ...c.attestation, extra: 1 }, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyAttestation(null, me, ca.policy(), NOW)).toEqual({ ok: false, reason: "malformed" });
    // A byte flipped anywhere in the object fails, whatever the reason.
    for (let i = 0; i < bytes.length; i += 97) {
      const t = new Uint8Array(bytes);
      t[i] = t[i]! ^ 0x01;
      expect(verifyAttestation({ ...c.attestation, object: toB64url(t) }, me, ca.policy(), NOW).ok).toBe(false);
    }
  });

  test("the production policy trusts only Apple's pinned root", () => {
    expect(toHex(appleAppAttestRootFingerprint())).toBe("1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932");
    expect(derRead(Uint8Array.from(atob(APPLE_APP_ATTEST_ROOT_CA), (c) => c.charCodeAt(0))).tag).toBe(0x30);
    expect(verifyAttestation(ca.attest(me).attestation, me, productionAppAttestPolicy(true), NOW)).toEqual({ ok: false, reason: "chain" });
  });

  test("without a valid attestation, an iPhone claim is a web client", () => {
    expect(attestedRole("ios", null)).toBe("web");
    expect(attestedRole("ios", { ok: false, reason: "chain" })).toBe("web");
    expect(attestedRole("web", { ok: true, credentialPublicKey: new Uint8Array(65), environment: "production", counter: 0 })).toBe("web");
  });

  test("the client data hash is domain-separated and length-framed", () => {
    const h = attestationClientDataHash(me, undefined);
    expect(h.length).toBe(32);
    expect(toHex(h)).not.toBe(toHex(attestationClientDataHash(me, approvalKey)));
  });
});

describe("App Attest assertions", () => {
  const me = identity("d");
  const c = ca.attest(me);
  const cdh = sha256(utf8("homerun-se-rekey-v1 example"));
  const policy = ca.policy();

  test("verifies, and the counter must increase", () => {
    expect(verifyAssertion(testAssertion(c.credentialSecretKey, cdh, 1), cdh, c.credentialPublicKey, 0, policy)).toEqual({ ok: true, counter: 1 });
    expect(verifyAssertion(testAssertion(c.credentialSecretKey, cdh, 5), cdh, c.credentialPublicKey, 4, policy)).toEqual({ ok: true, counter: 5 });
    expect(verifyAssertion(testAssertion(c.credentialSecretKey, cdh, 4), cdh, c.credentialPublicKey, 4, policy)).toEqual({ ok: false, reason: "counter" });
  });

  test("the wrong key, data or app fails", () => {
    const other = ca.attest(me);
    expect(verifyAssertion(testAssertion(other.credentialSecretKey, cdh, 1), cdh, c.credentialPublicKey, 0, policy)).toEqual({ ok: false, reason: "signature" });
    expect(verifyAssertion(testAssertion(c.credentialSecretKey, cdh, 1), sha256(utf8("x")), c.credentialPublicKey, 0, policy)).toEqual({ ok: false, reason: "signature" });
    expect(verifyAssertion(testAssertion(c.credentialSecretKey, cdh, 1, "X.y"), cdh, c.credentialPublicKey, 0, policy)).toEqual({ ok: false, reason: "rp_id" });
    expect(verifyAssertion(new Uint8Array([1, 2, 3]), cdh, c.credentialPublicKey, 0, policy)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("CBOR", () => {
  test("rejects indefinite lengths, non-minimal integers, duplicates and trailing bytes", () => {
    expect(() => cborDecode(new Uint8Array([0x5f]))).toThrow();
    expect(() => cborDecode(new Uint8Array([0x18, 0x01]))).toThrow();
    expect(() => cborDecode(new Uint8Array([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02]))).toThrow();
    expect(() => cborDecode(new Uint8Array([0x01, 0x01]))).toThrow();
    expect(cborDecode(new Uint8Array([0xa1, 0x61, 0x61, 0x42, 0x01, 0x02]))).toEqual(new Map([["a", new Uint8Array([1, 2])]]));
  });
});
