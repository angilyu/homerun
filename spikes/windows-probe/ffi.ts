/**
 * Just enough Win32 through bun:ffi for the milestone 8b probe (docs/design.md §16 row 8b).
 * Temporary: packages/win32 replaces it once the probe has answered its questions.
 */
import { dlopen, FFIType, ptr, toArrayBuffer, type Pointer } from "bun:ffi";

const { u32, i32, u64, ptr: P } = FFIType;

export const k32 = dlopen("kernel32.dll", {
  CreateFileW: { args: [P, u32, u32, P, u32, u32, u64], returns: u64 },
  CloseHandle: { args: [u64], returns: i32 },
  GetLastError: { args: [], returns: u32 },
  GetNamedPipeServerProcessId: { args: [u64, P], returns: i32 },
  GetCurrentProcess: { args: [], returns: u64 },
  LocalFree: { args: [P], returns: u64 },
  lstrlenW: { args: [P], returns: i32 },
  OpenProcess: { args: [u32, i32, u32], returns: u64 },
  QueryFullProcessImageNameW: { args: [u64, u32, P, P], returns: i32 },
  SetThreadExecutionState: { args: [u32], returns: u32 },
  CreateNamedPipeW: { args: [P, u32, u32, u32, u32, u32, u32, P], returns: u64 },
  ConnectNamedPipe: { args: [u64, P], returns: i32 },
  ReadFile: { args: [u64, P, u32, P, P], returns: i32 },
  WriteFile: { args: [u64, P, u32, P, P], returns: i32 },
  FlushFileBuffers: { args: [u64], returns: i32 },
  GetNamedPipeClientComputerNameW: { args: [u64, P, u32], returns: i32 },
  GetNamedPipeClientSessionId: { args: [u64, P], returns: i32 },
  GetCurrentThread: { args: [], returns: u64 },
  CreateJobObjectW: { args: [P, P], returns: u64 },
  SetInformationJobObject: { args: [u64, u32, P, u32], returns: i32 },
  QueryInformationJobObject: { args: [u64, u32, P, u32, P], returns: i32 },
  AssignProcessToJobObject: { args: [u64, u64], returns: i32 },
  TerminateJobObject: { args: [u64, u32], returns: i32 },
  IsProcessInJob: { args: [u64, u64, P], returns: i32 },
  WaitForSingleObject: { args: [u64, u32], returns: u32 },
  CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
  Process32FirstW: { args: [u64, P], returns: i32 },
  Process32NextW: { args: [u64, P], returns: i32 },
}).symbols;

export const adv = dlopen("advapi32.dll", {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: [P, u32, P, P], returns: i32 },
  ConvertSecurityDescriptorToStringSecurityDescriptorW: { args: [P, u32, u32, P, P], returns: i32 },
  GetSecurityDescriptorDacl: { args: [P, P, P, P], returns: i32 },
  SetSecurityInfo: { args: [u64, u32, u32, P, P, P, P], returns: u32 },
  GetSecurityInfo: { args: [u64, u32, u32, P, P, P, P, P], returns: u32 },
  OpenProcessToken: { args: [u64, u32, P], returns: i32 },
  GetTokenInformation: { args: [u64, u32, P, u32, P], returns: i32 },
  ConvertSidToStringSidW: { args: [P, P], returns: i32 },
  ImpersonateNamedPipeClient: { args: [u64], returns: i32 },
  ImpersonateLoggedOnUser: { args: [u64], returns: i32 },
  RevertToSelf: { args: [], returns: i32 },
  OpenThreadToken: { args: [u64, u32, i32, P], returns: i32 },
  LogonUserW: { args: [P, P, P, u32, u32, P], returns: i32 },
}).symbols;

export const INVALID = 0xffff_ffff_ffff_ffffn;
export const GENERIC_READ = 0x8000_0000;
export const GENERIC_WRITE = 0x4000_0000;
export const READ_CONTROL = 0x0002_0000;
export const WRITE_DAC = 0x0004_0000;
export const FILE_READ_ATTRIBUTES = 0x80;
export const OPEN_EXISTING = 3;
export const SE_KERNEL_OBJECT = 6;
export const OWNER = 1;
export const DACL = 4;
export const PROTECTED_DACL = 0x8000_0000;

export const wide = (s: string) => Buffer.from(`${s}\0`, "utf16le");

export function fromWide(p: number): string {
  const n = k32.lstrlenW(p as unknown as Pointer);
  return Buffer.from(toArrayBuffer(p as unknown as Pointer, 0, n * 2)).toString("utf16le");
}

export function open(path: string, access: number): { h: bigint; err: number } {
  const h = k32.CreateFileW(wide(path), access, 0, null, OPEN_EXISTING, 0, 0n) as bigint;
  return { h, err: h === INVALID ? k32.GetLastError() : 0 };
}

export function sddlOf(h: bigint, what = OWNER | DACL): string {
  const sd = new BigUint64Array(1);
  const e = adv.GetSecurityInfo(h, SE_KERNEL_OBJECT, what, null, null, null, null, ptr(sd));
  if (e) return `GetSecurityInfo error ${e}`;
  const s = new BigUint64Array(1);
  if (!adv.ConvertSecurityDescriptorToStringSecurityDescriptorW(Number(sd[0]) as unknown as Pointer, 1, what, ptr(s), null)) return `convert error ${k32.GetLastError()}`;
  const out = fromWide(Number(s[0]));
  k32.LocalFree(Number(s[0]) as unknown as Pointer);
  k32.LocalFree(Number(sd[0]) as unknown as Pointer);
  return out;
}

