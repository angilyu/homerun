import { lstatSync, readFileSync, type Stats } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { posix, win32 } from "node:path";
import { CliToken } from "@homerun/core";
import { currentUserSid, privacyProblems, readPathSecurity } from "@homerun/win32";

/**
 * Where homerund keeps its data and socket (§5.2). The runtime and every local client resolve
 * these here, so they cannot disagree about the socket path.
 *
 * On Windows the socket is a named pipe with a fresh random name at every start, published in
 * `<data>\run\endpoint` (a random name means another user can't take it first). Every function
 * takes the platform, so the Windows rules are tested everywhere.
 */

type Platform = NodeJS.Platform;
const pathFor = (platform: Platform) => (platform === "win32" ? win32 : posix);

/**
 * The Application Support folder is named separately from the bundle id: a folder whose name
 * ends like a bundle (the old `dev.homerun.app`) was treated as one by macOS, and writes into it
 * were intermittently denied (spike entry 26).
 */
export const DATA_DIR_NAME = "Homerun";
export const SOCKET_FILE = "homerund.sock";
export const DEV_TOKEN_FILE = "dev-token";
/** Holds the pipe name on Windows. */
export const ENDPOINT_FILE = "endpoint";
/** `sun_path` is 104 bytes on macOS (§5.2). */
export const SUN_PATH_MAX = 104;

/**
 * `HOMERUN_DATA_DIR`, or `~/Library/Application Support/Homerun` (macOS), or
 * `%LOCALAPPDATA%\Homerun` (Windows: local, so it never roams with the profile).
 */
export function dataDir(env: Record<string, string | undefined> = process.env, home = homedir(), platform: Platform = process.platform): string {
  const p = pathFor(platform);
  if (env.HOMERUN_DATA_DIR) return p.resolve(env.HOMERUN_DATA_DIR);
  if (platform === "win32") return p.resolve(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), DATA_DIR_NAME);
  return p.resolve(home, "Library", "Application Support", DATA_DIR_NAME);
}

const PIPE_PREFIX = "\\\\.\\pipe\\homerun-";
const PIPE_NAME = /^\\\\\.\\pipe\\homerun-[0-9a-f]{32}$/;

/** A fresh pipe name: `\\.\pipe\homerun-<128 random bits>`. */
export function newPipeName(): string {
  return PIPE_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
}

export const isPipeName = (s: string) => PIPE_NAME.test(s);

/**
 * Where the runtime listens. POSIX: `<data>/run/homerund.sock`, or `$TMPDIR/hr-<uid>/homerund.sock`
 * when that exceeds `sun_path` (§5.2). Windows: a new pipe name, and `<data>\run` for the rest.
 */
export function chooseRunDir(
  dataDirPath: string,
  tmp = tmpdir(),
  uid = userInfo().uid,
  platform: Platform = process.platform,
): { runDir: string; socketPath: string } {
  if (platform === "win32") return { runDir: win32.join(dataDirPath, "run"), socketPath: newPipeName() };
  const { join } = posix;
  const primary = join(dataDirPath, "run");
  if (Buffer.byteLength(join(primary, SOCKET_FILE)) < SUN_PATH_MAX) return { runDir: primary, socketPath: join(primary, SOCKET_FILE) };
  const fallback = join(tmp, `hr-${uid}`);
  const sock = join(fallback, SOCKET_FILE);
  if (Buffer.byteLength(sock) >= SUN_PATH_MAX) throw new Error(`socket path too long even in the fallback: ${sock}`);
  return { runDir: fallback, socketPath: sock };
}

export function devTokenPath(runDir: string, platform: Platform = process.platform): string {
  return pathFor(platform).join(runDir, DEV_TOKEN_FILE);
}

export function endpointPath(runDir: string): string {
  return win32.join(runDir, ENDPOINT_FILE);
}

/** The runtime's endpoint file is missing, not private, or doesn't hold a pipe name. */
export class EndpointError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "insecure" | "malformed",
  ) {
    super(message);
    this.name = "EndpointError";
  }
}

/**
 * Where a client connects (§5.2). POSIX: the socket path, fixed by the data dir. Windows: the pipe
 * name the running runtime published, from a file only this user can have written. A missing
 * file means no runtime.
 */
export function localEndpoint(
  dataDirPath: string,
  platform: Platform = process.platform,
  check: FilePrivacy = filePrivacy,
): { runDir: string; socketPath: string } {
  if (platform !== "win32") return chooseRunDir(dataDirPath, undefined, undefined, platform);
  const runDir = win32.join(dataDirPath, "run");
  return { runDir, socketPath: readEndpointFile(endpointPath(runDir), platform, check) };
}

/** The pipe name in endpoint file `p`, with `localEndpoint`'s checks. */
export function readEndpointFile(p: string, platform: Platform = process.platform, check: FilePrivacy = filePrivacy): string {
  let st: Stats;
  try {
    st = lstatSync(p);
  } catch {
    throw new EndpointError(`no runtime endpoint at ${p}`, "missing");
  }
  if (!st.isFile()) throw new EndpointError(`${p} is not a regular file`, "insecure");
  const why = check(p, st, platform);
  if (why) throw new EndpointError(`${p} ${why}`, "insecure");
  const name = readFileSync(p, "utf8").trim();
  if (!isPipeName(name)) throw new EndpointError(`${p} does not hold a Homerun pipe name`, "malformed");
  return name;
}

/**
 * Why a file is not private to this user, or null. POSIX: owned by `uid`, no group or other bits.
 * Windows: owned by the user (or SYSTEM, Administrators), and no allow ACE for anyone else.
 */
export type FilePrivacy = (p: string, st: Stats, platform: Platform, uid?: number) => string | null;

export const filePrivacy: FilePrivacy = (p, st, platform, uid = userInfo().uid) => {
  if (platform === "win32") {
    const problems = privacyProblems(readPathSecurity(p), currentUserSid());
    return problems.length ? `is not private to this user (${problems.join("; ")})` : null;
  }
  if (st.uid !== uid) return "is not owned by this user";
  if ((st.mode & 0o077) !== 0) return `is readable by other users (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
};

export class DevTokenError extends Error {
  constructor(
    message: string,
    readonly reason: "missing" | "insecure" | "malformed",
  ) {
    super(message);
    this.name = "DevTokenError";
  }
}

/**
 * Read the development token a development homerund writes at every start (0600, or a DACL for
 * the user alone on Windows). Refused unless it is a regular file owned by this user and readable
 * by nobody else.
 */
export function readDevToken(runDir: string, uid = userInfo().uid, platform: Platform = process.platform, check: FilePrivacy = filePrivacy): string {
  return readDevTokenFile(devTokenPath(runDir, platform), uid, platform, check);
}

/** `readDevToken` for an explicit path, with the same checks. */
export function readDevTokenFile(p: string, uid = userInfo().uid, platform: Platform = process.platform, check: FilePrivacy = filePrivacy): string {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    throw new DevTokenError(`no development token at ${p}`, "missing");
  }
  if (!st.isFile()) throw new DevTokenError(`${p} is not a regular file`, "insecure");
  const why = check(p, st, platform, uid);
  if (why) throw new DevTokenError(`${p} ${why}`, "insecure");
  const token = readFileSync(p, "utf8").trim();
  if (!CliToken.safeParse(token).success) throw new DevTokenError(`${p} does not hold a token`, "malformed");
  return token;
}
