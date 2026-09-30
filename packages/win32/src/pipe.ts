/** A client handle on a named pipe, and who serves it. */
import { check, ERROR_PIPE_BUSY, INVALID_HANDLE, kernel32, Win32Error, wide } from "./ffi";

export const GENERIC_READ = 0x8000_0000;
export const GENERIC_WRITE = 0x4000_0000;
export const READ_CONTROL = 0x0002_0000;
export const WRITE_DAC = 0x0004_0000;
const OPEN_EXISTING = 3;

/**
 * Open a client handle on pipe `name` (`\\.\pipe\…`): it connects to one of the server's listening
 * instances. ERROR_PIPE_BUSY (every instance taken, or the server between accepts) is retried for
 * up to `busyMs`.
 */
export async function openPipe(name: string, access: number, busyMs = 2000): Promise<bigint> {
  const deadline = Date.now() + busyMs;
  for (;;) {
    try {
      return openExisting(name, access);
    } catch (e) {
      if (!(e instanceof Win32Error) || e.code !== ERROR_PIPE_BUSY || Date.now() >= deadline) throw e;
    }
    await Bun.sleep(20);
  }
}

/** Open an existing pipe or file once, synchronously (usable under impersonation). */
export function openExisting(name: string, access: number): bigint {
  const h = kernel32().CreateFileW(wide(name), access, 0, null, OPEN_EXISTING, 0, 0n);
  if (h === INVALID_HANDLE) throw new Win32Error(`CreateFileW(${name})`, kernel32().GetLastError());
  return h;
}

/** The pid of the process that created the pipe instance `h` is connected to. */
export function pipeServerPid(h: bigint): number {
  const pid = new Uint32Array(1);
  check(kernel32().GetNamedPipeServerProcessId(h, pid), "GetNamedPipeServerProcessId");
  return pid[0]!;
}
