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
 * It fails closed: no requirement, not macOS or Windows, or any FFI error refuses, before any I/O
 * on the socket. The decision is pure, with the system calls injected, so it is tested on Linux.
 *
 * Windows (`verifyWindowsPeer`) has no peer credentials on the connection itself, and Bun
 * doesn't expose the pipe handle under it, so the CLI opens a second, probe handle on the same
 * pipe name and checks through that (§18):
 *
 * - the pipe's DACL admits only this user and SYSTEM, protected, with network logons denied,
 *   which is what homerund sets; so only this user's processes (or SYSTEM) can serve instances;
 * - `GetNamedPipeServerProcessId` gives the server, which must run as this user;
 * - its image must satisfy the compiled-in requirement: `sha256:<hex>` of homerund.exe
 *   (unsigned builds), or `authenticode:<subject CN>` (a verified signature by that signer).
 *
 * A same-user process could add an instance of its own and be the one the RPC connection
 * reached; Windows has no per-app isolation to stop it, and Credential Manager, where the token
 * is kept, is open to it anyway. The check is against everything else: other users, a pipe
 * someone else created, and a homerund that isn't Homerun's.
 */
import { privacyProblems, type SecurityInfo } from "@homerun/win32";
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

/** The system calls the Windows check needs, on a probe handle it opens on the pipe. */
export interface WindowsPeerInspector {
  ownSid(): string;
  open(pipe: string): Promise<bigint>;
  close(h: bigint): void;
  pipeSecurity(h: bigint): SecurityInfo;
  serverPid(h: bigint): number;
  processSid(pid: number): string;
  imagePath(pid: number): string;
  sha256(path: string): string;
  /** WinVerifyTrust's status (0 = verified) and, when verified, the signer's common name. */
  authenticode(path: string): { status: number; subject: string | null };
}

export type WindowsRequirement = { kind: "sha256"; hex: string } | { kind: "authenticode"; subject: string };

/** `sha256:<64 hex>` or `authenticode:<subject CN>`; anything else is null. */
export function parseWindowsRequirement(r: string): WindowsRequirement | null {
  const sha = /^sha256:([0-9a-fA-F]{64})$/.exec(r);
  if (sha) return { kind: "sha256", hex: sha[1]!.toLowerCase() };
  const ac = /^authenticode:(.+)$/.exec(r);
  if (ac && ac[1]!.trim() === ac[1] && ac[1]!.length <= 256) return { kind: "authenticode", subject: ac[1]! };
  return null;
}

/** TRUST_E_NOSIGNATURE. */
const TRUST_E_NOSIGNATURE = 0x800b0100;

export async function verifyWindowsPeer(
  pipe: string,
  requirement: string | undefined,
  inspector: () => WindowsPeerInspector | Promise<WindowsPeerInspector>,
): Promise<PeerVerdict> {
  if (!requirement) return { ok: false, why: "this build has no code requirement for homerund" };
  const req = parseWindowsRequirement(requirement);
  if (!req) return { ok: false, why: "this build's code requirement for homerund is not a Windows one" };
  try {
    const i = await inspector();
    const me = i.ownSid();
    const h = await i.open(pipe);
    try {
      const problems = privacyProblems(i.pipeSecurity(h), me, { networkDeny: true, protected: true });
      if (problems.length) return { ok: false, why: `the pipe is not private to this user (${problems.join("; ")})` };
      const pid = i.serverPid(h);
      if (pid <= 0) return { ok: false, why: "the pipe has no server process" };
      const sid = i.processSid(pid);
      if (sid !== me) return { ok: false, why: `it belongs to another user (${sid})` };
      const image = i.imagePath(pid);
      if (req.kind === "sha256") {
        if (i.sha256(image).toLowerCase() !== req.hex) return { ok: false, why: `process ${pid} (${image}) is not Homerun's homerund` };
        return { ok: true, pid };
      }
      const a = i.authenticode(image);
      if (a.status === TRUST_E_NOSIGNATURE) return { ok: false, why: `process ${pid} (${image}) is not signed` };
      if (a.status !== 0) return { ok: false, why: `process ${pid} (${image}) failed the Authenticode check (0x${(a.status >>> 0).toString(16)})` };
      if (a.subject !== req.subject) return { ok: false, why: `process ${pid} (${image}) is signed by ${a.subject ?? "an unnamed signer"}, not Homerun` };
      return { ok: true, pid };
    } finally {
      i.close(h);
    }
  } catch (e) {
    return { ok: false, why: `the check failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function peerRefusal(why: string, platform: string = process.platform): CliError {
  return new CliError(
    `homerund's identity could not be verified, so the token was not used: ${why}`,
    EXIT.NOPERM,
    platform === "win32"
      ? "open Homerun from the Start menu (it starts homerund); if it is running, reinstall it"
      : "open Homerun from /Applications (it starts homerund); if it is running, reinstall it",
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
