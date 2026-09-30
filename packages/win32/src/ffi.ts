/**
 * The Win32 entry points, through `bun:ffi`. Each DLL is opened on first use, so importing this
 * module on macOS or Linux costs nothing; calling into it there throws.
 *
 * Conventions: handles are `u64` (bigint), `INVALID_HANDLE` is -1 as a u64, pointer arguments
 * take a typed array or a pointer as a number, and every failure becomes a `Win32Error` carrying
 * `GetLastError()` (or the status the call returned).
 */
import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi";

const { u32, i32, u64, ptr: P } = FFIType;

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CloseHandle: { args: [u64], returns: i32 },
    GetLastError: { args: [], returns: u32 },
    LocalFree: { args: [P], returns: u64 },
    lstrlenW: { args: [P], returns: i32 },
    CreateFileW: { args: [P, u32, u32, P, u32, u32, u64], returns: u64 },
    GetNamedPipeServerProcessId: { args: [u64, P], returns: i32 },
    GetCurrentProcess: { args: [], returns: u64 },
    OpenProcess: { args: [u32, i32, u32], returns: u64 },
    GetProcessTimes: { args: [u64, P, P, P, P], returns: i32 },
    GetExitCodeProcess: { args: [u64, P], returns: i32 },
    TerminateProcess: { args: [u64, u32], returns: i32 },
    QueryFullProcessImageNameW: { args: [u64, u32, P, P], returns: i32 },
    WaitForSingleObject: { args: [u64, u32], returns: u32 },
    CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
    Process32FirstW: { args: [u64, P], returns: i32 },
    Process32NextW: { args: [u64, P], returns: i32 },
    CreateJobObjectW: { args: [P, P], returns: u64 },
    SetInformationJobObject: { args: [u64, u32, P, u32], returns: i32 },
    QueryInformationJobObject: { args: [u64, u32, P, u32, P], returns: i32 },
    AssignProcessToJobObject: { args: [u64, u64], returns: i32 },
    TerminateJobObject: { args: [u64, u32], returns: i32 },
    IsProcessInJob: { args: [u64, u64, P], returns: i32 },
    SetThreadExecutionState: { args: [u32], returns: u32 },
  }).symbols;
}

function loadAdvapi32() {
  return dlopen("advapi32.dll", {
    OpenProcessToken: { args: [u64, u32, P], returns: i32 },
    GetTokenInformation: { args: [u64, u32, P, u32, P], returns: i32 },
    GetSecurityInfo: { args: [u64, u32, u32, P, P, P, P, P], returns: u32 },
    SetSecurityInfo: { args: [u64, u32, u32, P, P, P, P], returns: u32 },
    GetNamedSecurityInfoW: { args: [P, u32, u32, P, P, P, P, P], returns: u32 },
    SetNamedSecurityInfoW: { args: [P, u32, u32, P, P, P, P], returns: u32 },
    GetSecurityDescriptorControl: { args: [P, P, P], returns: i32 },
    GetSecurityDescriptorDacl: { args: [P, P, P, P], returns: i32 },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [P, u32, P, P], returns: i32 },
    CredReadW: { args: [P, u32, u32, P], returns: i32 },
    CredWriteW: { args: [P, u32], returns: i32 },
    CredDeleteW: { args: [P, u32, u32], returns: i32 },
    CredFree: { args: [P], returns: FFIType.void },
  }).symbols;
}

type Kernel32 = ReturnType<typeof loadKernel32>;
type Advapi32 = ReturnType<typeof loadAdvapi32>;
let k32: Kernel32 | undefined;
let adv: Advapi32 | undefined;

function onWindows(): void {
  if (process.platform !== "win32") throw new Error(`@homerun/win32 called on ${process.platform}`);
}

export function kernel32(): Kernel32 {
  onWindows();
  return (k32 ??= loadKernel32());
}

export function advapi32(): Advapi32 {
  onWindows();
  return (adv ??= loadAdvapi32());
}

export const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_FILE_NOT_FOUND = 2;
export const ERROR_INVALID_PARAMETER = 87;
export const ERROR_PIPE_BUSY = 231;
export const ERROR_NOT_FOUND = 1168;

export class Win32Error extends Error {
  constructor(
    readonly call: string,
    readonly code: number,
  ) {
    super(`${call} failed (Win32 error ${code})`);
    this.name = "Win32Error";
  }
}

/** Throw the last error for `call` unless `ok`. */
export function check(ok: boolean | number, call: string): void {
  if (!ok) throw new Win32Error(call, kernel32().GetLastError());
}

/** Throw unless a call that returns its status (ERROR_SUCCESS = 0) succeeded. */
export function checkStatus(status: number, call: string): void {
  if (status !== 0) throw new Win32Error(call, status);
}

export const asPointer = (n: bigint | number) => Number(n) as unknown as Pointer;

/** A NUL-terminated UTF-16 string for a `LPCWSTR` argument. */
export const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");

/** The NUL-terminated UTF-16 string at `p`. */
export function fromWide(p: bigint | number): string {
  if (!p) return "";
  const n = kernel32().lstrlenW(asPointer(p));
  return n ? Buffer.from(toArrayBuffer(asPointer(p), 0, n * 2)).toString("utf16le") : "";
}

/** `n` bytes at `p`, copied. */
export function bytesAt(p: bigint | number, n: number): Uint8Array {
  return new Uint8Array(toArrayBuffer(asPointer(p), 0, n).slice(0));
}

export function closeHandle(h: bigint): void {
  if (h !== 0n && h !== INVALID_HANDLE) kernel32().CloseHandle(h);
}

export function localFree(p: bigint | number): void {
  if (p) kernel32().LocalFree(asPointer(p));
}
