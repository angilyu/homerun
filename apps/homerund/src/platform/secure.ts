import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { endpointPath } from "@homerun/client";
import {
  closeHandle,
  currentUserSid,
  openPipe,
  pipeSddl,
  privacyProblems,
  privateDirSddl,
  READ_CONTROL,
  readPathSecurity,
  readSecurity,
  setPathProtectedDacl,
  setProtectedDacl,
  WRITE_DAC,
} from "@homerun/win32";

/**
 * Keeping the data dir and the socket to the user alone (§5.2). POSIX: mode 0700 and a 0600
 * socket. Windows: a protected DACL for the user and SYSTEM on the data and run dirs (everything
 * below inherits it), and the same on the pipe, with network logons denied.
 */

export class NotPrivateError extends Error {
  constructor(what: string, problems: string[]) {
    super(`${what} could not be made private to this user: ${problems.join("; ")}`);
    this.name = "NotPrivateError";
  }
}

/**
 * Create `d` if needed and make it private: 0700, or on Windows a protected user-and-SYSTEM DACL.
 * On Windows the DACL is only replaced when the check fails, since replacing it walks the whole
 * tree below; a DACL that still fails the check after that is an error.
 */
export function secureDir(d: string, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    chmodSync(d, 0o700);
    return d;
  }
  const me = currentUserSid();
  const check = () => privacyProblems(readPathSecurity(d), me, { protected: true });
  if (check().length) {
    setPathProtectedDacl(d, privateDirSddl(me));
    const left = check();
    if (left.length) throw new NotPrivateError(d, left);
  }
  return d;
}

/**
 * Lock a pipe the runtime just started listening on (Windows): through a client handle, replace
 * the named-pipe default (Everyone and Anonymous may read) with the runtime's DACL, then read it
 * back and refuse to go on unless it passes. The DACL belongs to the pipe, so it covers every
 * instance created after it (probe P2, windows-latest). The handle connects as a client; the
 * caller closes whatever was accepted before this returned.
 */
export async function lockPipe(name: string): Promise<void> {
  const me = currentUserSid();
  const h = await openPipe(name, READ_CONTROL | WRITE_DAC);
  try {
    setProtectedDacl(h, pipeSddl(me));
    const problems = privacyProblems(readSecurity(h), me, { networkDeny: true, protected: true });
    if (problems.length) throw new NotPrivateError(`the pipe ${name}`, problems);
  } finally {
    closeHandle(h);
  }
}

/** Publish the pipe name for clients (Windows): written whole, then renamed into place. */
export function publishEndpoint(runDir: string, name: string): void {
  const p = endpointPath(runDir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, `${name}\n`);
  renameSync(tmp, p);
}

/** Remove the endpoint file if it still names this runtime's pipe. */
export function unpublishEndpoint(runDir: string, name: string): void {
  const p = endpointPath(runDir);
  try {
    if (existsSync(p) && readFileSync(p, "utf8").trim() === name) rmSync(p, { force: true });
  } catch {}
}
