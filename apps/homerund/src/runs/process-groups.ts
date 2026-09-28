import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { groupAlive, killGroupAndWait } from "../agent/claude/spawn";
import { log } from "../log";

/** Boot time in whole seconds, to tell a recorded pid from a reused one after a reboot (plan Q6). */
export function bootTime(): number {
  if (process.platform === "darwin") {
    const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
    const m = /sec = (\d+)/.exec(r.stdout.toString());
    if (m) return Number(m[1]);
  } else if (existsSync("/proc/stat")) {
    const m = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    if (m) return Number(m[1]);
  }
  return 0;
}

/** Commands of every live member of a process group. */
export function groupCommands(pgid: number): string[] {
  const r = Bun.spawnSync(["/bin/ps", "-A", "-o", "pgid=,command="]);
  const out: string[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) === pgid) out.push(m[2]!);
  }
  return out;
}

/**
 * Whether a recorded group is still ours: same boot, still alive, and some member is the bundled
 * `claude`, a shell it started, or a configured MCP server. A reused pid fails one of these.
 */
export function isOurGroup(pgid: number, recordedBoot: number | null, currentBoot: number, markers: readonly string[]): boolean {
  if (recordedBoot !== null && recordedBoot !== currentBoot) return false;
  if (!groupAlive(pgid)) return false;
  return groupCommands(pgid).some((c) => markers.some((m) => c.includes(m)));
}

/** Kill a stale group left by a previous runtime (§5.4 step 1), if it is still ours. */
export async function killStaleGroup(pgid: number, recordedBoot: number | null, currentBoot: number, markers: readonly string[]): Promise<boolean> {
  if (!isOurGroup(pgid, recordedBoot, currentBoot, markers)) return false;
  log.warn("killing stale process group", { pgid });
  return killGroupAndWait(pgid, 5000);
}

/**
 * Remove caches a killed `claude` or SDK leaves behind (F1, F5): the local JSONL under
 * `CLAUDE_CONFIG_DIR/projects` (SQLite is the source of truth) and the SDK's `claude-resume-*`
 * temporary config dirs.
 */
export function sweepTemp(claudeConfigDir: string, tmpDir: string): { removed: string[] } {
  const removed: string[] = [];
  const rm = (p: string) => {
    rmSync(p, { recursive: true, force: true });
    removed.push(p);
  };
  const projects = join(claudeConfigDir, "projects");
  if (existsSync(projects)) for (const d of readdirSync(projects)) rm(join(projects, d));
  for (const dir of [tmpDir, claudeConfigDir]) {
    if (!existsSync(dir)) continue;
    for (const d of readdirSync(dir)) if (d.startsWith("claude-resume-")) rm(join(dir, d));
  }
  return { removed };
}
