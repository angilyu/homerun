import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The language the Bash tool's commands are written in. Bash patterns, grants and the
 * metacharacter check (`@homerun/core`) understand bash only; any other dialect fails closed.
 */
export type ShellDialect = "bash" | "unknown";

export interface ClaudeShell {
  dialect: ShellDialect;
  /** Windows: the Git Bash the Bash tool runs, pinned as CLAUDE_CODE_GIT_BASH_PATH. */
  gitBash: string | null;
}

/**
 * On macOS and Linux the Bash tool runs /bin/bash. On Windows claude runs it through Git for
 * Windows' bash.exe, and without one it has no Bash tool but a PowerShell tool instead. homerund
 * finds Git Bash itself, pins it for claude and turns the PowerShell tool off; with no Git Bash
 * the dialect is unknown and every Bash call asks as destructive (§18).
 */
export function resolveClaudeShell(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): ClaudeShell {
  if (platform !== "win32") return { dialect: "bash", gitBash: null };
  const gitBash = findGitBash(env, exists);
  return { dialect: gitBash ? "bash" : "unknown", gitBash };
}

/**
 * Git for Windows' bash.exe, from fixed install locations only: never a PATH lookup, which
 * could find WSL's `System32\bash.exe` (another OS's bash, with its own filesystem) or a
 * planted binary. A user's CLAUDE_CODE_GIT_BASH_PATH is honoured when it is an absolute
 * `bash.exe` on a local drive outside the Windows directory.
 */
export function findGitBash(env: Record<string, string | undefined>, exists: (p: string) => boolean = existsSync): string | null {
  const systemRoot = win32.normalize(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").toLowerCase();
  const pinned = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (pinned) {
    const p = win32.normalize(pinned);
    const lower = p.toLowerCase();
    const local = /^[a-z]:\\/.test(lower);
    const underWindows = lower === systemRoot || lower.startsWith(`${systemRoot}\\`);
    if (local && !underWindows && win32.basename(lower) === "bash.exe" && exists(p)) return p;
  }
  const bases = [env.ProgramFiles, env.ProgramW6432, "C:\\Program Files", env["ProgramFiles(x86)"], "C:\\Program Files (x86)"];
  const candidates = bases.filter((b): b is string => !!b).map((b) => win32.join(b, "Git", "bin", "bash.exe"));
  if (env.LOCALAPPDATA) candidates.push(win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  return candidates.find((c) => exists(c)) ?? null;
}
