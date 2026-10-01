import { p256, p384 } from "@noble/curves/nist.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { z } from "zod";
import { DeviceId, StaticPublicKey } from "@homerun/core";
import { concat, constantTimeEqual, framed, fromB64url, utf8 } from "./bytes";
import { cborBytes, cborDecode, cborMap } from "./cbor";
import { ctx, derBitString, derBoolean, derChildren, derOid, derRead, derTime, expectTag, TAG, type Tlv } from "./der";
import { SigningPublicKey } from "./identity";
import { type RemotePlatform } from "./statement";

/**
 * App Attest (§9.8, §13, §18): how an iPhone proves it runs the genuine Homerun app, so the
 * desktop can give it iPhone authority instead of the web client's reduced authority.
 *
 * The phone creates one App Attest key per attestation and calls `attestKey` with a
 * `clientDataHash` that binds the device's Homerun identity (its id, Noise and signing keys and
 * its Face ID approval key). The attestation travels inside the Noise-encrypted pairing hello or
 * linking info, so the relay can neither strip nor forge it; the desktop verifies it and pins the
 * role. The relay verifies the same object at registration for its own routing (push tokens,
 * lock-screen answers), never for security. A copied attestation is useless: it vouches only for
 * the victim's public keys, and Noise proves possession of the static key.
 *
 * Verification follows Apple's "Validating apps that connect to your server". Everything is
 * synchronous and pure; the caller supplies the time.
 */

export const APPLE_TEAM_ID = "NMJBY8WL8T";
export const IOS_BUNDLE_ID = "com.angilyu.homerun.ios";
/** The App ID App Attest hashes into `rpIdHash`. */
export const IOS_APP_ID = `${APPLE_TEAM_ID}.${IOS_BUNDLE_ID}`;

export const APP_ATTEST_LABEL = "homerun-app-attest-v1";

/**
 * Apple App Attestation Root CA, DER, base64. From
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem; SHA-256
 * 1CB9823BA28BA6AD2D33A006941DE2AE4F513EF1D4E831B9F7E0FA7B6242C932 (checked in tests).
 */
export const APPLE_APP_ATTEST_ROOT_CA =
  "MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd/dganmrduC1bmTBGwD";

const b64url = (bytes: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));

/** An uncompressed P-256 public key (65 bytes), base64url. */
export const P256PublicKey = b64url(65);

/** What an iPhone sends with its pairing hello or linking info. */
export const AppAttestation = z.strictObject({
  /** The App Attest key identifier: SHA-256 of the credential public key. */
  key_id: b64url(32),
  /** The attestation object `attestKey` returned (CBOR), base64url. */
  object: z.string().regex(/^[A-Za-z0-9_-]+$/).max(16_384),
  /** The Secure Enclave, biometry-gated approval key (§9.8), if the phone could make one. */
  approval_key: P256PublicKey.optional(),
});
export type AppAttestation = z.infer<typeof AppAttestation>;

/** The identity an attestation vouches for. */
export const AttestedIdentity = z.object({
  device_id: DeviceId,
  static_public_key: StaticPublicKey,
  signing_public_key: SigningPublicKey,
});
export type AttestedIdentity = z.infer<typeof AttestedIdentity>;

/** The `clientDataHash` an iPhone passes to `attestKey` for its identity. */
export function attestationClientDataHash(id: AttestedIdentity, approvalKey: string | undefined): Uint8Array {
  return sha256(
    framed(
      APP_ATTEST_LABEL,
      id.device_id,
      fromB64url(id.static_public_key),
      fromB64url(id.signing_public_key),
      approvalKey ? fromB64url(approvalKey) : new Uint8Array(0),
    ),
  );
}

export interface AppAttestPolicy {
  /** `TeamID.BundleID`. */
  appId: string;
  /** Accept `appattestdevelop` (development-signed builds). Only a development runtime or relay does. */
  allowDevelopment: boolean;
  /** Trust anchors (DER). Defaults to Apple's root; tests pass their own. */
  roots?: Uint8Array[];
}

