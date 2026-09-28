import {
  query,
  type CanUseTool,
  type HookCallback,
  type PostToolUseFailureHookInput,
  type PostToolUseHookInput,
  type PreToolUseHookInput,
  type SDKUserMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEngine, EngineExit, EngineRun, EngineStart, UserInput } from "../engine";
import { buildQueryOptions } from "./options";
import { killRunTree } from "./process-tree";
import { spawnInGroup } from "./spawn";
import { Translator } from "./translate";

/** A push-based AsyncIterable used as the query's streaming input (§5.7 steering). */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(input: UserInput): void {
    if (this.closed) return;
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      uuid: input.uuid as SDKUserMessage["uuid"],
    };
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.buf.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const v = this.buf.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

/** Let already-received SDK messages reach the translator before a hook writes a tool call. */
async function drainTicks(n = 3) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

export class ClaudeEngine implements AgentEngine {
  constructor(private rt: { claudePath: string; claudeConfigDir?: string; sessionStore: SessionStore }) {}

  start(o: EngineStart): EngineRun {
    const queue = new InputQueue();
    for (const i of o.initialInputs) queue.push(i);
    const abort = new AbortController();
    const translator = new Translator();
    let pid: number | null = null;
    let procExit: EngineExit | null = null;
    let resolveProcExit!: () => void;
    const procExited = new Promise<void>((r) => (resolveProcExit = r));

    const flush = () => {
      for (const e of translator.flush()) o.sink(e);
    };

    const pre: HookCallback = async (input) => {
      const h = input as PreToolUseHookInput;
      await drainTicks();
      flush();
      const d = await o.gate.preTool({
        toolCallId: h.tool_use_id,
        tool: h.tool_name,
        input: h.tool_input,
        ...(h.mcp_server ? { mcpServer: h.mcp_server.name } : {}),
      });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: d.allow ? "allow" : "deny",
          ...(d.allow ? {} : { permissionDecisionReason: d.reason }),
        },
      };
    };
    const post: HookCallback = async (input) => {
      const h = input as PostToolUseHookInput;
      o.gate.postTool({ toolCallId: h.tool_use_id, ok: true, output: h.tool_response, ...(h.duration_ms !== undefined ? { durationMs: h.duration_ms } : {}) });
      return {};
    };
    const postFail: HookCallback = async (input) => {
      const h = input as PostToolUseFailureHookInput;
      o.gate.postTool({
        toolCallId: h.tool_use_id,
        ok: false,
        error: h.error,
        ...(h.is_interrupt ? { interrupted: true } : {}),
        ...(h.duration_ms !== undefined ? { durationMs: h.duration_ms } : {}),
      });
      return {};
    };
    // Same cached decision as PreToolUse, whichever fires first (§5.4, F6).
    const canUseTool: CanUseTool = async (toolName, input, opts) => {
      await drainTicks();
      flush();
      const d = await o.gate.preTool({ toolCallId: opts.toolUseID, tool: toolName, input, ...(opts.mcpServer ? { mcpServer: opts.mcpServer.name } : {}) });
      return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason };
    };

    const options = buildQueryOptions(
      o,
      this.rt,
      {
        abort,
        hooks: {
          PreToolUse: [{ hooks: [pre], timeout: 3600 }],
          PostToolUse: [{ hooks: [post] }],
          PostToolUseFailure: [{ hooks: [postFail] }],
        },
        canUseTool,
        spawn: (so) => {
          const child = spawnInGroup(
            so,
            (p) => {
              pid = p;
              o.onSpawn(p);
            },
            (chunk) => o.stderr?.(chunk),
          );
          child.once("exit", (code, signal) => {
            procExit = { code, signal };
            resolveProcExit();
          });
          return child;
        },
        stderr: (s) => o.stderr?.(s),
      },
    );

    const q = query({ prompt: queue, options });

    const exited = (async (): Promise<EngineExit> => {
      let error: string | undefined;
      try {
        for await (const m of q) for (const e of translator.push(m)) o.sink(e);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      flush();
      queue.close();
      if (pid !== null) await Promise.race([procExited, Bun.sleep(5000)]);
      const ex: EngineExit = procExit ?? { code: null, signal: null };
      return error ? { ...ex, error } : ex;
    })();

    return {
      push: (i) => queue.push(i),
      interrupt: async () => {
        try {
          await q.interrupt();
        } catch {
          /* already gone */
        }
      },
      closeInput: () => queue.close(),
      kill: () => {
        if (pid !== null) void killRunTree(pid, this.rt.claudePath, 5000);
      },
      reap: async () => {
        if (pid !== null) await killRunTree(pid, this.rt.claudePath, 5000, this.rt.claudeConfigDir);
      },
      get pid() {
        return pid;
      },
      exited,
    };
  }
}
