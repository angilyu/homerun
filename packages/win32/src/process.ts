/**
 * Processes on Windows: who runs them, what image, since when, whether they are alive, the tree
 * from a Toolhelp snapshot (the `ps` replacement), and job objects (the process-group
 * replacement, docs/design.md §5.1).
 */
import { advapi32, check, closeHandle, ERROR_ACCESS_DENIED, INVALID_HANDLE, kernel32, Win32Error } from "./ffi";
import { sidAt } from "./security";

export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_SET_QUOTA = 0x0100;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const SYNCHRONIZE = 0x0010_0000;
const TOKEN_QUERY = 0x8;
const TokenUser = 1;
const WAIT_TIMEOUT = 0x102;
const STILL_ACTIVE = 259;

/** A pseudo-handle for this process; never closed. */
export const currentProcess = () => kernel32().GetCurrentProcess();

/** Open process `pid`, or throw. */
export function openProcess(pid: number, access: number): bigint {
  const h = kernel32().OpenProcess(access, 0, pid);
  check(h !== 0n, `OpenProcess(${pid})`);
  return h;
}

/** Run `f` with a handle on `pid`, closed after. */
export function withProcess<T>(pid: number, access: number, f: (h: bigint) => T): T {
  const h = openProcess(pid, access);
  try {
    return f(h);
  } finally {
    closeHandle(h);
  }
}

/** The user SID of the token of process handle `h`. */
export function processHandleUserSid(h: bigint): string {
  const tok = new BigUint64Array(1);
  check(advapi32().OpenProcessToken(h, TOKEN_QUERY, tok), "OpenProcessToken");
  try {
    const buf = new BigUint64Array(64);
    const len = new Uint32Array(1);
    check(advapi32().GetTokenInformation(tok[0]!, TokenUser, buf, buf.byteLength, len), "GetTokenInformation(TokenUser)");
    // TOKEN_USER: a pointer to the SID (into this buffer), then its attributes.
    return sidAt(buf[0]!);
  } finally {
    closeHandle(tok[0]!);
  }
}

/** This process's user SID. */
export const currentUserSid = () => processHandleUserSid(currentProcess());

/** The user SID process `pid` runs as. */
export const processUserSid = (pid: number) => withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, processHandleUserSid);

/** The full Win32 path of the image process `pid` runs. */
export function processImagePath(pid: number): string {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
    const chars = 32_768;
    const buf = Buffer.alloc(chars * 2);
    const len = new Uint32Array([chars]);
    check(kernel32().QueryFullProcessImageNameW(h, 0, buf, len), "QueryFullProcessImageNameW");
    return buf.subarray(0, len[0]! * 2).toString("utf16le");
  });
}

/** When process handle `h` started, in FILETIME units (100 ns since 1601): its identity with the pid. */
export function processHandleCreationTime(h: bigint): bigint {
  const [created, exited, kernel, user] = [0, 0, 0, 0].map(() => new BigUint64Array(1)) as [BigUint64Array, BigUint64Array, BigUint64Array, BigUint64Array];
  check(kernel32().GetProcessTimes(h, created, exited, kernel, user), "GetProcessTimes");
  return created[0]!;
}

export const processCreationTime = (pid: number) => withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, processHandleCreationTime);

/**
 * Whether process `pid` is running and, given `created`, is the same process (a reused pid has a
 * different creation time). A process we may not open (another user's) exists, so it counts as
 * alive unless `created` asks for more than we can know.
 */
export function pidAlive(pid: number, created?: bigint): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const h = kernel32().OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (h === 0n) return kernel32().GetLastError() === ERROR_ACCESS_DENIED && created === undefined;
  try {
    if (kernel32().WaitForSingleObject(h, 0) !== WAIT_TIMEOUT) return false;
    return created === undefined || processHandleCreationTime(h) === created;
  } finally {
    closeHandle(h);
  }
}

/** Process handle `h`'s exit code, or null while it runs. */
export function exitCode(h: bigint): number | null {
  const c = new Uint32Array(1);
  check(kernel32().GetExitCodeProcess(h, c), "GetExitCodeProcess");
  return c[0] === STILL_ACTIVE && kernel32().WaitForSingleObject(h, 0) === WAIT_TIMEOUT ? null : c[0]!;
}