export const productionAppAttestPolicy = (allowDevelopment = false): AppAttestPolicy => ({ appId: IOS_APP_ID, allowDevelopment });

export type AttestationReason =
  | "malformed"
  | "format"
  | "chain"
  | "expired"
  | "nonce"
  | "key_id"
  | "rp_id"
  | "counter"
  | "environment"
  | "credential_id";

export type VerifiedAttestation = {
  ok: true;
  /** The App Attest credential public key (uncompressed P-256), for later assertions. */
  credentialPublicKey: Uint8Array;
  environment: "production" | "development";
  counter: number;
};

export type AttestationResult = VerifiedAttestation | { ok: false; reason: AttestationReason };

/** The role an attestation earns: `ios` only if it verifies; anything else is a web client (§9.9). */
export function attestedRole(claimed: RemotePlatform, r: AttestationResult | null): RemotePlatform {
  return claimed === "ios" && r?.ok ? "ios" : "web";
}

// ---------------------------------------------------------------- X.509

const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  basicConstraints: "2.5.29.19",
  appAttestNonce: "1.2.840.113635.100.8.2",
} as const;

interface Cert {
  tbs: Uint8Array;
  sigAlg: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  curve: "p256" | "p384";
  publicKey: Uint8Array;
  isCa: boolean;
  extensions: Map<string, Uint8Array>;
}

class AttestError extends Error {
  constructor(readonly reason: AttestationReason) {
    super(reason);
  }
}

function algId(t: Tlv | undefined): string {
  const [oid] = derChildren(expectTag(t, TAG.SEQUENCE, "algorithm"));
  return derOid(oid!);
}

function parseCert(der: Uint8Array): Cert {
  const [tbsT, sigAlgT, sigT, ...rest] = derChildren(derRead(der, TAG.SEQUENCE));
  if (rest.length) throw new AttestError("malformed");
  const tbs = derChildren(expectTag(tbsT, TAG.SEQUENCE, "tbsCertificate"));
  let i = 0;
  if (tbs[0]?.tag === ctx(0)) i++;
  i++; // serialNumber
  const innerAlg = algId(tbs[i++]);
  const issuer = expectTag(tbs[i++], TAG.SEQUENCE, "issuer").raw;
  const [nb, na] = derChildren(expectTag(tbs[i++], TAG.SEQUENCE, "validity"));
  const subject = expectTag(tbs[i++], TAG.SEQUENCE, "subject").raw;
  const [spkiAlg, spkiKey] = derChildren(expectTag(tbs[i++], TAG.SEQUENCE, "subjectPublicKeyInfo"));
  const [keyOid, curveOid] = derChildren(expectTag(spkiAlg, TAG.SEQUENCE, "key algorithm"));
  if (derOid(keyOid!) !== OID.ecPublicKey) throw new AttestError("chain");
  const curve = derOid(curveOid!) === OID.p256 ? "p256" : derOid(curveOid!) === OID.p384 ? "p384" : null;
  if (!curve) throw new AttestError("chain");
  const extensions = new Map<string, Uint8Array>();
  let isCa = false;
  for (; i < tbs.length; i++) {
    if (tbs[i]!.tag !== ctx(3)) continue;
    const [exts] = derChildren(tbs[i]!);
    for (const e of derChildren(expectTag(exts, TAG.SEQUENCE, "extensions"))) {
      const parts = derChildren(expectTag(e, TAG.SEQUENCE, "extension"));
      const oid = derOid(parts[0]!);
      const value = expectTag(parts[parts.length - 1], TAG.OCTET_STRING, "extension value").value;
      if (extensions.has(oid)) throw new AttestError("malformed");
      extensions.set(oid, value);
      if (oid === OID.basicConstraints) {
        const bc = derChildren(derRead(value, TAG.SEQUENCE));
        isCa = bc[0]?.tag === TAG.BOOLEAN ? derBoolean(bc[0]) : false;
      }
    }
  }
  const sigAlg = algId(sigAlgT);
  if (sigAlg !== innerAlg) throw new AttestError("malformed");
  return {
    tbs: tbsT!.raw,
    sigAlg,
    signature: derBitString(expectTag(sigT, TAG.BIT_STRING, "signature")),
    issuer,
    subject,
    notBefore: derTime(nb!),
    notAfter: derTime(na!),
    curve,
    publicKey: derBitString(spkiKey!),
    isCa,
    extensions,
  };
}

