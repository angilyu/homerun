/**
 * Security descriptors, as data: what the runtime puts on its pipe and directories, and the checks
 * the runtime and the CLI apply to what they read back (docs/design.md §5.2). Pure, so the rules
 * are tested on every OS; `security.ts` reads the real thing on Windows.
 */

/** Well-known SIDs. */
export const SID = {
  SYSTEM: "S-1-5-18",
  ADMINISTRATORS: "S-1-5-32-544",
  NETWORK: "S-1-5-2",
  EVERYONE: "S-1-1-0",
  ANONYMOUS: "S-1-5-7",
} as const;

export const ACE_ALLOW = 0;
export const ACE_DENY = 1;
/** ACE flags: inherited by files and by subdirectories. */
export const OBJECT_INHERIT = 0x1;
export const CONTAINER_INHERIT = 0x2;
export const INHERIT_ONLY = 0x8;

export interface Ace {
  /** `ACE_ALLOW`, `ACE_DENY`, or another ACE type (audit, object, callback…). */
  type: number;
  flags: number;
  mask: number;
  sid: string;
}

export interface SecurityInfo {
  owner: string;
  /** Null: no DACL at all, which grants everyone everything. */
  dacl: { protected: boolean; aces: Ace[] } | null;
}

const sidOk = (s: string) => /^S-1-\d+(-\d+)+$/.test(s);

function requireSid(s: string): string {
  if (!sidOk(s)) throw new Error(`not a SID: ${JSON.stringify(s)}`);
  return s;
}

/**
 * The runtime's pipe (§5.2): protected; NETWORK denied first, so no SMB client gets in whoever it
 * authenticates as; then the user and SYSTEM, nobody else. Everyone and Anonymous lose the read
 * access the named-pipe file system gives them by default, and only the user can create further
 * instances.
 */
export function pipeSddl(user: string): string {
  return `D:P(D;;GA;;;${SID.NETWORK})(A;;GA;;;${requireSid(user)})(A;;GA;;;${SID.SYSTEM})`;
}

/** A private directory (the data dir, `run\`): protected, the user and SYSTEM, inherited by everything below. */
export function privateDirSddl(user: string): string {
  return `D:P(A;OICI;FA;;;${requireSid(user)})(A;OICI;FA;;;${SID.SYSTEM})`;
}

/** A private file: protected, the user and SYSTEM. */
export function privateFileSddl(user: string): string {
  return `D:P(A;;FA;;;${requireSid(user)})(A;;FA;;;${SID.SYSTEM})`;
}

/**
 * Why `info` is not private to `user`, or [] when it is. Owners the user can't be protected from
 * anyway are accepted: the user, SYSTEM, and Administrators (an elevated process may own what it
 * creates as Administrators). Every allow ACE must be for the user or SYSTEM, whatever its mask:
 * the check doesn't reason about which rights are harmless. Deny ACEs only take access away.
 * Unknown ACE types fail closed.
 *
 * `networkDeny`: a deny of all access to NETWORK must come before every allow (a pipe).
 * `protected`: the DACL must not inherit from its parent (a directory we locked down).
 */
export function privacyProblems(info: SecurityInfo, user: string, o: { networkDeny?: boolean; protected?: boolean } = {}): string[] {
  const problems: string[] = [];
  if (![user, SID.SYSTEM, SID.ADMINISTRATORS].includes(info.owner)) problems.push(`owned by ${info.owner}`);
  if (!info.dacl) return [...problems, "no DACL (everyone has full access)"];
  if (o.protected && !info.dacl.protected) problems.push("DACL not protected from inheritance");
  let allowSeen = false;
  let networkDenied = false;
  for (const a of info.dacl.aces) {
    if (a.type === ACE_DENY) {
      if (a.sid === SID.NETWORK && !allowSeen && !(a.flags & INHERIT_ONLY) && coversAll(a.mask)) networkDenied = true;
      continue;
    }
    if (a.type !== ACE_ALLOW) {
      problems.push(`unexpected ACE type ${a.type}${a.sid ? ` for ${a.sid}` : ""}`);
      continue;
    }
    allowSeen = true;
    if (a.sid !== user && a.sid !== SID.SYSTEM) problems.push(`allows ${a.sid} (0x${(a.mask >>> 0).toString(16)})`);
  }
  if (o.networkDeny && !networkDenied) problems.push("no deny for NETWORK ahead of the allows");
  return problems;
}

const GENERIC_ALL = 0x1000_0000;
const FILE_ALL_ACCESS = 0x001f_01ff;

