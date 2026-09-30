/**
 * A minimal, strict CBOR (RFC 8949) decoder for the App Attest attestation and assertion objects
 * (§9.8). Definite lengths only; maps with text or integer keys; no tags, floats or
 * simple values other than true/false/null. Depth and size are bounded.
 */

export class CborError extends Error {
  override name = "CborError";
}

export type Cbor = number | bigint | string | Uint8Array | boolean | null | Cbor[] | CborMap;
export type CborMap = Map<string | number, Cbor>;

const MAX_DEPTH = 8;
const MAX_ITEMS = 1024;

export function cborDecode(buf: Uint8Array): Cbor {
  let at = 0;
  const byte = (): number => {
    if (at >= buf.length) throw new CborError("truncated");
    return buf[at++]!;
  };
  const arg = (info: number): number => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (n === 0) throw new CborError("indefinite or reserved length");
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + byte();
    if (!Number.isSafeInteger(v)) throw new CborError("integer too large");
    if ((n === 1 && v < 24) || (n > 1 && v < 256 ** (n / 2))) throw new CborError("non-minimal integer");
    return v;
  };
  const take = (n: number): Uint8Array => {
    if (at + n > buf.length) throw new CborError("truncated");
    const out = buf.subarray(at, at + n);
    at += n;
    return out;
  };
  const item = (depth: number): Cbor => {
    if (depth > MAX_DEPTH) throw new CborError("too deep");
    const ib = byte();
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2:
        return take(arg(info));
      case 3: {
        const b = take(arg(info));
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(b);
        } catch {
          throw new CborError("invalid utf-8");
        }
      }
      case 4: {
        const n = arg(info);
        if (n > MAX_ITEMS) throw new CborError("array too long");
        const out: Cbor[] = [];
        for (let i = 0; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = arg(info);
        if (n > MAX_ITEMS) throw new CborError("map too long");
        const m: CborMap = new Map();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          if (typeof k !== "string" && typeof k !== "number") throw new CborError("unsupported map key");
          if (m.has(k)) throw new CborError("duplicate map key");
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError("unsupported simple value");
      default:
        throw new CborError("tags are not supported");
    }
  };
  const out = item(0);
  if (at !== buf.length) throw new CborError("trailing bytes");
  return out;
}

export function cborMap(v: Cbor, what: string): CborMap {
  if (!(v instanceof Map)) throw new CborError(`${what} is not a map`);
  return v;
}

export function cborBytes(v: Cbor | undefined, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new CborError(`${what} is not a byte string`);
  return v;
}
