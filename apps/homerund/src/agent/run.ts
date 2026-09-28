import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import { claudeConfigDir, helperPath } from "../paths";

/** A push-based AsyncIterable used as the query's streaming input (§5.7 steering). */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(text: string, sessionId = ""): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buf.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.buf.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

export interface RunSpec {
  prompt: string | AsyncIterable<SDKUserMessage>;
  cwd: string;
  sessionStore: SessionStore;
  resume?: string;
  resumeSessionAt?: string;
  model?: string;
  fallbackModel?: string;
  maxBudgetUsd?: number;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  canUseTool?: CanUseTool;
  /** Root for Homerun-private state; CLAUDE_CONFIG_DIR is derived from it. */
  dataRoot?: string;
  /** Extra env for the claude process (e.g. ANTHROPIC_BASE_URL for the logging proxy). */
  extraEnv?: Record<string, string>;
  /** Spike negative control only: drop isolation. Never used by the runtime. */
  unsafeNoIsolation?: boolean;
  stderr?: (s: string) => void;
}

export const PROJECT_DIR_NAME = "homerun";

/**
 * Explicit, minimal environment for the claude subprocess. `env` REPLACES the
 * subprocess environment, so nothing from the parent leaks in by accident.
 */
export function claudeEnv(spec: Pick<RunSpec, "dataRoot" | "extraEnv" | "unsafeNoIsolation">): Record<string, string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const env: Record<string, string> = {
    PATH: process.env.HOMERUN_CHILD_PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: key,
    CLAUDE_AGENT_SDK_CLIENT_APP: "homerun/0.0.0-spike",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    // Test hook: point claude at a recording proxy or the scripted mock API (spikes/sdk).
    // Bash tool shell (F9): unset ⇒ claude uses the user's login shell and sources its profile.
    ...(process.env.HOMERUN_CHILD_SHELL ? { SHELL: process.env.HOMERUN_CHILD_SHELL } : {}),
    ...(process.env.HOMERUN_ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.HOMERUN_ANTHROPIC_BASE_URL } : {}),
    ...(spec.extraEnv ?? {}),
  };
  if (!spec.unsafeNoIsolation) {
    env.CLAUDE_CONFIG_DIR = claudeConfigDir(spec.dataRoot);
    // Stable project key independent of cwd (SDK ≥0.3.234).
    env.CLAUDE_CODE_PROJECT_DIR_NAME = PROJECT_DIR_NAME;
  }
  return env;
}

export function buildOptions(spec: RunSpec, abort: AbortController): Options {
  const iso = !spec.unsafeNoIsolation;
  return {
    abortController: abort,
    pathToClaudeCodeExecutable: helperPath("claude"),
    cwd: spec.cwd,
    env: claudeEnv(spec),
    ...(iso ? { settingSources: [], strictMcpConfig: true, skills: [], plugins: [] } : {}),
    sessionStore: spec.sessionStore,
    sessionStoreFlush: "eager",
    includePartialMessages: true,
    model: spec.model ?? process.env.HOMERUN_MODEL ?? "claude-haiku-4-5",
    fallbackModel: spec.fallbackModel,
    maxBudgetUsd: spec.maxBudgetUsd ?? (process.env.HOMERUN_MAX_BUDGET_USD ? Number(process.env.HOMERUN_MAX_BUDGET_USD) : 0.5),
    permissionMode: "default",
    tools: spec.tools ?? ["Bash", "Read", "AskUserQuestion"],
    allowedTools: spec.allowedTools,
    disallowedTools: spec.disallowedTools,
    mcpServers: spec.mcpServers ?? {},
    hooks: spec.hooks,
    canUseTool: spec.canUseTool,
    resume: spec.resume,
    resumeSessionAt: spec.resumeSessionAt,
    stderr: spec.stderr,
  };
}

export interface RunHandle {
  q: Query;
  abort: AbortController;
  messages: AsyncGenerator<SDKMessage, void>;
}

export function startRun(spec: RunSpec): RunHandle {
  const abort = new AbortController();
  const q = query({ prompt: spec.prompt as any, options: buildOptions(spec, abort) });
  return { q, abort, messages: q };
}