/** Whether an access mask is everything: GENERIC_ALL, or FILE_ALL_ACCESS once mapped. */
export function coversAll(mask: number): boolean {
  const m = mask >>> 0;
  return (m & GENERIC_ALL) !== 0 || (m & FILE_ALL_ACCESS) === FILE_ALL_ACCESS;
}

/** `SECURITY_DESCRIPTOR_CONTROL`: the DACL does not inherit from the parent. */
export const SE_DACL_PROTECTED = 0x1000;

/**
 * The SID at `offset`, in string form (`S-1-5-21-…`). The layout: revision, sub-authority count,
 * a 48-bit big-endian identifier authority, then the sub-authorities as little-endian u32s.
 */
export function sidToString(b: Uint8Array, offset = 0): string {
  if (b.length < offset + 8) throw new Error("SID truncated");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const revision = b[offset]!;
  const count = b[offset + 1]!;
  if (revision !== 1 || count > 15) throw new Error(`not a SID (revision ${revision}, ${count} sub-authorities)`);
  if (b.length < offset + sidLength(count)) throw new Error("SID truncated");
  let authority = 0n;
  for (let i = 0; i < 6; i++) authority = (authority << 8n) | BigInt(b[offset + 2 + i]!);
  const auth = authority < 2n ** 32n ? authority.toString() : `0x${authority.toString(16).padStart(12, "0").toUpperCase()}`;
  const subs = Array.from({ length: count }, (_, i) => v.getUint32(offset + 8 + i * 4, true));
  return ["S", revision, auth, ...subs].join("-");
}

/** The bytes of a SID of `count` sub-authorities. */
export const sidLength = (count: number) => 8 + 4 * count;

/** A string SID in binary form (the inverse of `sidToString`, for tests and callers). */
export function sidToBytes(s: string): Uint8Array {
  const parts = requireSid(s).split("-").slice(1);
  const subs = parts.slice(2).map(Number);
  const b = new Uint8Array(sidLength(subs.length));
  const v = new DataView(b.buffer);
  b[0] = Number(parts[0]);
  b[1] = subs.length;
  let authority = BigInt(parts[1]!);
  for (let i = 5; i >= 0; i--) {
    b[2 + i] = Number(authority & 0xffn);
    authority >>= 8n;
  }
  subs.forEach((x, i) => v.setUint32(8 + i * 4, x >>> 0, true));
  return b;
}

/**
 * The ACEs of a binary ACL: an 8-byte header (revision, pad, size u16, count u16, pad), then each
 * ACE's header (type u8, flags u8, size u16). Allow and deny ACEs carry the mask at +4 and the SID
 * at +8; any other type is returned without a SID, so a check refuses it.
 */
export function parseAcl(b: Uint8Array): Ace[] {
  if (b.length < 8) throw new Error("ACL truncated");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const size = v.getUint16(2, true);
  const count = v.getUint16(4, true);
  if (size > b.length) throw new Error("ACL truncated");
  const aces: Ace[] = [];
  let at = 8;
  for (let i = 0; i < count; i++) {
    if (at + 4 > size) throw new Error("ACE truncated");
    const type = b[at]!;
    const flags = b[at + 1]!;
    const aceSize = v.getUint16(at + 2, true);
    if (aceSize < 4 || at + aceSize > size) throw new Error("ACE size out of range");
    const known = type === ACE_ALLOW || type === ACE_DENY;
    aces.push({
      type,
      flags,
      mask: aceSize >= 8 ? v.getUint32(at + 4, true) : 0,
      sid: known ? sidToString(b.subarray(0, at + aceSize), at + 8) : "",
    });
    at += aceSize;
  }
  return aces;
}

/** A binary ACL (the inverse of `parseAcl`, for tests). */
export function aclBytes(aces: Ace[]): Uint8Array {
  const bodies = aces.map((a) => {
    const sid = a.sid ? sidToBytes(a.sid) : new Uint8Array(0);
    const e = new Uint8Array(8 + sid.length);
    const v = new DataView(e.buffer);
    e[0] = a.type;
    e[1] = a.flags;
    v.setUint16(2, e.length, true);
    v.setUint32(4, a.mask >>> 0, true);
    e.set(sid, 8);
    return e;
  });
  const size = 8 + bodies.reduce((n, e) => n + e.length, 0);
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  b[0] = 2;
  v.setUint16(2, size, true);
  v.setUint16(4, aces.length, true);
  let at = 8;
  for (const e of bodies) {
    b.set(e, at);
    at += e.length;
  }
  return b;
}
