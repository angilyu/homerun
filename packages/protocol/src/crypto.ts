import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils.js";

/**
 * The only primitives Homerun uses (§9.4, §18): X25519, ChaCha20-Poly1305 (IETF, 96-bit nonce),
 * SHA-256 and HMAC-SHA-256 from the audited @noble libraries, and Ed25519 for signatures. Nothing
 * below this line is implemented here; everything above it (Noise, envelopes) is built on these.
 */

export const DH_LEN = 32;
export const HASH_LEN = 32;
export const TAG_LEN = 16;

/** A source of randomness. Injected everywhere so vectors can be generated deterministically. */
export type Random = (n: number) => Uint8Array;
export const systemRandom: Random = (n) => nobleRandomBytes(n);

export class CryptoError extends Error {
  override name = "CryptoError";
}

// ---------------------------------------------------------------- X25519

/**
 * A static or ephemeral X25519 key held by the caller. `dh` is an async callback so a client can
 * keep the private half somewhere we can't read (a non-extractable WebCrypto key, the iOS
 * Keychain behind a native module). An implementation must reject low-order peer keys the way
 * `x25519Dh` does.
 */
export interface DhKey {
  readonly publicKey: Uint8Array;
  dh(theirPublic: Uint8Array): Promise<Uint8Array>;
}

export function x25519Public(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey);
}

/** X25519. Rejects low-order peer keys (an all-zero shared secret). */
export function x25519Dh(secretKey: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  if (theirPublic.length !== DH_LEN) throw new CryptoError("bad public key length");
  let out: Uint8Array;
  try {
    out = x25519.getSharedSecret(secretKey, theirPublic);
  } catch {
    throw new CryptoError("invalid public key");
  }
  if (out.every((b) => b === 0)) throw new CryptoError("invalid public key");
  return out;
}

/** An in-memory X25519 key. */
export function x25519Key(secretKey: Uint8Array): DhKey & { readonly secretKey: Uint8Array } {
  if (secretKey.length !== DH_LEN) throw new CryptoError("bad secret key length");
  const publicKey = x25519Public(secretKey);
  return { secretKey, publicKey, dh: async (pub) => x25519Dh(secretKey, pub) };
}

export function generateX25519(random: Random = systemRandom) {
  return x25519Key(random(DH_LEN));
}

// ---------------------------------------------------------------- ChaCha20-Poly1305

/** Noise's nonce: 32 bits of zeros, then the 64-bit counter little-endian (Noise §12.4). */
function noiseNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  let v = n;
  for (let i = 4; i < 12; i++) {
    nonce[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return nonce;
}

export function aeadEncrypt(key: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return chacha20poly1305(key, noiseNonce(n), ad).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  try {
    return chacha20poly1305(key, noiseNonce(n), ad).decrypt(ciphertext);
  } catch {
    throw new CryptoError("decryption failed");
  }
}

// ---------------------------------------------------------------- SHA-256, HMAC, HKDF

export function hash(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

/** Noise's HKDF (Noise §4.3): two or three 32-byte outputs from a chaining key. */
export function noiseHkdf(ck: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmacSha256(ck, ikm);
  const o1 = hmacSha256(tempKey, Uint8Array.of(1));
  const o2 = hmacSha256(tempKey, concat2(o1, Uint8Array.of(2)));
  if (outputs === 2) return [o1, o2];
  return [o1, o2, hmacSha256(tempKey, concat2(o2, Uint8Array.of(3)))];
}

function concat2(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ---------------------------------------------------------------- Ed25519

/** An Ed25519 key held by the caller; async for the same reason as `DhKey`. */
export interface SigningKey {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export function ed25519Key(secretKey: Uint8Array): SigningKey & { readonly secretKey: Uint8Array } {
  if (secretKey.length !== 32) throw new CryptoError("bad signing key length");
  const publicKey = ed25519.getPublicKey(secretKey);
  return { secretKey, publicKey, sign: async (m) => ed25519.sign(m, secretKey) };
}

export function generateEd25519(random: Random = systemRandom) {
  return ed25519Key(random(32));
}

/** Strict verification (RFC 8032 with noble's cofactorless, non-malleable checks). */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}
