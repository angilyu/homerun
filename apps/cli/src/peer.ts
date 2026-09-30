/**
 * Who is listening on the socket? (§5.2) The release CLI checks before it reads its token from
 * the keychain, let alone sends it: anything the user runs can bind a socket in the data
 * directory, and a token sent to it would be harvested.
 *
 * - `LOCAL_PEERPID` gives the listener's pid, and `LOCAL_PEERTOKEN` its audit token. The pids
 *   must match (the audit token also pins the pid's generation, so a reused pid can't pass).
 * - `getpeereid` must give our own uid.
 * - The code behind the audit token must satisfy a code-signing requirement compiled into this
 *   binary (`HOMERUN_CLI_PEER_REQUIREMENT`): homerund's identifier and team for Developer ID
 *   builds, its cdhash for ad hoc ones.
 *
 * It fails closed: no requirement, not macOS, or any FFI error refuses, before any I/O on the
 * socket. The decision is pure, with the system calls injected, so it is tested on Linux.
 */
import { CliError, EXIT } from "./exit";

/** The system calls the check needs. */
export interface PeerInspector {
  ownUid(): number;
  peerUid(fd: number): number;
  peerPid(fd: number): number;
  /** The 32-byte `audit_token_t`. */
  peerAuditToken(fd: number): Uint32Array;
  /** 0 when the code behind the audit token satisfies the requirement, else its OSStatus. */
  checkRequirement(auditToken: Uint32Array, requirement: string): number;
}

export type PeerVerdict = { ok: true; pid: number } | { ok: false; why: string };

/** `audit_token_t.val[5]` is the pid (`audit_token_to_pid`). */
export const auditTokenPid = (t: Uint32Array) => t[5]!;

/** errSecCSReqFailed: the code is signed, but not by what the requirement names. */
const errSecCSReqFailed = -67050;
/** errSecCSUnsigned. */
const errSecCSUnsigned = -67062;

export async function verifyPeer(
  fd: number | null,
  requirement: string | undefined,
  platform: string,
  inspector: () => PeerInspector | Promise<PeerInspector>,
): Promise<PeerVerdict> {
  if (!requirement) return { ok: false, why: "this build has no code requirement for homerund" };
  if (platform !== "darwin") return { ok: false, why: "it can only be checked on macOS" };
  if (fd === null) return { ok: false, why: "the connection has no file descriptor" };
  try {
    const i = await inspector();
    const uid = i.peerUid(fd);
    if (uid !== i.ownUid()) return { ok: false, why: `it belongs to another user (uid ${uid})` };
    const pid = i.peerPid(fd);
    const token = i.peerAuditToken(fd);
    if (token.length !== 8) return { ok: false, why: "its audit token is malformed" };
    if (pid <= 0 || auditTokenPid(token) !== pid) return { ok: false, why: "its pid and audit token disagree" };
    const status = i.checkRequirement(token, requirement);
    if (status === 0) return { ok: true, pid };
    if (status === errSecCSUnsigned) return { ok: false, why: `process ${pid} is not signed` };
    if (status === errSecCSReqFailed) return { ok: false, why: `process ${pid} is not Homerun's homerund` };
    return { ok: false, why: `process ${pid} failed the code-signing check (OSStatus ${status})` };
  } catch (e) {
    return { ok: false, why: `the check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function peerRefusal(why: string): CliError {
  return new CliError(
    `homerund's identity could not be verified, so the token was not used: ${why}`,
    EXIT.NOPERM,
    "open Homerun from /Applications (it starts homerund); if it is running, reinstall it",
  );
}

const SOL_LOCAL = 0;
const LOCAL_PEERPID = 2;
const LOCAL_PEERTOKEN = 6;

/** The real calls, through `bun:ffi` (macOS only; loaded on first use). */
export async function macosInspector(): Promise<PeerInspector> {
  const { macos, withCf, outRef, NULL } = await import("./macos");
  const l = macos();
  const sockopt = (fd: number, opt: number, buf: Uint32Array | Int32Array, what: string) => {
    const len = new Uint32Array([buf.byteLength]);
    if (l.sys.getsockopt(fd, SOL_LOCAL, opt, buf, len) !== 0) throw new Error(`getsockopt ${what} failed`);
    if (len[0] !== buf.byteLength) throw new Error(`getsockopt ${what} returned ${len[0]} bytes`);
  };
  return {
    ownUid: () => l.sys.getuid(),
    peerUid(fd) {
      const uid = new Uint32Array(1);
      const gid = new Uint32Array(1);
      if (l.sys.getpeereid(fd, uid, gid) !== 0) throw new Error("getpeereid failed");
      return uid[0]!;
    },
    peerPid(fd) {
      const b = new Int32Array(1);
      sockopt(fd, LOCAL_PEERPID, b, "LOCAL_PEERPID");
      return b[0]!;
    },
    peerAuditToken(fd) {
      const b = new Uint32Array(8);
      sockopt(fd, LOCAL_PEERTOKEN, b, "LOCAL_PEERTOKEN");
      return b;
    },
    checkRequirement(token, requirement) {
      return withCf((s) => {
        const attrs = s.dict([[l.k.guestAudit, s.data(new Uint8Array(token.buffer, token.byteOffset, token.byteLength))]]);
        const guest = outRef();
        const st = l.sec.SecCodeCopyGuestWithAttributes(NULL, attrs, 0, guest.ptr);
        if (st !== 0) return st;
        const code = s.own(guest.value, "SecCodeCopyGuestWithAttributes");
        const req = outRef();
        const rs = l.sec.SecRequirementCreateWithString(s.string(requirement), 0, req.ptr);
        if (rs !== 0) throw new Error(`the compiled-in requirement does not parse (OSStatus ${rs})`);
        return l.sec.SecCodeCheckValidity(code, 0, s.own(req.value, "SecRequirementCreateWithString"));
      });
    },
  };
}
