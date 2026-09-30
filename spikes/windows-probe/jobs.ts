/**
 * Milestone 8b probe, round 2 (plan §4, P6), Windows only: job objects for the process tree.
 * libuv (under Bun and Node) spawns children suspended into its own kill-on-close job, with
 * silent breakaway, unless they are detached. What that leaves for the runtime to do, measured:
 *
 *   P6.parentDies.*  a child bun spawns `ping` (attached or detached; with or without first
 *                    putting itself in a kill-on-close job), then is TerminateProcess'd, as a crash
 *                    or the supervisor would: does the grandchild die with it?
 *   P6.runJob.*      the runtime's per-run job: a job created here, a child bun assigned to it
 *                    right after spawn, which spawns `ping` attached and detached. Do the
 *                    grandchildren land in the job, and does TerminateJobObject take them all?
 *   P6.toolhelp      the process tree from a Toolhelp snapshot (the `ps` replacement).
 *
 * Prints one JSON object; never fails the job on a "no".
 *
 *   bun spikes/windows-probe/jobs.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { ptr } from "bun:ffi";
import { INVALID, k32 } from "./ffi";

const KILL_ON_JOB_CLOSE = 0x2000;
const SYNCHRONIZE = 0x0010_0000;
const QUERY_LIMITED = 0x1000;
const SET_QUOTA_TERMINATE = 0x0100 | 0x0001;

const out: Record<string, unknown> = {};
const safe = async (k: string, f: () => unknown) => {
  try {
    out[k] = await f();
  } catch (e) {
    out[k] = `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
  }
};

function createJob(killOnClose: boolean): bigint {
  const j = k32.CreateJobObjectW(null, null) as bigint;
  if (j === 0n) throw new Error(`CreateJobObjectW error ${k32.GetLastError()}`);
  if (killOnClose) {
    const info = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION; LimitFlags at 16
    info.writeUInt32LE(KILL_ON_JOB_CLOSE, 16);
    if (!k32.SetInformationJobObject(j, 9, info, info.length)) throw new Error(`SetInformationJobObject error ${k32.GetLastError()}`);
  }
  return j;
}

function jobPids(j: bigint): number[] | string {
  const buf = Buffer.alloc(8 + 8 * 512);
  if (!k32.QueryInformationJobObject(j, 3 /* BasicProcessIdList */, buf, buf.length, null)) return `error ${k32.GetLastError()}`;
  return Array.from({ length: buf.readUInt32LE(4) }, (_, i) => Number(buf.readBigUInt64LE(8 + i * 8)));
}

function inAnyJob(proc: bigint): boolean | string {
  const b = new Int32Array(1);
  return k32.IsProcessInJob(proc, 0n, ptr(b)) ? b[0] !== 0 : `error ${k32.GetLastError()}`;
}

function alive(pid: number): boolean {
  const h = k32.OpenProcess(SYNCHRONIZE | QUERY_LIMITED, 0, pid) as bigint;
  if (h === 0n) return false;
  const r = k32.WaitForSingleObject(h, 0);
  k32.CloseHandle(h);
  return r === 0x102; // WAIT_TIMEOUT: still running
}

async function diesWithin(pid: number, ms: number): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (!alive(pid)) return Math.round(performance.now() - t0);
    await Bun.sleep(25);
  }
  return null;
}

interface Proc {
  pid: number;
  ppid: number;
  exe: string;
}

function snapshot(): Proc[] {
  const h = k32.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0) as bigint;
  if (h === INVALID) throw new Error(`CreateToolhelp32Snapshot error ${k32.GetLastError()}`);
  const e = Buffer.alloc(568); // PROCESSENTRY32W
  e.writeUInt32LE(e.length, 0);
  const procs: Proc[] = [];
  for (let ok = k32.Process32FirstW(h, e); ok; ok = k32.Process32NextW(h, e)) {
    const name = e.subarray(44, 44 + 520).toString("utf16le");
    procs.push({ pid: e.readUInt32LE(8), ppid: e.readUInt32LE(32), exe: name.slice(0, name.indexOf("\0")) });
  }
  k32.CloseHandle(h);
  return procs;
}

function descendants(root: number, procs = snapshot()): Proc[] {
  const found: Proc[] = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of procs) if (c.ppid === p && !found.some((f) => f.pid === c.pid)) {
      found.push(c);
      queue.push(c.pid);
    }
  }
  return found;
}

/** Child: optionally join a new kill-on-close job, spawn `ping` as asked, report, and wait. */
function child(selfJob: boolean, kinds: string[]) {
  const r: Record<string, unknown> = { pid: process.pid, inJobBefore: inAnyJob(k32.GetCurrentProcess() as bigint) };
  if (selfJob) {
    const j = createJob(true);
    r.selfAssign = k32.AssignProcessToJobObject(j, k32.GetCurrentProcess() as bigint) ? "ok" : `error ${k32.GetLastError()}`;
  }
  r.gc = kinds.map((k) => spawn("ping.exe", ["-n", "120", "127.0.0.1"], { stdio: "ignore", detached: k === "detached", windowsHide: true }).pid);
  writeSync(1, `${JSON.stringify(r)}\n`);
  setInterval(() => {}, 1000);
}

