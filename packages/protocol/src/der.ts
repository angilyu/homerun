/**
 * A minimal, strict DER reader: just enough X.509 for App Attest (§9.8, §18). Definite lengths
 * only, minimal length encoding, no trailing bytes. Anything unexpected throws a `DerError`.
 */

export class DerError extends Error {
  override name = "DerError";
}

export interface Tlv {
  /** The identifier octet (class, constructed bit and tag number; tag numbers < 31 only). */
  tag: number;
  /** The whole element, header included (what a signature covers). */
  raw: Uint8Array;
  /** The contents octets. */
  value: Uint8Array;
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Context-specific tag `[n]`, constructed. */
export const ctx = (n: number): number => 0xa0 | n;

function readOne(buf: Uint8Array, at: number): { tlv: Tlv; next: number } {
  if (at + 2 > buf.length) throw new DerError("truncated");
  const tag = buf[at]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
  let len = buf[at + 1]!;
  let p = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new DerError("indefinite length");
    if (n > 3) throw new DerError("length too large");
    if (p + n > buf.length) throw new DerError("truncated");
    if (buf[p] === 0) throw new DerError("non-minimal length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    if (len < 0x80) throw new DerError("non-minimal length");
    p += n;
  }
  if (p + len > buf.length) throw new DerError("truncated");
  return { tlv: { tag, raw: buf.subarray(at, p + len), value: buf.subarray(p, p + len) }, next: p + len };
}

/** Parses exactly one element filling `buf`. */
export function derRead(buf: Uint8Array, tag?: number): Tlv {
  const { tlv, next } = readOne(buf, 0);
  if (next !== buf.length) throw new DerError("trailing bytes");
  if (tag !== undefined && tlv.tag !== tag) throw new DerError(`expected tag 0x${tag.toString(16)}`);
  return tlv;
}

/** The children of a constructed element. */
export function derChildren(t: Tlv): Tlv[] {
  if (!(t.tag & 0x20)) throw new DerError("not a constructed element");
  const out: Tlv[] = [];
  let at = 0;
  while (at < t.value.length) {
    const r = readOne(t.value, at);
    out.push(r.tlv);
    at = r.next;
  }
  return out;
}

export function expectTag(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`bad ${what}`);
  return t;
}

/** Dotted-decimal form of an OBJECT IDENTIFIER. */
export function derOid(t: Tlv): string {
  expectTag(t, TAG.OID, "object identifier");
  const v = t.value;
  if (v.length === 0) throw new DerError("empty oid");
  const parts: number[] = [];
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    const b = v[i]!;
    if (n === 0 && b === 0x80) throw new DerError("non-minimal oid");
    n = n * 128 + (b & 0x7f);
    if (n > Number.MAX_SAFE_INTEGER / 128) throw new DerError("oid arc too large");
    if (!(b & 0x80)) {
      parts.push(n);
      n = 0;
    } else if (i === v.length - 1) throw new DerError("truncated oid");
  }
  const first = parts.shift()!;
  const a = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [a, first - a * 40, ...parts].join(".");
}

/** The contents of a BIT STRING with no unused bits. */
export function derBitString(t: Tlv): Uint8Array {
  expectTag(t, TAG.BIT_STRING, "bit string");
  if (t.value.length < 1 || t.value[0] !== 0) throw new DerError("bit string with unused bits");
  return t.value.subarray(1);
}

/** UTCTime or GeneralizedTime (whole seconds, `Z`) as milliseconds since the epoch. */
export function derTime(t: Tlv): number {
  const s = new TextDecoder().decode(t.value);
  let m: RegExpMatchArray | null;
  let year: number;
  if (t.tag === TAG.UTC_TIME) {
    m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new DerError("bad UTCTime");
    const yy = Number(m[1]);
    year = yy < 50 ? 2000 + yy : 1900 + yy;
  } else if (t.tag === TAG.GENERALIZED_TIME) {
    m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new DerError("bad GeneralizedTime");
    year = Number(m[1]);
  } else throw new DerError("bad time");
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export function derBoolean(t: Tlv): boolean {
  expectTag(t, TAG.BOOLEAN, "boolean");
  if (t.value.length !== 1 || (t.value[0] !== 0 && t.value[0] !== 0xff)) throw new DerError("bad boolean");
  return t.value[0] === 0xff;
}
