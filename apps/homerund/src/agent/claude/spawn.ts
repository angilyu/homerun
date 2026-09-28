import { spawn } from "node:child_process";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

/**
 * Spawn `claude` as the leader of its own process group (§5.1, F8), so the runtime can kill it
 * and everything it started (the Bash tool's shell, MCP servers) with one `kill(-pgid)`.
 * `detached: true` makes the child a session and group leader: pgid = pid (verified on Bun).
 */
export function spawnInGroup(opts: SpawnOptions, onSpawn: (pid: number) => void, onStderr?: (chunk: string) => void): SpawnedProcess {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: Object.fromEntries(Object.entries(opts.env).filter((e): e is [string, string] => e[1] !== undefined)),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (child.pid) onSpawn(child.pid);
  // The SDK reads only stdout; stderr must be drained or claude can block on a full pipe.
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => onStderr?.(d));
  // The SDK aborts via this signal; take the whole group down, not just the leader.
  opts.signal.addEventListener("abort", () => killGroup(child.pid, "SIGTERM"), { once: true });
  return child as unknown as SpawnedProcess;
}

export function killGroup(pgid: number | null | undefined, signal: NodeJS.Signals = "SIGKILL"): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

export function groupAlive(pgid: number | null | undefined): boolean {
  if (!pgid || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGKILL a group and wait until no member is left (bounded). */
export async function killGroupAndWait(pgid: number | null | undefined, timeoutMs = 5000): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  killGroup(pgid, "SIGKILL");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pgid)) return true;
    await Bun.sleep(20);
  }
  return !groupAlive(pgid);
}
