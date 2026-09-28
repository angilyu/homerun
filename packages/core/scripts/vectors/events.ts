import { bad, badRule, ok, type Vector } from "./types";
import * as F from "./fixtures";

const P = F.persisted;
const L = F.live;
const E = "ThreadEvent";

const userMessage = { client_msg_id: F.CLIENT_MSG, text: "Bump astro and open a PR", origin: F.origin("ios", F.PHONE), disposition: "started_run" };
const toolCall = {
  tool_call_id: F.TOOL_CALL,
  tool: "Bash",
  class: "write",
  input: F.inline({ command: "npm install astro@5.2.0" }),
  policy: "granted",
  grant_id: F.GRANT,
};
const runEnd = { state: "succeeded", outcome: null, error: null, authority: "full", cost_usd: 0.42 };

export const events: Vector[] = [
  // user.message
  ok(E, "user.message started a run", P("user.message", userMessage)),
  ok(E, "user.message queued from phone", P("user.message", { ...userMessage, sent_at: F.T0 - 3 * 3_600_000 })),
  ok(E, "user.message steering from web", P("user.message", { ...userMessage, origin: F.origin("web", F.PHONE), disposition: "steered" })),
  bad(E, "user.message without origin", P("user.message", { ...userMessage, origin: undefined })),
  bad(E, "user.message empty text", P("user.message", { ...userMessage, text: "" })),
  // message.final
  ok(E, "message.final", P("message.final", { message_id: F.MESSAGE, role: "assistant", text: "Opened PR #12.", model: "claude-sonnet-4-5" })),
  ok(E, "message.final from subagent", P("message.final", { message_id: F.MESSAGE, role: "assistant", text: "Found 3 files.", parent_tool_call_id: F.TOOL_CALL })),
  bad(E, "message.final with user role", P("message.final", { message_id: F.MESSAGE, role: "user", text: "hi" })),
  // message.delta (live-only)
  ok(E, "message.delta", L("message.delta", { message_id: F.MESSAGE, index: 0, text: "Opened " })),
  bad(E, "message.delta with seq instead of after_seq", { ...P("message.delta", { message_id: F.MESSAGE, index: 0, text: "x" }) }),
  bad(E, "message.delta negative index", L("message.delta", { message_id: F.MESSAGE, index: -1, text: "x" })),
  // tool.call
  ok(E, "tool.call granted", P("tool.call", toolCall)),
  ok(E, "tool.call MCP needs approval", P("tool.call", {
    tool_call_id: F.TOOL_CALL,
    tool: "mcp__github__create_issue",
    class: "write",
    mcp_server: "github",
    input: F.inline({ title: "Bump astro" }),
    policy: "needs_approval",
  })),
  ok(E, "tool.call with blob input", P("tool.call", {
    ...toolCall,
    tool: "Write",
    policy: "allowed",
    grant_id: undefined,
    input: { kind: "blob", sha256: F.SHA, size: 200_000, preview: "{\"file_path\":\"src/big.ts\"", expired: false },
  })),
  bad(E, "tool.call unknown policy", P("tool.call", { ...toolCall, policy: "maybe" })),
  bad(E, "tool.call raw input", P("tool.call", { ...toolCall, input: { command: "ls" } })),
  // tool.result
  ok(E, "tool.result ok", P("tool.result", { tool_call_id: F.TOOL_CALL, status: "ok", output: F.inline("added 1 package"), duration_ms: 1840 })),
  ok(E, "tool.result denied", P("tool.result", { tool_call_id: F.TOOL_CALL, status: "denied", output: null })),
  ok(E, "tool.result resolved after crash", P("tool.result", { tool_call_id: F.TOOL_CALL, status: "resolved_not_run", output: null })),
  ok(E, "tool.result expired blob", P("tool.result", {
    tool_call_id: F.TOOL_CALL,
    status: "ok",
    output: { kind: "blob", sha256: F.SHA, size: 5_000_000, preview: "…", expired: true },
  })),
  bad(E, "tool.result unknown status", P("tool.result", { tool_call_id: F.TOOL_CALL, status: "maybe", output: null })),
  // input.requested / input.resolved
  ok(E, "input.requested approval", P("input.requested", { request_id: F.REQUEST, prompt: F.approvalPrompt(), required_authority: "full", expires_at: null })),
  ok(E, "input.requested question", P("input.requested", { request_id: F.REQUEST, prompt: F.questionPrompt(), required_authority: "any", expires_at: F.T0 + 3_600_000 })),
  bad(E, "input.requested unknown authority", P("input.requested", { request_id: F.REQUEST, prompt: F.questionPrompt(), required_authority: "web", expires_at: null })),
  ok(E, "input.resolved answered from lock screen", P("input.resolved", {
    request_id: F.REQUEST,
    state: "answered",
    response: { type: "approval", decision: "allow" },
    answered_by: F.PHONE,
    surface: "ios",
    via: "notification",
  })),
  ok(E, "input.resolved expired", P("input.resolved", { request_id: F.REQUEST, state: "expired", response: null, answered_by: null, surface: null, via: null })),
  badRule(E, "input.resolved answered without who", P("input.resolved", {
    request_id: F.REQUEST,
    state: "answered",
    response: { type: "approval", decision: "allow" },
    answered_by: null,
    surface: null,
    via: null,
  })),
  // run lifecycle
  ok(E, "run.started by message", P("run.started", {
    trigger: "message",
    authority: "full",
    origin: F.origin("ios", F.PHONE),
    task_id: F.TASK,
    task_version: 3,
    scheduled_for: null,
    attempt: 0,
  })),
  ok(E, "run.started by schedule", P("run.started", {
    trigger: "schedule",
    authority: "full",
    origin: null,
    task_id: F.TASK,
    task_version: 3,
    scheduled_for: F.T0,
    attempt: 1,
  })),
  bad(E, "run.started unknown trigger", P("run.started", {
    trigger: "webhook",
    authority: "full",
    origin: null,
    task_id: null,
    task_version: null,
    scheduled_for: null,
    attempt: 0,
  })),
  ok(E, "run.resumed", P("run.resumed", { reason: "runtime_restart" })),
  ok(E, "run.resumed after the agent exited", P("run.resumed", { reason: "agent_exited" })),
  bad(E, "run.resumed unknown reason", P("run.resumed", { reason: "because" })),
  ok(E, "run.cancelled by user", P("run.cancelled", { by: F.origin("desktop"), reason: "user" })),
  ok(E, "run.cancelled by input timeout", P("run.cancelled", { by: null, reason: "input_timeout" })),
  bad(E, "run.cancelled unknown reason", P("run.cancelled", { by: null, reason: "boredom" })),
  ok(E, "run.end succeeded", P("run.end", runEnd)),
  ok(E, "run.end monitor changed", P("run.end", { ...runEnd, outcome: "changed", cost_usd: 0.01 })),
  ok(E, "run.end failed", P("run.end", { ...runEnd, state: "failed", error: { code: "budget_exceeded", message: "max_run_usd reached" } })),
  bad(E, "run.end non-terminal state", P("run.end", { ...runEnd, state: "running" })),
  badRule(E, "run.end outcome on cancelled", P("run.end", { ...runEnd, state: "cancelled", outcome: "no_change" })),
  badRule(E, "run.end error on success", P("run.end", { ...runEnd, error: { code: "x", message: "y" } })),
  ok(E, "schedule.missed while asleep", P("schedule.missed", { schedule_id: F.SCHEDULE, scheduled_for: F.T0, reason: "asleep", count: 3 }, { run_id: null })),
  bad(E, "schedule.missed zero count", P("schedule.missed", { schedule_id: F.SCHEDULE, scheduled_for: F.T0, reason: "asleep", count: 0 }, { run_id: null })),
  // run.status (live-only)
  ok(E, "run.status queued", L("run.status", { state: "pending", detail: "queued", queue_position: 2 })),
  ok(E, "run.status retrying", L("run.status", { state: "running", detail: "retrying_model", retry_at: F.T0 + 30_000 })),
  bad(E, "run.status unknown detail", L("run.status", { state: "running", detail: "thinking" })),
  // envelope
  bad(E, "unknown event type", P("run.paused", {})),
  bad(E, "persisted event without seq", { ...P("run.resumed", { reason: "input_answered" }), seq: undefined }),
  bad(E, "seq zero", P("run.resumed", { reason: "input_answered" }, { seq: 0 })),
  // the narrower unions
  ok("PersistedThreadEvent", "tool.call", P("tool.call", toolCall)),
  bad("PersistedThreadEvent", "live-only delta", L("message.delta", { message_id: F.MESSAGE, index: 0, text: "x" })),
  ok("LiveThreadEvent", "delta", L("message.delta", { message_id: F.MESSAGE, index: 3, text: "x" })),
  bad("LiveThreadEvent", "persisted event", P("run.resumed", { reason: "input_answered" })),
];
