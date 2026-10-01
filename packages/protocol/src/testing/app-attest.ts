import { p256, p384 } from "@noble/curves/nist.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { concat, toB64url, utf8 } from "../bytes";
import { type AppAttestation, type AppAttestPolicy, attestationClientDataHash, type AttestedIdentity, IOS_APP_ID } from "../app-attest";

/**
 * A stand-in for Apple's App Attest service, for tests only (a separate `./testing` entry, never
 * exported from the package index): a P-384 root and intermediate like Apple's, P-256 credential
 * keys, and the same attestation and assertion encodings. Runtimes and relays under test trust its
 * root through `policy()`; nothing in production can.
 */

// ---------------------------------------------------------------- DER

function len(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const b: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return new Uint8Array([0x80 | b.length, ...b]);
}
const tlv = (tag: number, ...body: Uint8Array[]) => {
  const v = concat(...body);
  return concat(new Uint8Array([tag]), len(v.length), v);
};
const seq = (...b: Uint8Array[]) => tlv(0x30, ...b);
const set = (...b: Uint8Array[]) => tlv(0x31, ...b);
const oid = (s: string) => {
  const [a, b, ...rest] = s.split(".").map(Number);
  const out = [a! * 40 + b!];
  for (const n of rest) {
    const g: number[] = [n! & 0x7f];
    for (let v = Math.floor(n! / 128); v > 0; v = Math.floor(v / 128)) g.unshift(0x80 | (v & 0x7f));
    out.push(...g);
  }
  return tlv(0x06, new Uint8Array(out));
};
const int = (n: number) => tlv(0x02, new Uint8Array([n]));
const octet = (b: Uint8Array) => tlv(0x04, b);
const bits = (b: Uint8Array) => tlv(0x03, new Uint8Array([0]), b);
const bool = (v: boolean) => tlv(0x01, new Uint8Array([v ? 0xff : 0]));
const explicit = (n: number, b: Uint8Array) => tlv(0xa0 | n, b);
const gtime = (ms: number) => tlv(0x18, utf8(new Date(ms).toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}/, "")));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, utf8(cn)))));

type Curve = "p256" | "p384";
const ECDSA = { p256, p384 };
const CURVE_OID = { p256: "1.2.840.10045.3.1.7", p384: "1.3.132.0.34" };
const SIG = { p256: { oid: "1.2.840.10045.4.3.2", hash: sha256 }, p384: { oid: "1.2.840.10045.4.3.3", hash: sha384 } };

export interface TestIssuer {
  name: string;
  curve: Curve;
  sk: Uint8Array;
}

function cert(o: {
  issuer: TestIssuer;
  subject: string;
  curve: Curve;
  publicKey: Uint8Array;
  ca: boolean;
  notBefore: number;
  notAfter: number;
  extensions?: Uint8Array[];
}): Uint8Array {
  const sigAlg = seq(oid(SIG[o.issuer.curve].oid));
  const exts = [seq(oid("2.5.29.19"), bool(true), octet(seq(...(o.ca ? [bool(true)] : [])))), ...(o.extensions ?? [])];
  const tbs = seq(
    explicit(0, int(2)),
    int(1),
    sigAlg,
    name(o.issuer.name),
    seq(gtime(o.notBefore), gtime(o.notAfter)),
    name(o.subject),
    seq(seq(oid("1.2.840.10045.2.1"), oid(CURVE_OID[o.curve])), bits(o.publicKey)),
    explicit(3, seq(...exts)),
  );
  const sig = ECDSA[o.issuer.curve].sign(SIG[o.issuer.curve].hash(tbs), o.issuer.sk, { prehash: false, format: "der" });
  return seq(tbs, sigAlg, bits(sig));
}

// ---------------------------------------------------------------- CBOR

