import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_KEY } from "../../store/session-store";

export const CHILD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export interface ClaudeEnvInput {
  apiKey: string;
  claudeConfigDir: string;
  shellHome: string;
  tmpDir: string;
  userHome: string;
  runtimeVersion: string;
  anthropicBaseUrl: string | null;
  /** "Use my shell environment" (§5.3): the user's $SHELL and real HOME. */
  useShellEnvironment: boolean;
  userShell?: string;
}

/**
 * The complete environment for `claude`. `env` replaces the child's environment, so nothing
 * from homerund's own environment leaks in (§5.3). The Bash tool gets a clean `/bin/bash` with
 * a Homerun-owned HOME holding empty profiles and an empty BASH_ENV (F9); background Bash is
 * off so every tool call finishes inside its hook window (F10).
 */
export function claudeEnv(i: ClaudeEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    PATH: CHILD_PATH,
    TMPDIR: i.tmpDir,
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: i.apiKey,
    CLAUDE_CONFIG_DIR: i.claudeConfigDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: PROJECT_KEY,
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    // Keep every MCP tool loaded directly: a deferred-tool search step would be a tool outside the spec.
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_AGENT_SDK_CLIENT_APP: `homerun/${i.runtimeVersion}`,
    HOMERUN_USER_HOME: i.userHome,
  };
  if (i.useShellEnvironment) {
    env.SHELL = i.userShell || "/bin/zsh";
    env.HOME = i.userHome;
  } else {
    env.SHELL = "/bin/bash";
    env.HOME = i.shellHome;
    env.BASH_ENV = "";
  }
  if (i.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = i.anthropicBaseUrl;
  return env;
}

/** The clean shell's HOME: empty profiles so `bash -l` sources nothing of the user's (F9). */
export function prepareShellHome(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of [".bash_profile", ".bashrc", ".profile"]) {
    const p = join(dir, f);
    if (!existsSync(p)) writeFileSync(p, "", { mode: 0o600 });
  }
}