function signedBy(child: Cert, parent: Cert): boolean {
  if (!constantTimeEqual(child.issuer, parent.subject)) return false;
  const digest = child.sigAlg === OID.ecdsaSha256 ? sha256(child.tbs) : child.sigAlg === OID.ecdsaSha384 ? sha384(child.tbs) : null;
  if (!digest) return false;
  const ecdsa = parent.curve === "p256" ? p256 : p384;
  try {
    return ecdsa.verify(child.signature, digest, parent.publicKey, { prehash: false, lowS: false, format: "der" });
  } catch {
    return false;
  }
}

function decodeStdB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

let appleRoot: Uint8Array | null = null;
function roots(p: AppAttestPolicy): Uint8Array[] {
  return p.roots ?? [(appleRoot ??= decodeStdB64(APPLE_APP_ATTEST_ROOT_CA))];
}

/** The SHA-256 of the pinned Apple root, for tests and docs. */
export function appleAppAttestRootFingerprint(): Uint8Array {
  return sha256(roots(productionAppAttestPolicy())[0]!);
}

// ---------------------------------------------------------------- authenticator data

const AAGUID_PRODUCTION = concat(utf8("appattest"), new Uint8Array(7));
const AAGUID_DEVELOPMENT = utf8("appattestdevelop");

interface AuthData {
  rpIdHash: Uint8Array;
  counter: number;
  aaguid: Uint8Array | null;
  credentialId: Uint8Array | null;
}

function parseAuthData(a: Uint8Array, attested: boolean): AuthData {
  if (a.length < 37) throw new AttestError("malformed");
  const rpIdHash = a.subarray(0, 32);
  const counter = ((a[33]! << 24) >>> 0) + (a[34]! << 16) + (a[35]! << 8) + a[36]!;
  if (!attested) return { rpIdHash, counter, aaguid: null, credentialId: null };
  if (!(a[32]! & 0x40) || a.length < 55) throw new AttestError("malformed");
  const aaguid = a.subarray(37, 53);
  const idLen = (a[53]! << 8) + a[54]!;
  if (a.length < 55 + idLen) throw new AttestError("malformed");
  return { rpIdHash, counter, aaguid, credentialId: a.subarray(55, 55 + idLen) };
}

function nonceOf(ext: Uint8Array | undefined): Uint8Array {
  if (!ext) throw new AttestError("nonce");
  // SEQUENCE { [1] EXPLICIT OCTET STRING nonce }
  const seq = derChildren(derRead(ext, TAG.SEQUENCE));
  const tagged = seq.find((t) => t.tag === ctx(1));
  if (!tagged) throw new AttestError("nonce");
  const [oct] = derChildren(tagged);
  return expectTag(oct, TAG.OCTET_STRING, "nonce").value;
}

// ---------------------------------------------------------------- attestation

/**
 * Verifies an attestation for `identity` at time `now`. Returns the credential public key to pin
 * for assertions, or why it failed. Never throws.
 */
