import { spawn } from "node:child_process";
import { uptime } from "node:os";
import { win32 } from "node:path";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  assignProcessHandle,
  closeHandle,
  createJob,
  currentProcess,
  openProcess,
  pidAlive,
  PROCESS_SET_QUOTA,
  PROCESS_TERMINATE,
  processCreationTime,
  processImagePath,
  processSnapshot,
  terminateJob,
  terminateProcess,
  type ProcEntry,
} from "@homerun/win32";
import { log } from "../log";
import type { ProcessPlatform } from "./processes";

/**
 * Process ownership on Windows (§5.1), with job objects where POSIX has process groups:
 *
 * - The runtime puts itself in a kill-on-close job at startup, and never closes the handle; when
 *   the runtime dies, however it dies, the handle closes and everything it started dies with it.
 *   A killed runtime therefore leaves nothing for the next one to sweep, which is why there are
 *   no escaped tools to find here (and no command lines to find them by).
 * - Each run's `claude` gets its own kill-on-close job, assigned as soon as it is spawned, which
 *   the processes it starts join. Killing the run terminates that job.
 * - A Toolhelp sweep of the tree below `claude` (parent pid, and a creation time no earlier than
 *   the parent's, so a reused parent pid adopts nothing) catches anything started in the moment
 *   before the job was assigned.
 *
 * Probe P6 (windows-latest) showed all three: a detached grandchild survives its parent without
 * a job, and dies with a self job or a per-run job assigned early.
 */

let selfJob: bigint | null = null;
const runJobs = new Map<number, { job: bigint; created: bigint | null }>();

function adoptTree(): void {
  if (selfJob !== null) return;
  try {
    const job = createJob({ killOnClose: true });
    assignProcessHandle(job, currentProcess());
    selfJob = job;
  } catch (e) {
    log.warn("could not put the runtime in a job; its processes may outlive it", { err: String(e) });
  }
}

/** Boot time in whole seconds: now less uptime. It wanders by a second or so; compare with `sameBoot`. */
function bootTime(): number {
  return Math.round(Date.now() / 1000 - uptime());
}

export const sameBoot = (a: number, b: number) => Math.abs(a - b) <= 2;

function spawnClaude(opts: SpawnOptions, onSpawn: (pid: number) => void, onStderr?: (chunk: string) => void): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: Object.fromEntries(Object.entries(opts.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid) {
    try {
      const job = createJob({ killOnClose: true });
      const h = openProcess(pid, PROCESS_SET_QUOTA | PROCESS_TERMINATE);
      try {
        assignProcessHandle(job, h);
      } finally {
        closeHandle(h);
      }
      runJobs.set(pid, { job, created: createdOrNull(pid) });
    } catch (e) {
      log.warn("could not put claude in a job; killing it falls back to its process tree", { pid, err: String(e) });
    }
    onSpawn(pid);
  }
  // The SDK reads only stdout; stderr must be drained or claude can block on a full pipe.
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => onStderr?.(d));
  // The SDK aborts via this signal. Windows has no graceful signal to send; take the tree down.
  opts.signal.addEventListener("abort", () => pid && void killRunTree(pid, opts.command, 5000), { once: true });
  return child as unknown as SpawnedProcess;
}

function createdOrNull(pid: number): bigint | null {
  try {
    return processCreationTime(pid);
  } catch {
    return null;
  }
}

/**
 * The processes below `root` in a snapshot, following parent pids. A child counts only if it was
 * created no earlier than its parent: Windows reuses pids and never rewrites a parent pid, so a
 * process whose recorded parent is younger than itself belongs to someone else. A process whose
 * creation time can't be read (another user's) is left out.
 */
export function treeBelow(procs: readonly ProcEntry[], root: number, createdOf: (pid: number) => bigint | null): number[] {
  const children = new Map<number, number[]>();
  for (const p of procs) if (p.pid !== p.ppid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const born = new Map<number, bigint | null>();
  const bornOf = (pid: number) => {
    if (!born.has(pid)) born.set(pid, createdOf(pid));
    return born.get(pid)!;
  };
  const out: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    const parent = queue.shift()!;
    const parentBorn = bornOf(parent);
    if (parentBorn === null) continue;
    for (const c of children.get(parent) ?? []) {
      if (seen.has(c)) continue;
      const b = bornOf(c);
      if (b === null || b < parentBorn) continue;
      seen.add(c);
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

const samePath = (a: string, b: string) => win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();

function imageIs(pid: number, paths: readonly string[]): boolean {
  try {
    const image = processImagePath(pid);
    return paths.some((p) => win32.isAbsolute(p) && samePath(image, p));
  } catch {
    return false;
  }
}

/**
 * Kill a run's `claude` and everything below it: its job, then whatever the snapshot finds below
 * it that the job missed. Without a job on record (a stale pid), the root must still be `claude`
 * by its image path, or nothing is touched. Resolves with the pids targeted.
 */
async function killRunTree(claudePid: number, claudePath: string, timeoutMs = 5000): Promise<number[]> {
  const rec = runJobs.get(claudePid);
  runJobs.delete(claudePid);
  const procs = processSnapshot();
  const rootCreated = rec?.created ?? createdOrNull(claudePid);
  const ours = rec !== undefined ? rootCreated === null || pidAlive(claudePid, rootCreated) : imageIs(claudePid, [claudePath]);
  const tree = ours ? treeBelow(procs, claudePid, (pid) => (pid === claudePid ? rootCreated : createdOrNull(pid))) : [];
  const created = new Map(tree.map((pid) => [pid, createdOrNull(pid)]));
  if (rec) {
    try {
      terminateJob(rec.job);
    } catch {}
    closeHandle(rec.job);
  }
  const targets = ours ? [claudePid, ...tree] : [];
  for (const pid of targets) terminateProcess(pid);
  const alive = () => targets.some((pid) => pidAlive(pid, (pid === claudePid ? rootCreated : created.get(pid)) ?? undefined));
  const deadline = Date.now() + timeoutMs;
  while (alive() && Date.now() < deadline) await Bun.sleep(20);
  return targets;
}

/**
 * A run a previous runtime left (§5.4 step 1). Normally there is none: that runtime's job took
 * its processes with it. If it could not make one, a recorded `claude` from this boot that is
 * still running the bundled binary (or a configured MCP server's) is killed with its tree.
 */
async function killStaleGroup(pid: number, recordedBoot: number | null, currentBoot: number, markers: readonly string[], claudePath: string): Promise<boolean> {
  if (recordedBoot !== null && !sameBoot(recordedBoot, currentBoot)) return false;
  if (!pidAlive(pid) || !imageIs(pid, [claudePath, ...markers])) return false;
  log.warn("killing a stale claude and its tree", { pid });
  let image: string;
  try {
    image = processImagePath(pid);
  } catch {
    return false;
  }
  await killRunTree(pid, image);
  return !pidAlive(pid);
}

export const windowsProcesses: ProcessPlatform = {
  adoptTree,
  bootTime,
  spawnClaude,
  pidAlive: (pid) => !!pid && pidAlive(pid),
  killRunTree: (pid, claudePath, timeoutMs) => killRunTree(pid, claudePath, timeoutMs),
  killStaleGroup,
  killEscapedTools: async () => [],
};
