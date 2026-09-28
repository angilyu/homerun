import { lstatSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { CliToken } from "@homerun/core";

/**
 * Where homerund keeps its data and socket (§5.2). The runtime and every local client resolve
 * these here, so they cannot disagree about the socket path.
 */

/**
 * The Application Support folder is named separately from the bundle id: a folder whose name
 * ends like a bundle (the old `dev.homerun.app`) was treated as one by macOS, and writes into it
 * were intermittently denied (spike entry 26).
 */
export const DATA_DIR_NAME = "Homerun";
export const SOCKET_FILE = "homerund.sock";
export const DEV_TOKEN_FILE = "dev-token";
/** `sun_path` is 104 bytes on macOS (§5.2). */
export const SUN_PATH_MAX = 104;

/** `HOMERUN_DATA_DIR`, or `~/Library/Application Support/Homerun`. */
export function dataDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return resolve(env.HOMERUN_DATA_DIR ?? join(home, "Library", "Application Support", DATA_DIR_NAME));
}

/** `<data>/run/homerund.sock`, or `$TMPDIR/hr-<uid>/homerund.sock` when that exceeds `sun_path` (§5.2). */
export function chooseRunDir(dataDirPath: string, tmp = tmpdir(), uid = userInfo().uid): { runDir: string; socketPath: string } {
  const primary = join(dataDirPath, "run");
  if (Buffer.byteLength(join(primary, SOCKET_FILE)) < SUN_PATH_MAX) return { runDir: primary, socketPath: join(primary, SOCKET_FILE) };
  const fallback = join(tmp, `hr-${uid}`);
  const sock = join(fallback, SOCKET_FILE);
  if (Buffer.byteLength(sock) >= SUN_PATH_MAX) throw new Error(`socket path too long even in the fallback: ${sock}`);
  return { runDir: fallback, socketPath: sock };
}

export function devTokenPath(runDir: string): string {
  return join(runDir, DEV_TOKEN_FILE);
}

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
 * Read the development token a development homerund writes at every start (0600). Refused
 * unless it is a regular file owned by this user and readable by nobody else.
 */
export function readDevToken(runDir: string, uid = userInfo().uid): string {
  const p = devTokenPath(runDir);
  let st;
  try {
    st = lstatSync(p);
  } catch {
    throw new DevTokenError(`no development token at ${p}`, "missing");
  }
  if (!st.isFile()) throw new DevTokenError(`${p} is not a regular file`, "insecure");
  if (st.uid !== uid) throw new DevTokenError(`${p} is not owned by this user`, "insecure");
  if ((st.mode & 0o077) !== 0) throw new DevTokenError(`${p} is readable by other users (mode ${(st.mode & 0o777).toString(8)})`, "insecure");
  const token = readFileSync(p, "utf8").trim();
  if (!CliToken.safeParse(token).success) throw new DevTokenError(`${p} does not hold a token`, "malformed");
  return token;
}
