import { bytesToUtf8, concatBytes, equalBytes, utf8ToBytes } from "@noble/ciphers/utils.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** Byte helpers. Encoding only: every cryptographic operation lives in `crypto.ts`. */

export { bytesToHex as toHex, hexToBytes as fromHex, concatBytes as concat, equalBytes as constantTimeEqual };
export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
export const fromUtf8 = (b: Uint8Array): string => bytesToUtf8(b);

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_INDEX = new Map([...B64URL].map((c, i) => [c, i]));

/** base64url without padding (RFC 4648 §5). */
export function toB64url(b: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]! + B64URL[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]!;
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    out += B64URL[(n >> 18) & 63]! + B64URL[(n >> 12) & 63]! + B64URL[(n >> 6) & 63]!;
  }
  return out;
}

/** Strict base64url decoding: no padding, no other alphabet, canonical trailing bits. */
export function fromB64url(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error("invalid base64url length");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const c of s) {
    const v = B64URL_INDEX.get(c);
    if (v === undefined) throw new Error("invalid base64url character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error("non-canonical base64url");
  return out;
}

/** Length-prefixed concatenation (u16 big-endian lengths), so fields can never run together. */
export function framed(...parts: (Uint8Array | string)[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    const b = typeof p === "string" ? utf8(p) : p;
    if (b.length > 0xffff) throw new Error("field too long");
    chunks.push(new Uint8Array([b.length >> 8, b.length & 0xff]), b);
  }
  return concatBytes(...chunks);
}

/** A 64-bit unsigned big-endian integer from a JS number (up to 2^53). */
export function u64be(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("u64 out of range");
  const out = new Uint8Array(8);
  let hi = Math.floor(n / 2 ** 32);
  let lo = n >>> 0;
  for (let i = 7; i >= 4; i--) {
    out[i] = lo & 0xff;
    lo >>>= 8;
  }
  for (let i = 3; i >= 0; i--) {
    out[i] = hi & 0xff;
    hi >>>= 8;
  }
  return out;
}
