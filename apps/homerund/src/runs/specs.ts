import { SessionSpec, type BuiltinTool, type MonitorSpec } from "@homerun/core";
import type { Config } from "../config";
import { getTaskVersionSpec, type RunRow } from "../store/rows";
import type { Store } from "../store/store";

/**
 * Built-ins for one-off chats (§2.1): reading, research and questions. A chat has no task to
 * hold grants, so each call outside the policy is approved on its own (§5.6).
 */
export const CHAT_TOOLS: readonly BuiltinTool[] = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion"];

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

/**
 * The spec a run executes: its task version, the chat default for a thread with no task, or for
 * a monitor, the session its act step runs (§8.3 step 4) or, for a message on its thread, the
 * reply session (§5.7).
 */
export function specForRun(store: Store, config: Config, run: Pick<RunRow, "task_id" | "task_version" | "monitor_phase">): SessionSpec {
  if (!run.task_id || !run.task_version) return chatSpec(config);
  const spec = getTaskVersionSpec(store, run.task_id, run.task_version);
  if (!spec) throw new Error(`task ${run.task_id} v${run.task_version} not found`);
  if (spec.kind === "monitor") return run.monitor_phase ? actSpec(spec) : replySpec(spec);
  return spec;
}

/** A message on a monitor's thread (§5.7): the monitor's tools and policy with its act model. */
export function isMonitorReply(store: Store, run: Pick<RunRow, "task_id" | "task_version" | "monitor_phase">): boolean {
  if (run.monitor_phase || !run.task_id || !run.task_version) return false;
  return getTaskVersionSpec(store, run.task_id, run.task_version)?.kind === "monitor";
}

export function replySpec(m: MonitorSpec): SessionSpec {
  const context = [
    "The user is replying on the thread of this Homerun monitor. Your earlier messages in the thread are the monitor's reports.",
    "Answer the user's question or do what they ask with the monitor's tools. You do not run the monitor's check, and nothing you do changes its schedule or state.",
  ].join(" ");
  return SessionSpec.parse({
    kind: "session",
    format: m.format,
    name: m.name,
    prompt: [m.prompt, context].filter(Boolean).join("\n\n"),
    budget: m.budget,
    tools: m.tools,
    policy: m.policy,
    model: m.act.model,
  });
}

/** The act step of a monitor: the task's prompt, tools and policy, with the act model. */
export function actSpec(m: MonitorSpec): SessionSpec {
  const context = [
    "You are the act step of a Homerun monitor. Its check just found a change; the next message says what it saw.",
    "Your report goes to the user's monitor thread. Keep it short and specific: what changed, and what you did about it.",
  ].join(" ");
  return SessionSpec.parse({
    kind: "session",
    format: m.format,
    name: m.name,
    prompt: [m.prompt, m.act.instructions, context].filter(Boolean).join("\n\n"),
    budget: m.budget,
    tools: m.tools,
    policy: m.policy,
    model: m.act.model,
  });
}
