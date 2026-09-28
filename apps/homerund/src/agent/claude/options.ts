import type { CanUseTool, HookCallbackMatcher, HookEvent, McpServerConfig, Options, SessionStore, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { EngineStart } from "../engine";

export interface ClaudeRuntimeOptions {
  claudePath: string;
  sessionStore: SessionStore;
}

/**
 * Every `query()` gets the full isolation list of §5.3; nothing is inherited from the user's
 * `~/.claude`, the working directory or the parent environment:
 * - bundled `claude`, private CLAUDE_CONFIG_DIR (in `env`), no setting sources, skills or plugins;
 * - only the spec's MCP servers, with `strictMcpConfig`;
 * - an explicit built-in tool list (never `Skill`);
 * - `permissionMode: "default"`, so every call goes through the hooks and canUseTool;
 * - the SQLite session store, flushed eagerly (F1);
 * - `env` replaces the environment completely (see env.ts).
 */
export function buildQueryOptions(
  start: EngineStart,
  rt: ClaudeRuntimeOptions,
  wiring: {
    abort: AbortController;
    hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    canUseTool: CanUseTool;
    spawn: (o: SpawnOptions) => SpawnedProcess;
    stderr: (s: string) => void;
  },
): Options {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [id, s] of Object.entries(start.mcpServers)) mcpServers[id] = { type: "stdio", command: s.command, args: s.args, env: s.env };
  return {
    abortController: wiring.abort,
    pathToClaudeCodeExecutable: rt.claudePath,
    spawnClaudeCodeProcess: wiring.spawn,
    cwd: start.cwd,
    env: start.env,
    settingSources: [],
    skills: [],
    plugins: [],
    strictMcpConfig: true,
    mcpServers,
    tools: [...start.builtinTools],
    permissionMode: "default",
    hooks: wiring.hooks,
    canUseTool: wiring.canUseTool,
    sessionStore: rt.sessionStore,
    sessionStoreFlush: "eager",
    includePartialMessages: true,
    model: start.model,
    ...(start.fallbackModel ? { fallbackModel: start.fallbackModel } : {}),
    maxBudgetUsd: start.maxBudgetUsd,
    ...(start.resume ? { resume: start.resume } : {}),
    ...(start.resume && start.resumeAt ? { resumeSessionAt: start.resumeAt } : {}),
    ...(start.appendSystemPrompt ? { systemPrompt: { type: "preset", preset: "claude_code", append: start.appendSystemPrompt } } : {}),
    stderr: wiring.stderr,
  };
}
