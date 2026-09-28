import { readFileSync, realpathSync } from "node:fs";
import { groupAlive, killGroup, killGroupAndWait, pidAlive } from "./spawn";

/**
 * Tool processes escape `claude`'s process group (F8): the Bash tool's shell is started in a new
 * group, and with job control on, so is each pipeline in it. Killing the `claude` group alone
 * leaves them running, reparented to launchd, still doing the side effect. These helpers find them
 * by ancestry (while `claude` is alive), by session (after it died: `claude` is spawned as a
 * session leader, and its tools change group but not session), or by the config dir in their
 * command (a shell that got as far as sourcing the snapshot).
 */

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Every process, with untruncated commands (`-ww`: data dir paths are long). */
export function listProcs(): Proc[] {
  const r = Bun.spawnSync(["/bin/ps", "-Aww", "-o", "pid=,ppid=,pgid=,command="]);
  const out: Proc[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return out;
}

/** Every process below the roots (not the roots themselves). */
export function descendants(procs: readonly Proc[], roots: Iterable<number>): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const out: Proc[] = [];
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    for (const c of children.get(stack.pop()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

/**
 * Processes started for tools under this data dir, plus their subtrees. They are recognised by
 * `claudeConfigDir` in the command: the Bash tool's shell sources a snapshot from
 * `CLAUDE_CONFIG_DIR/shell-snapshots`. (Its environment is scrubbed by claude, so it cannot be
 * matched on that.) The result drops `command`, which can hold tool input.
 */
export function escapedTools(procs: readonly Proc[], claudeConfigDir: string): Proc[] {
  const dirs = new Set([claudeConfigDir]);
  try {
    dirs.add(realpathSync(claudeConfigDir));
  } catch {
    // Not created yet: nothing can reference it.
  }
  const matches = (c: string) => [...dirs].some((d) => c.includes(d + "/"));
  const self = process.pid;
  const roots = procs.filter((p) => p.pid !== self && matches(p.command));
  const all = new Map<number, Proc>();
  for (const p of [...roots, ...descendants(procs, roots.map((r) => r.pid))]) if (p.pid !== self) all.set(p.pid, { ...p, command: "" });
  return [...all.values()];
}

type GetSid = (pid: number) => number;
let getsidFn: GetSid | null | undefined;

function loadGetsid(): GetSid | null {
  if (getsidFn !== undefined) return getsidFn;
  getsidFn = null;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", { getsid: { args: [FFIType.i32], returns: FFIType.i32 } });
    getsidFn = (pid) => lib.symbols.getsid(pid) as number;
  } catch {
    // No FFI: Linux still has /proc.
  }
  return getsidFn;
}

/** The session id of a live process, or null. */
export function sessionOf(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the command, which is in parentheses and may hold spaces: state ppid pgrp session.
      const sid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]);
      return Number.isInteger(sid) && sid > 0 ? sid : null;
    } catch {
      return null;
    }
  }
  const g = loadGetsid();
  if (!g) return null;
  const sid = g(pid);
  return sid > 0 ? sid : null;
}

/**
 * Processes in the session `sid` other than its leader. `claude` is spawned with `setsid`, so its
 * pid is the session id of every tool it started, even one that moved to its own group and
 * outlived it (reparented, its command not yet showing the config dir). A tool that calls `setsid`
 * itself leaves the session; `escapedTools` is the fallback for those.
 */
export function sessionMembers(procs: readonly Proc[], sid: number): Proc[] {
  const self = process.pid;
  return procs.filter((p) => p.pid !== sid && p.pid !== self && sessionOf(p.pid) === sid);
}

/**
 * SIGKILL processes and, for each that leads its own group, the whole group (so grandchildren in
 * that group go too). Waits until they are gone (bounded). Returns the pids that were targeted.
 */
export async function killProcs(procs: readonly Proc[], timeoutMs = 5000): Promise<number[]> {
  const pids = new Set(procs.map((p) => p.pid));
  const groups = new Set(procs.filter((p) => p.pgid === p.pid && p.pgid > 1).map((p) => p.pgid));
  for (const g of groups) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const alive = () => [...pids].some((pid) => pidAlive(pid)) || [...groups].some((g) => groupAlive(g));
  const deadline = Date.now() + timeoutMs;
  while (alive() && Date.now() < deadline) await Bun.sleep(20);
  return [...pids];
}

/**
 * Kill a run's `claude` group and every process descended from it, including ones that moved to
 * their own groups, and every process left in its session. The tree is snapshotted first, while
 * the parent links still exist. While the leader is alive it must still be `claude` (its command
 * contains `leaderMarker`): a reused pid's children and session are not ours. Once it is gone, its
 * session members are the tools it left behind. The group itself is always killed, as before.
 */
export async function killRunTree(claudePid: number, leaderMarker: string, timeoutMs = 5000): Promise<number[]> {
  const procs = listProcs();
  const leader = procs.find((p) => p.pid === claudePid);
  const isClaude = !!leader && leader.command.includes(leaderMarker);
  const tree = isClaude ? descendants(procs, [claudePid]) : [];
  const session = !leader || isClaude ? sessionMembers(procs, claudePid) : [];
  const targets = new Map([...tree, ...session].map((p) => [p.pid, p]));
  killGroup(claudePid, "SIGKILL");
  const killed = await killProcs([...targets.values()], timeoutMs);
  await killGroupAndWait(claudePid, timeoutMs);
  return killed;
}
