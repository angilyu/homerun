/**
 * The crash itself, on every OS: SIGKILL on POSIX, `TerminateProcess` on Windows (which has no
 * signals). Neither runs any cleanup, exit handler or flush; SQLite sees a process that vanished.
 */
import { terminateProcess } from "@homerun/win32";

/** Windows' exit code for a life killed at a boundary (128 + 9, as a shell reports SIGKILL). */
export const KILLED_CODE = 137;

export function killSelf(): never {
  if (process.platform === "win32") terminateProcess(process.pid, KILLED_CODE);
  else process.kill(process.pid, "SIGKILL");
  throw new Error("still alive after killing itself");
}

/** A child's `signalCode`, with a Windows boundary kill reported as the SIGKILL it stands for. */
export function killSignal(p: { exitCode: number | null; signalCode: string | null }): string | null {
  return p.signalCode ?? (process.platform === "win32" && p.exitCode === KILLED_CODE ? "SIGKILL" : null);
}