export function verifyAttestation(raw: unknown, identity: AttestedIdentity, policy: AppAttestPolicy, now: number): AttestationResult {
  const parsed = AppAttestation.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const att = parsed.data;
  try {
    if (att.approval_key && !validP256(fromB64url(att.approval_key))) throw new AttestError("malformed");
    const obj = cborMap(cborDecode(fromB64url(att.object)), "attestation");
    if (obj.get("fmt") !== "apple-appattest") throw new AttestError("format");
    const stmt = cborMap(obj.get("attStmt") ?? null, "attStmt");
    const authDataBytes = cborBytes(obj.get("authData"), "authData");
    const x5c = stmt.get("x5c");
    if (!Array.isArray(x5c) || x5c.length !== 2) throw new AttestError("chain");
    const [leaf, intermediate] = x5c.map((c) => parseCert(cborBytes(c, "certificate")));

    // 1. The chain: leaf ← intermediate ← a pinned root, all valid now.
    const anchors = roots(policy).map(parseCert);
    if (!intermediate!.isCa || leaf!.isCa || !signedBy(leaf!, intermediate!)) throw new AttestError("chain");
    const anchor = anchors.find((r) => signedBy(intermediate!, r));
    if (!anchor) throw new AttestError("chain");
    for (const c of [leaf!, intermediate!, anchor]) if (now < c.notBefore || now > c.notAfter) throw new AttestError("expired");
    if (leaf!.curve !== "p256" || leaf!.publicKey.length !== 65) throw new AttestError("chain");

    // 2–4. The nonce in the leaf is SHA-256(authData ‖ clientDataHash) for this identity.
    const clientDataHash = attestationClientDataHash(identity, att.approval_key);
    const nonce = sha256(concat(authDataBytes, clientDataHash));
    if (!constantTimeEqual(nonceOf(leaf!.extensions.get(OID.appAttestNonce)), nonce)) throw new AttestError("nonce");

    // 5. The key identifier is the hash of the credential public key.
    const keyId = fromB64url(att.key_id);
    if (!constantTimeEqual(sha256(leaf!.publicKey), keyId)) throw new AttestError("key_id");

    // 6–9. The authenticator data: our App ID, a fresh key, the right environment, this key.
    const ad = parseAuthData(authDataBytes, true);
    if (!constantTimeEqual(ad.rpIdHash, sha256(utf8(policy.appId)))) throw new AttestError("rp_id");
    if (ad.counter !== 0) throw new AttestError("counter");
    let environment: VerifiedAttestation["environment"];
    if (constantTimeEqual(ad.aaguid!, AAGUID_PRODUCTION)) environment = "production";
    else if (policy.allowDevelopment && constantTimeEqual(ad.aaguid!, AAGUID_DEVELOPMENT)) environment = "development";
    else throw new AttestError("environment");
    if (!constantTimeEqual(ad.credentialId!, keyId)) throw new AttestError("credential_id");

    return { ok: true, credentialPublicKey: new Uint8Array(leaf!.publicKey), environment, counter: 0 };
  } catch (e) {
    return { ok: false, reason: e instanceof AttestError ? e.reason : "malformed" };
  }
}

function validP256(key: Uint8Array): boolean {
  try {
    return key.length === 65 && key[0] === 0x04 && !p256.Point.fromBytes(key).is0();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- assertions

export type AssertionResult = { ok: true; counter: number } | { ok: false; reason: "malformed" | "rp_id" | "signature" | "counter" };

/**
 * Verifies an App Attest assertion (`generateAssertion`) over `clientDataHash` with a pinned
 * credential key. The counter must be strictly greater than `lastCounter`; the caller stores the
 * returned one. Never throws.
 */
export function verifyAssertion(
  assertion: Uint8Array,
  clientDataHash: Uint8Array,
  credentialPublicKey: Uint8Array,
  lastCounter: number,
  policy: Pick<AppAttestPolicy, "appId">,
): AssertionResult {
  try {
    const m = cborMap(cborDecode(assertion), "assertion");
    const signature = cborBytes(m.get("signature"), "signature");
    const authData = cborBytes(m.get("authenticatorData"), "authenticatorData");
    const ad = parseAuthData(authData, false);
    const nonce = sha256(concat(authData, clientDataHash));
    // ECDSA-SHA256 over the nonce (so the curve signs SHA-256(nonce)), as `generateAssertion` does.
    if (!p256.verify(signature, nonce, credentialPublicKey, { prehash: true, lowS: false, format: "der" })) return { ok: false, reason: "signature" };
    if (!constantTimeEqual(ad.rpIdHash, sha256(utf8(policy.appId)))) return { ok: false, reason: "rp_id" };
    if (ad.counter <= lastCounter) return { ok: false, reason: "counter" };
    return { ok: true, counter: ad.counter };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