type C = Uint8Array | string | number | C[] | { map: [string, C][] };
function head(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
function cbor(v: C): Uint8Array {
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (typeof v === "string") return concat(head(3, utf8(v).length), utf8(v));
  if (typeof v === "number") return head(0, v);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map(cbor));
  return concat(head(5, v.map.length), ...v.map.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

// ---------------------------------------------------------------- the fake service

function seededKey(label: string, curve: Curve): Uint8Array {
  // A deterministic valid scalar: hash the label, retrying until it's in range.
  for (let i = 0; ; i++) {
    const k = curve === "p256" ? sha256(utf8(`${label}/${i}`)) : sha384(utf8(`${label}/${i}`));
    if (ECDSA[curve].utils.isValidSecretKey(k)) return k;
  }
}

const YEAR = 365 * 24 * 60 * 60 * 1000;
const FROM = Date.UTC(2020, 0, 1);

export interface AttestOptions {
  approvalKey?: string;
  environment?: "production" | "development" | "bogus";
  appId?: string;
  counter?: number;
  fmt?: string;
  /** Put a different key id in the wire object than the credential's hash. */
  keyId?: Uint8Array;
  /** Put a different credential id in the authenticator data. */
  credentialId?: Uint8Array;
  /** Bind the nonce to a different identity. */
  nonceFor?: import("../app-attest").AttestedIdentity;
  /** Issue the leaf from another CA's intermediate. */
  issuer?: TestAppAttestCA;
  validity?: { notBefore: number; notAfter: number };
  /** A fixed credential key (the default is derived from a per-CA counter). */
  credentialSecretKey?: Uint8Array;
}

export interface TestCredential {
  attestation: AppAttestation;
  credentialSecretKey: Uint8Array;
  credentialPublicKey: Uint8Array;
}

export interface TestAppAttestCA {
  readonly root: Uint8Array;
  readonly intermediate: Uint8Array;
  readonly intermediateIssuer: TestIssuer;
  policy(allowDevelopment?: boolean): AppAttestPolicy;
  attest(identity: AttestedIdentity, o?: AttestOptions): TestCredential;
}

export function testAppAttestCA(label = "homerun-test-app-attest"): TestAppAttestCA {
  const rootIssuer: TestIssuer = { name: `${label} Root CA`, curve: "p384", sk: seededKey(`${label}/root`, "p384") };
  const interIssuer: TestIssuer = { name: `${label} CA 1`, curve: "p384", sk: seededKey(`${label}/intermediate`, "p384") };
  let issued = 0;
  const root = cert({
    issuer: rootIssuer,
    subject: rootIssuer.name,
    curve: "p384",
    publicKey: p384.getPublicKey(rootIssuer.sk, false),
    ca: true,
    notBefore: FROM,
    notAfter: FROM + 40 * YEAR,
  });
  const intermediate = cert({
    issuer: rootIssuer,
    subject: interIssuer.name,
    curve: "p384",
    publicKey: p384.getPublicKey(interIssuer.sk, false),
    ca: true,
    notBefore: FROM,
    notAfter: FROM + 35 * YEAR,
  });
  const ca: TestAppAttestCA = {
    root,
    intermediate,
    intermediateIssuer: interIssuer,
    policy: (allowDevelopment = false) => ({ appId: IOS_APP_ID, allowDevelopment, roots: [root] }),
    attest(identity, o = {}) {
      const issuerCa = o.issuer ?? ca;
      const credentialSecretKey = o.credentialSecretKey ?? seededKey(`${label}/credential/${issued++}/${identity.device_id}`, "p256");
      const credentialPublicKey = p256.getPublicKey(credentialSecretKey, false);
      const keyId = sha256(credentialPublicKey);
      const aaguid =
        o.environment === "development"
          ? utf8("appattestdevelop")
          : o.environment === "bogus"
            ? utf8("notappattest0000")
            : concat(utf8("appattest"), new Uint8Array(7));
      const credId = o.credentialId ?? keyId;
      const n = o.counter ?? 0;
      const authData = concat(
        sha256(utf8(o.appId ?? IOS_APP_ID)),
        new Uint8Array([0x40, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]),
        aaguid,
        new Uint8Array([credId.length >> 8, credId.length & 0xff]),
        credId,
        cbor({ map: [["kty", 2]] }),
      );
      const nonce = sha256(concat(authData, attestationClientDataHash(o.nonceFor ?? identity, o.approvalKey)));
      const leaf = cert({
        issuer: issuerCa.intermediateIssuer,
        subject: toB64url(keyId),
        curve: "p256",
        publicKey: credentialPublicKey,
        ca: false,
        notBefore: o.validity?.notBefore ?? FROM,
        notAfter: o.validity?.notAfter ?? FROM + 30 * YEAR,
        extensions: [seq(oid("1.2.840.113635.100.8.2"), octet(seq(explicit(1, octet(nonce)))))],
      });
      const object = cbor({
        map: [
          ["fmt", o.fmt ?? "apple-appattest"],
          ["attStmt", { map: [["x5c", [leaf, issuerCa.intermediate]], ["receipt", new Uint8Array([1, 2, 3])]] }],
          ["authData", authData],
        ],
      });
      return {
        attestation: { key_id: toB64url(o.keyId ?? keyId), object: toB64url(object), ...(o.approvalKey ? { approval_key: o.approvalKey } : {}) },
        credentialSecretKey,
        credentialPublicKey,
      };
    },
  };
  return ca;
}

/** An assertion as `generateAssertion` makes it. */
export function testAssertion(credentialSecretKey: Uint8Array, clientDataHash: Uint8Array, count: number, appId = IOS_APP_ID): Uint8Array {
  const authenticatorData = concat(
    sha256(utf8(appId)),
    new Uint8Array([0x00, (count >>> 24) & 0xff, (count >> 16) & 0xff, (count >> 8) & 0xff, count & 0xff]),
  );
  const nonce = sha256(concat(authenticatorData, clientDataHash));
  const signature = p256.sign(nonce, credentialSecretKey, { prehash: true, format: "der" });
  return cbor({ map: [["signature", signature], ["authenticatorData", authenticatorData]] });
}
