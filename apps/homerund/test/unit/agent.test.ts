import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "../../src/agent/claude/options";
import { claudeEnv, CHILD_PATH } from "../../src/agent/claude/env";
import { Translator } from "../../src/agent/claude/translate";
import type { EngineStart } from "../../src/agent/engine";

const m = (x: unknown) => x as SDKMessage;
const stream = (event: unknown, parent: string | null = null) => m({ type: "stream_event", event, parent_tool_use_id: parent, session_id: "s", uuid: crypto.randomUUID() });
const assistant = (id: string, content: unknown[], parent: string | null = null) =>
  m({ type: "assistant", message: { id, model: "claude-haiku-4-5", content }, parent_tool_use_id: parent, session_id: "s", uuid: crypto.randomUUID() });

describe("SDK messages → engine events (translate)", () => {
  test("text deltas stream; the final is emitted once at message_stop, joined across blocks", () => {
    const t = new Translator();
    const out = [
      ...t.push(stream({ type: "message_start", message: { id: "msg_1" } })),
      ...t.push(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })),
      ...t.push(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hel" } })),
      ...t.push(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } })),
      ...t.push(assistant("msg_1", [{ type: "thinking", thinking: "hmm" }])),
      ...t.push(assistant("msg_1", [{ type: "text", text: "Hello" }])),
      ...t.push(stream({ type: "message_stop" })),
    ];
    expect(out).toEqual([
      { type: "delta", messageId: "msg_1", text: "Hel" },
      { type: "delta", messageId: "msg_1", text: "lo" },
      { type: "message", messageId: "msg_1", text: "Hello", model: "claude-haiku-4-5" },
    ]);
  });

  test("a tool_use block flushes the text before it; later text of the same message gets a new id", () => {
    const t = new Translator();
    t.push(stream({ type: "message_start", message: { id: "msg_2" } }));
    const a = t.push(assistant("msg_2", [{ type: "text", text: "Let me check." }]));
    const b = t.push(assistant("msg_2", [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }]));
    expect(a).toEqual([]);
    expect(b).toEqual([{ type: "message", messageId: "msg_2", text: "Let me check.", model: "claude-haiku-4-5" }]);
    t.push(assistant("msg_2", [{ type: "text", text: "More." }]));
    expect(t.flush()).toEqual([{ type: "message", messageId: "msg_2:2", text: "More.", model: "claude-haiku-4-5" }]);
  });

  test("tool results in user frames, init, retries and results", () => {
    const t = new Translator();
    expect(t.push(m({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "no" }] } }))).toEqual([
      { type: "tool_result_seen", toolCallId: "toolu_1", isError: true, content: "no" },
    ]);
    expect(t.push(m({ type: "system", subtype: "init", session_id: "s", tools: ["Bash"], mcp_servers: [{ name: "fixture", status: "connected" }], model: "claude-haiku-4-5" }))).toEqual([
      { type: "session", sessionId: "s", tools: ["Bash"], mcpServers: [{ name: "fixture", status: "connected" }], skills: [], plugins: [], model: "claude-haiku-4-5" },
    ]);
    expect(t.push(m({ type: "system", subtype: "api_retry", retry_delay_ms: 500 }), 1000)).toEqual([{ type: "status", detail: "retrying_model", retryAt: 1500 }]);
    expect(t.push(m({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.01, user_message_uuids: ["u1"], result: "ok" }))).toEqual([
      { type: "result", ok: true, subtype: "success", totalCostUsd: 0.01, consumed: ["u1"], queuedTurnCount: null, errors: [], text: "ok" },
    ]);
    expect(t.push(m({ type: "result", subtype: "error_max_budget_usd", is_error: true, errors: ["budget"] }))[0]).toMatchObject({ ok: false, subtype: "error_max_budget_usd", errors: ["budget"] });
    expect(t.push(m({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0, user_message_uuids: [], structured_output: { changed: false } }))[0]).toMatchObject({
      structuredOutput: { changed: false },
    });
  });
});

describe("isolation (§5.3, F9, F10)", () => {
  const input = {
    apiKey: "k",
    claudeConfigDir: "/d/claude-config/r1",
    shellHome: "/d/shell-home",
    tmpDir: "/d/tmp",
    userHome: "/Users/u",
    runtimeVersion: "0.0.0",
    anthropicBaseUrl: null,
    useShellEnvironment: false,
  };

  test("the child environment is complete and owned: no inherited variables, clean bash, private config dir", () => {
    const env = claudeEnv(input);
    expect(env).toMatchObject({
      PATH: CHILD_PATH,
      HOME: "/d/shell-home",
      SHELL: "/bin/bash",
      BASH_ENV: "",
      CLAUDE_CONFIG_DIR: "/d/claude-config/r1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      ANTHROPIC_API_KEY: "k",
    });
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // Exactly these variables: nothing of homerund's own environment is inherited.
    expect(Object.keys(env).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY", "BASH_ENV", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_PROJECT_DIR_NAME", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "ENABLE_TOOL_SEARCH", "HOME", "HOMERUN_USER_HOME", "LANG", "PATH", "SHELL", "TMPDIR",
      ].sort(),
    );
    expect(claudeEnv({ ...input, useShellEnvironment: true, userShell: "/bin/zsh" })).toMatchObject({ HOME: "/Users/u", SHELL: "/bin/zsh" });
  });

  test("query() options carry the whole isolation list", () => {
    const start = {
      runId: "r",
      cwd: "/w",
      appendSystemPrompt: null,
      model: "claude-haiku-4-5",
      fallbackModel: null,
      maxBudgetUsd: 0.5,
      builtinTools: ["Bash"],
      mcpServers: { fixture: { command: "/bin/node", args: ["f.js"], env: {} } },
      resume: "sess",
      env: claudeEnv(input),
    } as unknown as EngineStart;
    const o = buildQueryOptions(start, { claudePath: "/x/claude", sessionStore: {} as never }, {
      abort: new AbortController(),
      hooks: {},
      canUseTool: async () => ({ behavior: "deny", message: "" }),
      spawn: () => ({}) as never,
      stderr: () => {},
    });
    expect(o).toMatchObject({
      pathToClaudeCodeExecutable: "/x/claude",
      settingSources: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true,
      tools: ["Bash"],
      permissionMode: "default",
      sessionStoreFlush: "eager",
      includePartialMessages: true,
      maxBudgetUsd: 0.5,
      resume: "sess",
      mcpServers: { fixture: { type: "stdio", command: "/bin/node", args: ["f.js"], env: {} } },
    });
    expect(o.env).toBe(start.env);
    expect(o.tools).not.toContain("Skill");
  });
});
