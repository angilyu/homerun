import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { killRunTree } from "../agent/claude/process-tree";
import { pidAlive, spawnInGroup } from "../agent/claude/spawn";
import { bootTime, killEscapedTools, killStaleGroup } from "../runs/process-groups";
import { windowsProcesses } from "./windows-processes";

/**
 * How the runtime owns the processes it starts (§5.1): the one place that differs by OS. POSIX
 * uses process groups and sessions, found with `ps` (the modules this binds); Windows uses job
 * objects and Toolhelp snapshots (`windows-processes.ts`). Everything else calls through here.
 */
export interface ProcessPlatform {
  /**
   * Called once at startup, before anything is spawned: make sure whatever the runtime starts dies
   * with it. POSIX has nothing to do (the stale-group sweep covers a killed runtime); Windows puts
   * the runtime in a kill-on-close job.
   */
  adoptTree(): void;
  /** Boot time in whole seconds, to tell a recorded pid from a reused one after a reboot. */
  bootTime(): number;
  /** Spawn `claude` so that `killRunTree(pid)` reaches it and everything it starts. */
  spawnClaude(opts: SpawnOptions, onSpawn: (pid: number) => void, onStderr?: (chunk: string) => void): SpawnedProcess;
  /** Whether a process is alive (and not a zombie). */
  pidAlive(pid: number | null | undefined): boolean;
  /** Kill a run's `claude` and every process it started; resolves with the pids targeted. */
  killRunTree(claudePid: number, claudePath: string, timeoutMs?: number, claudeConfigDir?: string): Promise<number[]>;
  /** Kill what a previous runtime's run left, if it is still ours (§5.4 step 1). */
  killStaleGroup(pid: number, recordedBoot: number | null, currentBoot: number, markers: readonly string[], claudePath: string): Promise<boolean>;
  /** Kill tool processes that outlived their `claude` (F8). Only with no run active. */
  killEscapedTools(claudeConfigDir: string): Promise<number[]>;
}

export const posixProcesses: ProcessPlatform = {
  adoptTree: () => {},
  bootTime,
  spawnClaude: spawnInGroup,
  pidAlive,
  killRunTree: (pid, claudePath, timeoutMs = 5000, configDir) => killRunTree(pid, claudePath, timeoutMs, configDir),
  killStaleGroup,
  killEscapedTools,
};

export const processes: ProcessPlatform = process.platform === "win32" ? windowsProcesses : posixProcesses;