/** Terminate process `pid` (no signal on Windows: this is SIGKILL). False if it was already gone. */
export function terminateProcess(pid: number, code = 1): boolean {
  const h = kernel32().OpenProcess(PROCESS_TERMINATE, 0, pid);
  if (h === 0n) return false;
  try {
    return kernel32().TerminateProcess(h, code) !== 0;
  } finally {
    closeHandle(h);
  }
}

export interface ProcEntry {
  pid: number;
  ppid: number;
  /** The image's file name, not its path (Toolhelp gives no more; there is no command line). */
  exe: string;
}

const TH32CS_SNAPPROCESS = 0x2;
/** PROCESSENTRY32W: size u32 @0, pid @8, parent pid @32, szExeFile[260] @44. */
const PROCESSENTRY32W_SIZE = 568;

/** Every process, from one Toolhelp snapshot. */
export function processSnapshot(): ProcEntry[] {
  const h = kernel32().CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  check(h !== INVALID_HANDLE, "CreateToolhelp32Snapshot");
  try {
    const e = Buffer.alloc(PROCESSENTRY32W_SIZE);
    e.writeUInt32LE(PROCESSENTRY32W_SIZE, 0);
    const procs: ProcEntry[] = [];
    for (let ok = kernel32().Process32FirstW(h, e); ok; ok = kernel32().Process32NextW(h, e)) {
      const name = e.subarray(44, 44 + 520).toString("utf16le");
      const nul = name.indexOf("\0");
      procs.push({ pid: e.readUInt32LE(8), ppid: e.readUInt32LE(32), exe: nul < 0 ? name : name.slice(0, nul) });
    }
    return procs;
  } finally {
    closeHandle(h);
  }
}

// Job objects.

const JobObjectBasicProcessIdList = 3;
const JobObjectExtendedLimitInformation = 9;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes; BasicLimitInformation.LimitFlags is at 16. */
const EXTENDED_LIMIT_SIZE = 144;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

/** A new anonymous job. `killOnClose`: when its last handle closes, every process in it dies. */
export function createJob(o: { killOnClose: boolean }): bigint {
  const j = kernel32().CreateJobObjectW(null, null);
  check(j !== 0n, "CreateJobObjectW");
  if (o.killOnClose) {
    const info = Buffer.alloc(EXTENDED_LIMIT_SIZE);
    info.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 16);
    if (!kernel32().SetInformationJobObject(j, JobObjectExtendedLimitInformation, info, info.length)) {
      const e = new Win32Error("SetInformationJobObject", kernel32().GetLastError());
      closeHandle(j);
      throw e;
    }
  }
  return j;
}

/** Put a process in a job (jobs nest, Windows 8 and later); its future children follow it. */
export function assignProcessHandle(job: bigint, process: bigint): void {
  check(kernel32().AssignProcessToJobObject(job, process), "AssignProcessToJobObject");
}

export function assignToJob(job: bigint, pid: number): void {
  withProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE, (h) => assignProcessHandle(job, h));
}

/** The pids in a job now. */
export function jobPids(job: bigint): number[] {
  for (let cap = 256; ; cap *= 4) {
    const buf = new BigUint64Array(1 + cap);
    const head = new Uint32Array(buf.buffer, 0, 2);
    if (kernel32().QueryInformationJobObject(job, JobObjectBasicProcessIdList, buf, buf.byteLength, null)) {
      return Array.from(buf.subarray(1, 1 + head[1]!), Number);
    }
    const code = kernel32().GetLastError();
    // ERROR_MORE_DATA: the job holds more processes than the buffer; ask again with more room.
    if (code !== 234 || cap > 65_536) throw new Win32Error("QueryInformationJobObject", code);
  }
}

/** Kill every process in a job. */
export function terminateJob(job: bigint, code = 1): void {
  check(kernel32().TerminateJobObject(job, code), "TerminateJobObject");
}

/** Whether process handle `h` is in `job`, or in any job when `job` is 0n. */
export function inJob(h: bigint, job = 0n): boolean {
  const r = new Int32Array(1);
  check(kernel32().IsProcessInJob(h, job, r), "IsProcessInJob");
  return r[0] !== 0;
}
