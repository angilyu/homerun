import { SessionSpec, type BuiltinTool } from "@homerun/core";
import type { Config } from "../config";
import { getTaskVersionSpec, type RunRow } from "../store/rows";
import type { Store } from "../store/store";

/**
 * Built-ins for one-off chats (plan Q4): reading and research only until approvals exist (M6).
 * AskUserQuestion is left out until questions can be answered (M6); WebFetch and WebSearch
 * are listed but need approval, so they are denied outside `--dev-auto-approve`.
 */
export const CHAT_TOOLS: readonly BuiltinTool[] = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

export function chatSpec(config: Config): SessionSpec {
  return SessionSpec.parse({
    kind: "session",
    format: 1,
    name: "Chat",
    prompt: "You are chatting with the user in Homerun.",
    budget: { max_run_usd: config.chatMaxBudgetUsd },
    tools: { builtin: [...CHAT_TOOLS], mcp_servers: [], homerun: [] },
    policy: {
      roots: [],
      egress: { mode: "allowlist", domains: [] },
      bash_patterns: [],
      use_shell_environment: false,
      input_timeout: { action: "wait", remind_after_ms: null },
      retention_days: 30,
    },
    model: { model: config.chatModel, ...(config.chatFallbackModel ? { fallback_model: config.chatFallbackModel } : {}) },
  });
}

/** The spec a run executes: its task version, or the chat default for a thread with no task. */
export function specForRun(store: Store, config: Config, run: Pick<RunRow, "task_id" | "task_version">): SessionSpec {
  if (!run.task_id || !run.task_version) return chatSpec(config);
  const spec = getTaskVersionSpec(store, run.task_id, run.task_version);
  if (!spec) throw new Error(`task ${run.task_id} v${run.task_version} not found`);
  if (spec.kind !== "session") throw new Error("monitor runs arrive in a later milestone");
  return spec;
}