/** Replace the DACL with the one in `sddl`, protected from inheritance. Returns a Win32 error. */
export function setDacl(h: bigint, sddl: string): number {
  const sd = new BigUint64Array(1);
  if (!adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, ptr(sd), null)) return k32.GetLastError();
  const present = new Int32Array(1);
  const dacl = new BigUint64Array(1);
  const defaulted = new Int32Array(1);
  const psd = Number(sd[0]) as unknown as Pointer;
  if (!adv.GetSecurityDescriptorDacl(psd, ptr(present), ptr(dacl), ptr(defaulted))) return k32.GetLastError();
  const e = adv.SetSecurityInfo(h, SE_KERNEL_OBJECT, DACL | PROTECTED_DACL, null, null, Number(dacl[0]) as unknown as Pointer, null);
  k32.LocalFree(psd);
  return e;
}

export function serverPid(h: bigint): number | string {
  const pid = new Uint32Array(1);
  return k32.GetNamedPipeServerProcessId(h, ptr(pid)) ? pid[0]! : `error ${k32.GetLastError()}`;
}

export function processImage(pid: number): string {
  const h = k32.OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid) as bigint;
  if (h === 0n) return `OpenProcess error ${k32.GetLastError()}`;
  const buf = Buffer.alloc(1040);
  const len = new Uint32Array([520]);
  const ok = k32.QueryFullProcessImageNameW(h, 0, buf, ptr(len));
  k32.CloseHandle(h);
  return ok ? buf.subarray(0, len[0]! * 2).toString("utf16le") : `QueryFullProcessImageNameW error ${k32.GetLastError()}`;
}

export const asPtr = (n: bigint | number) => Number(n) as unknown as Pointer;

export function sidString(psid: bigint | number): string {
  const s = new BigUint64Array(1);
  if (!adv.ConvertSidToStringSidW(asPtr(psid), ptr(s))) return `ConvertSidToStringSidW error ${k32.GetLastError()}`;
  const out = fromWide(Number(s[0]));
  k32.LocalFree(asPtr(s[0]!));
  return out;
}

/** A token's user SID, as a string. */
export function tokenUser(tok: bigint): string {
  const buf = Buffer.alloc(256);
  const len = new Uint32Array(1);
  if (!adv.GetTokenInformation(tok, 1 /* TokenUser */, buf, 256, ptr(len))) return `GetTokenInformation error ${k32.GetLastError()}`;
  return sidString(buf.readBigUInt64LE(0));
}

/** A token's group SIDs, as strings (TOKEN_GROUPS: count, then 16-byte SID_AND_ATTRIBUTES). */
export function tokenGroups(tok: bigint): string[] {
  const buf = Buffer.alloc(8192);
  const len = new Uint32Array(1);
  if (!adv.GetTokenInformation(tok, 2 /* TokenGroups */, buf, buf.length, ptr(len))) return [`GetTokenInformation error ${k32.GetLastError()}`];
  const n = buf.readUInt32LE(0);
  return Array.from({ length: n }, (_, i) => sidString(buf.readBigUInt64LE(8 + i * 16)));
}

/** The well-known logon-type groups a token carries. */
export function logonKinds(groups: string[]): string[] {
  const known: Record<string, string> = { "S-1-5-2": "NETWORK", "S-1-5-3": "BATCH", "S-1-5-4": "INTERACTIVE", "S-1-5-6": "SERVICE", "S-1-5-14": "REMOTE_INTERACTIVE", "S-1-2-0": "LOCAL" };
  return groups.filter((g) => g in known).map((g) => known[g]!);
}

export function processUserSid(pid?: number): string {
  let proc = k32.GetCurrentProcess() as bigint;
  if (pid !== undefined) {
    proc = k32.OpenProcess(0x1000, 0, pid) as bigint;
    if (proc === 0n) return `OpenProcess error ${k32.GetLastError()}`;
  }
  const tok = new BigUint64Array(1);
  if (!adv.OpenProcessToken(proc, 8 /* TOKEN_QUERY */, ptr(tok))) return `OpenProcessToken error ${k32.GetLastError()}`;
  const buf = Buffer.alloc(256);
  const len = new Uint32Array(1);
  if (!adv.GetTokenInformation(tok[0]!, 1 /* TokenUser */, buf, 256, ptr(len))) return `GetTokenInformation error ${k32.GetLastError()}`;
  const psid = buf.readBigUInt64LE(0);
  const s = new BigUint64Array(1);
  if (!adv.ConvertSidToStringSidW(Number(psid) as unknown as Pointer, ptr(s))) return `ConvertSidToStringSidW error ${k32.GetLastError()}`;
  const out = fromWide(Number(s[0]));
  k32.LocalFree(Number(s[0]) as unknown as Pointer);
  k32.CloseHandle(tok[0]!);
  if (pid !== undefined) k32.CloseHandle(proc);
  return out;
}