function startChild(args: string[]): Promise<{ c: ChildProcess; info: Record<string, unknown> & { gc: number[]; pid: number } }> {
  const c = spawn(process.execPath, [import.meta.path, "--child", ...args], { windowsHide: true });
  return new Promise((res, rej) => {
    let s = "";
    c.stdout!.on("data", (d) => {
      s += d;
      const nl = s.indexOf("\n");
      if (nl >= 0) res({ c, info: JSON.parse(s.slice(0, nl)) });
    });
    c.on("exit", (code) => rej(new Error(`child exited ${code}`)));
    setTimeout(() => rej(new Error("child timeout")), 10_000);
  });
}

function cleanup(pids: number[]) {
  for (const p of pids) if (alive(p)) try {
    process.kill(p);
  } catch {
    // gone
  }
}

async function parentDies(selfJob: boolean, kind: "attached" | "detached") {
  const { c, info } = await startChild([selfJob ? "1" : "0", kind]);
  await Bun.sleep(300);
  const tree = descendants(info.pid).map((p) => p.exe);
  c.kill(); // TerminateProcess
  const ms = await diesWithin(info.gc[0]!, 5000);
  cleanup(info.gc);
  return { ...info, treeBefore: tree, grandchildDiedMs: ms };
}

async function runJob() {
  const j = createJob(false);
  const { c, info } = await startChild(["0", "attached", "detached"]);
  // In the runtime this happens right after spawn; here after the child reported, so the result
  // shows job inheritance, not the race (which the Toolhelp sweep covers).
  const h = k32.OpenProcess(SET_QUOTA_TERMINATE, 0, info.pid) as bigint;
  const assign = h === 0n ? `OpenProcess error ${k32.GetLastError()}` : k32.AssignProcessToJobObject(j, h) ? "ok" : `error ${k32.GetLastError()}`;
  if (h !== 0n) k32.CloseHandle(h);
  const r: Record<string, unknown> = { ...info, assign, jobAfterAssign: jobPids(j) };
  // Now with the job in place before the grandchildren exist: a second child spawns once assigned.
  const j2 = createJob(false);
  const c2 = spawn(process.execPath, [import.meta.path, "--child-wait"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const h2 = k32.OpenProcess(SET_QUOTA_TERMINATE, 0, c2.pid!) as bigint;
  r.assignEarly = h2 === 0n ? `OpenProcess error ${k32.GetLastError()}` : k32.AssignProcessToJobObject(j2, h2) ? "ok" : `error ${k32.GetLastError()}`;
  if (h2 !== 0n) k32.CloseHandle(h2);
  c2.stdin!.write("go\n");
  const info2 = await new Promise<{ pid: number; gc: number[] }>((res, rej) => {
    let s = "";
    c2.stdout!.on("data", (d) => {
      s += d;
      if (s.includes("\n")) res(JSON.parse(s.slice(0, s.indexOf("\n"))));
    });
    setTimeout(() => rej(new Error("child-wait timeout")), 10_000);
  });
  await Bun.sleep(300);
  r.early = { ...info2, jobPids: jobPids(j2) };
  const t0 = performance.now();
  r.terminateLate = k32.TerminateJobObject(j, 1) ? "ok" : `error ${k32.GetLastError()}`;
  r.terminateEarly = k32.TerminateJobObject(j2, 1) ? "ok" : `error ${k32.GetLastError()}`;
  r.lateDiedMs = await Promise.all([info.pid, ...info.gc].map((p) => diesWithin(p, 5000)));
  r.earlyDiedMs = await Promise.all([info2.pid, ...info2.gc].map((p) => diesWithin(p, 5000)));
  r.totalMs = Math.round(performance.now() - t0);
  cleanup([info.pid, ...info.gc, info2.pid, ...info2.gc]);
  c.kill();
  c2.kill();
  k32.CloseHandle(j);
  k32.CloseHandle(j2);
  return r;
}

async function main() {
  const i = process.argv.indexOf("--child");
  if (i >= 0) return child(process.argv[i + 1] === "1", process.argv.slice(i + 2));
  if (process.argv.includes("--child-wait")) {
    // Wait for the parent to assign this process to a job, then spawn.
    process.stdin.once("data", () => child(false, ["attached", "detached"]));
    return;
  }
  await safe("P6.selfInJob", () => inAnyJob(k32.GetCurrentProcess() as bigint));
  for (const selfJob of [false, true]) {
    for (const kind of ["attached", "detached"] as const) {
      await safe(`P6.parentDies.${selfJob ? "selfJob" : "noJob"}.${kind}`, () => parentDies(selfJob, kind));
    }
  }
  await safe("P6.runJob", runJob);
  await safe("P6.toolhelp", () => {
    const t0 = performance.now();
    const procs = snapshot();
    return { count: procs.length, ms: Math.round(performance.now() - t0), self: procs.find((p) => p.pid === process.pid) };
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(0);
}

await main();
