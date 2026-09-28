import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookCallbackMatcher, HookEvent, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { openDb, ThreadLog } from "../../../apps/homerund/src/store/db";
import { SqliteSessionStore } from "../../../apps/homerund/src/store/sqlite-session-store";

/** Load KEY=VALUE lines from the repo-root .env.local into process.env (never printed). */
export function loadEnvLocal(root: string): void {
  const p = join(root, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const v = m[2].replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

export function emit(kind: string, data: unknown): void {
  process.stdout.write(`EV ${JSON.stringify({ t: Date.now(), kind, data })}\n`);
}

export function openState(dir: string) {
  const db = openDb(join(dir, "homerun.db"));
  return { db, store: new SqliteSessionStore(db), log: new ThreadLog(db) };
}

const clip = (s: unknown, n = 400) => {
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str && str.length > n ? str.slice(0, n) + "…" : str;
};

/** Compact, log-friendly view of an SDK message. */
export function summarize(m: SDKMessage): unknown {
  switch (m.type) {
    case "system":
      if (m.subtype === "init") {
        const { tools, mcp_servers, skills, slash_commands, agents, plugins, apiKeySource, cwd, model, claude_code_version, session_id } = m as any;
        return { type: "system/init", session_id, tools, mcp_servers, skills, slash_commands, agents, plugins, apiKeySource, cwd, model, claude_code_version };
      }
      return { type: `system/${(m as any).subtype}`, ...pick(m as any, ["error", "status", "session_id"]) };
    case "assistant":
      return {
        type: "assistant",
        uuid: (m as any).uuid,
        content: (m.message.content as any[]).map((b) =>
          b.type === "text" ? { text: clip(b.text) } : b.type === "tool_use" ? { tool_use: { id: b.id, name: b.name, input: b.input } } : { [b.type]: true },
        ),
      };
    case "user": {
      const c = (m as any).message?.content;
      return {
        type: "user",
        uuid: (m as any).uuid,
        isSynthetic: (m as any).isSynthetic,
        content: Array.isArray(c)
          ? c.map((b: any) => (b.type === "tool_result" ? { tool_result: { id: b.tool_use_id, is_error: b.is_error, content: clip(b.content) } } : b.type === "text" ? { text: clip(b.text) } : { [b.type]: true }))
          : clip(c),
      };
    }
    case "result":
      return pick(m as any, ["type", "subtype", "is_error", "stop_reason", "terminal_reason", "deferred_tool_use", "result", "total_cost_usd", "num_turns", "session_id", "errors"]);
    case "stream_event":
      return null;
    default:
      return { type: m.type, subtype: (m as any).subtype };
  }
}

function pick(o: Record<string, unknown>, keys: string[]) {
  const r: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

export type Policy = (toolName: string, input: any, toolUseId: string) => Promise<"allow" | "defer" | { allow: Record<string, unknown> } | { deny: string } | undefined>;

/**
 * PreToolUse/PostToolUse hooks that write tool.call BEFORE dispatch and tool.result
 * AFTER completion (§5.4), plus a policy for approvals (§5.6).
 */
export function recordingHooks(log: ThreadLog, threadId: string, runId: string, policy: Policy): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input: any, toolUseId) => {
            const id = toolUseId ?? input.tool_use_id;
            const decision = await policy(input.tool_name, input.tool_input, id);
            if (decision === "defer") {
              emit("hook.pre", { tool_use_id: id, tool_name: input.tool_name, decision: "defer" });
              return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer", permissionDecisionReason: "waiting for user" } };
            }
            if (decision && typeof decision === "object" && "deny" in decision) {
              emit("hook.pre", { tool_use_id: id, tool_name: input.tool_name, decision: "deny" });
              return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.deny } };
            }
            // Only calls that will actually dispatch are recorded as tool.call.
            log.append(threadId, runId, "tool.call", { tool_use_id: id, tool_name: input.tool_name, tool_input: input.tool_input });
            emit("tool.call", { tool_use_id: id, tool_name: input.tool_name, tool_input: input.tool_input });
            if (decision && typeof decision === "object" && "allow" in decision) {
              return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: decision.allow } };
            }
            if (decision === "allow") return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
            return {};
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input: any, toolUseId) => {
            const id = toolUseId ?? input.tool_use_id;
            log.append(threadId, runId, "tool.result", { tool_use_id: id, tool_name: input.tool_name, response: clip(input.tool_response, 2000) });
            emit("tool.result", { tool_use_id: id, tool_name: input.tool_name, response: clip(input.tool_response) });
            return {};
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input: any, toolUseId) => {
            const id = toolUseId ?? input.tool_use_id;
            log.append(threadId, runId, "tool.result", { tool_use_id: id, tool_name: input.tool_name, error: clip(input.error, 2000) });
            emit("tool.result", { tool_use_id: id, tool_name: input.tool_name, error: clip(input.error) });
            return {};
          },
        ],
      },
    ],
  };
}
