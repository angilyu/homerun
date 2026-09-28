import { methodSchemaIds, notificationSchemaId, type MethodName, type NotificationName } from "../../src/index";
import { bad, badRule, ok, type Vector } from "./types";
import * as F from "./fixtures";

type Case = [name: string, value: unknown];
type Spec = { params: Case[]; badParams: Case[]; badParamsRule?: Case[]; results: Case[]; badResults?: Case[] };

const hello = {
  protocol: { min: 1, max: 1 },
  role: "shell",
  auth: { kind: "launch_token", token: F.LAUNCH_TOKEN },
  client: { name: "homerun-shell", version: "0.1.0" },
  capabilities: [],
};

const approvalAnswer = { request_id: F.REQUEST, response: { type: "approval", decision: "allow" }, via: "app" };

const METHOD_VECTORS: Record<MethodName, Spec> = {
  hello: {
    params: [
      ["shell", hello],
      ["webview connection", { ...hello, role: "webview" }],
      ["cli", { ...hello, role: "cli", auth: { kind: "cli_token", token: F.CLI_TOKEN }, client: { name: "homerun-cli", version: "0.1.0" } }],
      ["ios with capabilities", { ...hello, role: "ios", auth: { kind: "paired_device", device_id: F.PHONE }, capabilities: ["future.feature"] }],
      ["range 1..3", { ...hello, protocol: { min: 1, max: 3 } }],
    ],
    badParams: [
      ["spike shape", { token: F.LAUNCH_TOKEN, client: "shell", protocol: 1 }],
      ["short launch token", { ...hello, auth: { kind: "launch_token", token: "abc" } }],
      ["unknown role", { ...hello, role: "admin" }],
    ],
    badParamsRule: [
      ["cli claiming shell", { ...hello, auth: { kind: "cli_token", token: F.CLI_TOKEN } }],
      ["web with launch token", { ...hello, role: "web" }],
      ["min above max", { ...hello, protocol: { min: 2, max: 1 } }],
    ],
    results: [["negotiated", { protocol: 1, runtime_version: "0.1.0", device_id: F.DEVICE, role: "shell", capabilities: [] }]],
    badResults: [["no device id", { protocol: 1, runtime_version: "0.1.0", role: "shell", capabilities: [] }]],
  },
  "cli.request_access": {
    params: [["first run", { client: { name: "homerun-cli", version: "0.1.0" }, hostname: "studio.local" }]],
    badParams: [["no client", { hostname: "studio.local" }]],
    results: [["pending", { request_id: F.CLI_REQUEST }]],
  },
  ping: {
    params: [["empty", {}]],
    badParams: [["not an object", []]],
    results: [["pong", { pong: true, runtime_version: "0.1.0", protocol: 1 }]],
  },
  "tasks.list": {
    params: [["all", {}], ["monitors including archived", { kind: "monitor", include_archived: true }]],
    badParams: [["unknown kind", { kind: "cron" }]],
    results: [["one", { tasks: [F.task()] }], ["none", { tasks: [] }]],
  },
  "tasks.get": {
    params: [["by id", { task_id: F.TASK }]],
    badParams: [["missing id", {}]],
    results: [["task", { task: F.task() }]],
  },
  "tasks.get_version": {
    params: [["v2", { task_id: F.TASK, version: 2 }]],
    badParams: [["version zero", { task_id: F.TASK, version: 0 }]],
    results: [["v2", { version: { task_id: F.TASK, version: 2, spec: F.sessionSpec(), created_at: F.T0 } }]],
  },
  "tasks.create": {
    params: [["session", { spec: F.sessionSpec() }], ["promote a chat", { spec: F.monitorSpec(), from_thread_id: F.THREAD }]],
    badParams: [["no spec", { from_thread_id: F.THREAD }]],
    badParamsRule: [["monitor with Bash", { spec: F.monitorSpec({ tools: F.tools({ builtin: ["Bash"] }) }) }]],
    results: [["created", { task: F.task({ version: 1 }), thread_id: F.THREAD }]],
  },
  "tasks.update": {
    params: [["edit", { task_id: F.TASK, spec: F.sessionSpec(), expected_version: 3 }]],
    badParams: [["no expected_version", { task_id: F.TASK, spec: F.sessionSpec() }]],
    results: [["v4", { task: F.task({ version: 4 }) }]],
  },
  "tasks.archive": {
    params: [["by id", { task_id: F.TASK }]],
    badParams: [["bad id", { task_id: "site" }]],
    results: [["archived", { archived_at: F.T0 }]],
  },
  "tasks.run_now": {
    params: [["by id", { task_id: F.TASK }]],
    badParams: [["missing id", {}]],
    results: [["started", { run_id: F.RUN, thread_id: F.THREAD }]],
  },
  "schedules.list": {
    params: [["all", {}], ["one task", { task_id: F.TASK }]],
    badParams: [["bad id", { task_id: 7 }]],
    results: [["one", { schedules: [F.scheduleState()] }]],
  },
  "schedules.set_enabled": {
    params: [["pause", { schedule_id: F.SCHEDULE, enabled: false }]],
    badParams: [["string boolean", { schedule_id: F.SCHEDULE, enabled: "false" }]],
    results: [["paused", { schedule: F.scheduleState({ enabled: false, next_fire_at: null }) }]],
  },
  "schedules.coverage": {
    params: [["a week", { task_id: F.TASK, from_day: "2026-01-01", to_day: "2026-01-07" }]],
    badParams: [["datetime instead of day", { task_id: F.TASK, from_day: "2026-01-01T00:00:00Z", to_day: "2026-01-07" }]],
    results: [["one day", { days: [{ schedule_id: F.SCHEDULE, day: "2026-01-01", expected: 12, ran: 12, missed_asleep: 0, missed_not_running: 0 }] }]],
  },
  "grants.list": {
    params: [["active", { task_id: F.TASK }], ["with revoked", { task_id: F.TASK, include_revoked: true }]],
    badParams: [["missing task", {}]],
    results: [["one", { grants: [F.grant()] }]],
  },
  "grants.create": {
    params: [["trust MCP tool", { task_id: F.TASK, grant: { tool: "mcp__github__create_issue", pattern: null, class: "write" } }]],
    badParams: [["destructive", { task_id: F.TASK, grant: { tool: "mcp__github__delete_repo", pattern: null, class: "destructive" } }]],
    badParamsRule: [["bare Bash", { task_id: F.TASK, grant: { tool: "Bash", pattern: null, class: "write" } }]],
    results: [["created", { grant: F.grant() }]],
  },
  "grants.revoke": {
    params: [["by id", { grant_id: F.GRANT }]],
    badParams: [["missing id", {}]],
    results: [["revoked", { revoked_at: F.T0 }]],
  },
  "threads.list": {
    params: [["first page", { limit: 50 }], ["next page", { limit: 50, updated_before: F.T0 }], ["for a task", { task_id: F.TASK }]],
    badParams: [["limit too large", { limit: 10_000 }]],
    results: [["page", { threads: [F.summary()], has_more: true }]],
  },
  "threads.create": {
    params: [["untitled", {}], ["titled", { title: "Plan the trip" }]],
    badParams: [["numeric title", { title: 7 }]],
    results: [["chat", { thread: F.thread({ task_id: null, last_seq: 0 }) }]],
  },
  "threads.history": {
    params: [["latest", { thread_id: F.THREAD, limit: 100 }], ["older", { thread_id: F.THREAD, before_seq: 40, limit: 100 }]],
    badParams: [["before_seq zero", { thread_id: F.THREAD, before_seq: 0 }]],
    results: [["page", { events: [F.persisted("run.resumed", { reason: "input_answered" })], has_more: false }]],
    badResults: [["contains a delta", { events: [F.live("message.delta", { message_id: F.MESSAGE, index: 0, text: "x" })], has_more: false }]],
  },
  "threads.subscribe": {
    params: [["from start", { thread_id: F.THREAD, after_seq: 0 }], ["resume", { thread_id: F.THREAD, after_seq: 41 }]],
    badParams: [["missing after_seq", { thread_id: F.THREAD }]],
    results: [["subscribed", { subscription_id: F.SUBSCRIPTION, last_seq: 42 }]],
  },
  "threads.unsubscribe": {
    params: [["by id", { subscription_id: F.SUBSCRIPTION }]],
    badParams: [["missing id", {}]],
    results: [["ok", { ok: true }]],
  },
  "threads.mark_read": {
    params: [["to 42", { thread_id: F.THREAD, seq: 42 }]],
    badParams: [["seq zero", { thread_id: F.THREAD, seq: 0 }]],
    results: [["ok", { ok: true }]],
  },
  "messages.send": {
    params: [
      ["now", { thread_id: F.THREAD, client_msg_id: F.CLIENT_MSG, text: "Also update the README" }],
      ["queued while offline", { thread_id: F.THREAD, client_msg_id: F.CLIENT_MSG, text: "Run the deploy", sent_at: F.T0 }],
    ],
    badParams: [["missing client_msg_id", { thread_id: F.THREAD, text: "hi" }], ["empty text", { thread_id: F.THREAD, client_msg_id: F.CLIENT_MSG, text: "" }]],
    results: [["steered", { seq: 43, run_id: F.RUN, disposition: "steered" }]],
    badResults: [["unknown disposition", { seq: 43, run_id: F.RUN, disposition: "queued" }]],
  },
  "runs.list": {
    params: [["active in a thread", { thread_id: F.THREAD, states: ["pending", "running", "waiting_input"] }]],
    badParams: [["empty states", { states: [] }]],
    results: [["one", { runs: [F.run()] }]],
  },
  "runs.get": {
    params: [["by id", { run_id: F.RUN }]],
    badParams: [["missing id", {}]],
    results: [["run", { run: F.run() }]],
  },
  "runs.stop": {
    params: [["by id", { run_id: F.RUN }]],
    badParams: [["bad id", { run_id: "" }]],
    results: [["stopping", { state: "running" }]],
  },
  "runs.retry": {
    params: [["by id", { run_id: F.RUN }]],
    badParams: [["missing id", {}]],
    results: [["new run", { run_id: F.RUN2 }]],
  },
  "input.list_pending": {
    params: [["all", {}], ["one thread", { thread_id: F.THREAD }]],
    badParams: [["bad thread", { thread_id: "x" }]],
    results: [["one", { requests: [F.inputRequest()] }]],
  },
  "input.answer": {
    params: [
      ["allow", approvalAnswer],
      ["always allow", { ...approvalAnswer, response: { type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "npm install", class: "write" } } }],
      ["from lock screen", { ...approvalAnswer, via: "notification" }],
    ],
    badParams: [["missing via", { request_id: F.REQUEST, response: { type: "approval", decision: "allow" } }]],
    badParamsRule: [["always allow without grant", { ...approvalAnswer, response: { type: "approval", decision: "allow_always" } }]],
    results: [["applied", { status: "applied" }], ["lost the race", { status: "already_resolved", state: "answered", answered_by: F.PHONE }]],
    badResults: [["unknown status", { status: "queued" }]],
  },
  "monitors.state.get": {
    params: [["by task", { task_id: F.TASK }]],
    badParams: [["missing task", {}]],
    results: [["state", { state: F.monitorState() }], ["never ran", { state: null }]],
  },
  "monitors.state.set": {
    params: [["edit", { task_id: F.TASK, state: { seen: [] }, expected_version: 4 }]],
    badParams: [["no expected_version", { task_id: F.TASK, state: {} }]],
    badParamsRule: [["over 64 KiB", { task_id: F.TASK, state: "x".repeat(70_000), expected_version: 4 }]],
    results: [["v5", { state: F.monitorState({ version: 5, state: { seen: [] } }) }]],
  },
  "monitors.state.reset": {
    params: [["reset", { task_id: F.TASK, expected_version: 4 }]],
    badParams: [["no expected_version", { task_id: F.TASK }]],
    results: [["ok", { ok: true }]],
  },
  "blobs.get": {
    params: [["first page", { sha256: F.SHA, offset: 0, length: 1_048_576 }]],
    badParams: [["page too large", { sha256: F.SHA, offset: 0, length: 4_194_304 }]],
    results: [["last page", { sha256: F.SHA, size: 11, offset: 0, data: "aGVsbG8gd29ybGQ=", eof: true }]],
    badResults: [["base64url data", { sha256: F.SHA, size: 2, offset: 0, data: "-_", eof: true }]],
  },
  "cli.tokens.list": {
    params: [["empty", {}]],
    badParams: [["null", null]],
    results: [["one", { tokens: [{ token_id: F.CLI_TOKEN_ID, client: { name: "homerun-cli", version: "0.1.0" }, created_at: F.T0, last_used_at: null }] }]],
  },
  "cli.tokens.revoke": {
    params: [["by id", { token_id: F.CLI_TOKEN_ID }]],
    badParams: [["the token itself", { token_id: F.CLI_TOKEN }]],
    results: [["ok", { ok: true }]],
  },
  "cli.approve": {
    params: [["approve", { request_id: F.CLI_REQUEST }]],
    badParams: [["missing id", {}]],
    results: [["token issued", { token_id: F.CLI_TOKEN_ID }]],
  },
  "cli.deny": {
    params: [["deny", { request_id: F.CLI_REQUEST }]],
    badParams: [["missing id", {}]],
    results: [["ok", { ok: true }]],
  },
  "secrets.set": {
    params: [["api key", { name: "anthropic_api_key", value: "sk-ant-TEST-not-a-real-key" }]],
    badParams: [["unknown secret", { name: "github_token", value: "x" }], ["empty value", { name: "anthropic_api_key", value: "" }]],
    results: [["ok", { ok: true }]],
  },
  "secrets.clear": {
    params: [["refresh token", { name: "refresh_token" }]],
    badParams: [["missing name", {}]],
    results: [["ok", { ok: true }]],
  },
  "secrets.persist": {
    params: [["device key", { name: "device_static_key", value: "TEST-private-key-material" }]],
    badParams: [["api key without value", { name: "anthropic_api_key" }]],
    results: [["stored", { stored: true }]],
    badResults: [["not stored", { stored: false }]],
  },
};

const NOTIFICATION_VECTORS: Record<NotificationName, { valid: Case[]; invalid: Case[]; invalidRule?: Case[] }> = {
  "thread.event": {
    valid: [
      ["persisted", { subscription_id: F.SUBSCRIPTION, event: F.persisted("run.resumed", { reason: "input_answered" }) }],
      ["live delta", { subscription_id: F.SUBSCRIPTION, event: F.live("message.delta", { message_id: F.MESSAGE, index: 0, text: "Hi" }) }],
    ],
    invalid: [["unknown event", { subscription_id: F.SUBSCRIPTION, event: F.persisted("run.paused", {}) }]],
  },
  "threads.changed": {
    valid: [["summary", { summary: F.summary() }]],
    invalid: [["missing summary", {}]],
  },
  "cli.access_decision": {
    valid: [
      ["approved", { request_id: F.CLI_REQUEST, approved: true, token: F.CLI_TOKEN, token_id: F.CLI_TOKEN_ID }],
      ["denied", { request_id: F.CLI_REQUEST, approved: false }],
    ],
    invalid: [["short token", { request_id: F.CLI_REQUEST, approved: true, token: "abc", token_id: F.CLI_TOKEN_ID }]],
    invalidRule: [["denied with token", { request_id: F.CLI_REQUEST, approved: false, token: F.CLI_TOKEN, token_id: F.CLI_TOKEN_ID }]],
  },
  "cli.access_requested": {
    valid: [["request", { request_id: F.CLI_REQUEST, client: { name: "homerun-cli", version: "0.1.0" }, hostname: "studio.local", requested_at: F.T0 }]],
    invalid: [["missing hostname", { request_id: F.CLI_REQUEST, client: { name: "homerun-cli", version: "0.1.0" }, requested_at: F.T0 }]],
  },
  "power.will_sleep": { valid: [["sleep", { at: F.T0 }]], invalid: [["iso time", { at: "2026-01-01T00:00:00Z" }]] },
  "power.did_wake": {
    valid: [["wake", { at: F.T0 + 3_600_000, slept_at: F.T0 }], ["wake, sleep unknown", { at: F.T0, slept_at: null }]],
    invalid: [["missing slept_at", { at: F.T0 }]],
  },
};

const frames: Vector[] = [
  ok("RpcMessage", "request", { jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
  ok("RpcMessage", "request with string id", { jsonrpc: "2.0", id: "a1", method: "runs.get", params: { run_id: F.RUN } }),
  ok("RpcMessage", "notification", { jsonrpc: "2.0", method: "power.did_wake", params: { at: F.T0, slept_at: null } }),
  ok("RpcMessage", "success", { jsonrpc: "2.0", id: 1, result: { pong: true, runtime_version: "0.1.0", protocol: 1 } }),
  ok("RpcMessage", "failure", { jsonrpc: "2.0", id: 1, error: { code: -32002, message: "forbidden" } }),
  ok("RpcMessage", "parse error", { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }),
  ok("RpcMessage", "incompatible protocol", {
    jsonrpc: "2.0",
    id: 0,
    error: { code: -32003, message: "incompatible protocol", data: { supported: { min: 1, max: 1 } } },
  }),
  bad("RpcMessage", "spike frame without jsonrpc", { id: 1, method: "ping", params: {} }),
  bad("RpcMessage", "positional params", { jsonrpc: "2.0", id: 1, method: "ping", params: [] }),
  bad("RpcMessage", "result and error", { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }),
  bad("RpcMessage", "notification with null id", { jsonrpc: "2.0", id: null, method: "ping" }),
  bad("RpcMessage", "jsonrpc 1.0", { jsonrpc: "1.0", id: 1, method: "ping" }),
  ok("RpcRequest", "hello frame", { jsonrpc: "2.0", id: 0, method: "hello", params: hello }),
];

function build(): Vector[] {
  const out: Vector[] = [...frames];
  for (const [m, s] of Object.entries(METHOD_VECTORS) as [MethodName, Spec][]) {
    const ids = methodSchemaIds(m);
    for (const [n, v] of s.params) out.push(ok(ids.params, `${m}: ${n}`, v));
    for (const [n, v] of s.badParams) out.push(bad(ids.params, `${m}: ${n}`, v));
    for (const [n, v] of s.badParamsRule ?? []) out.push(badRule(ids.params, `${m}: ${n}`, v));
    for (const [n, v] of s.results) out.push(ok(ids.result, `${m}: ${n}`, v));
    for (const [n, v] of s.badResults ?? []) out.push(bad(ids.result, `${m}: ${n}`, v));
  }
  for (const [n, s] of Object.entries(NOTIFICATION_VECTORS) as [NotificationName, (typeof NOTIFICATION_VECTORS)[NotificationName]][]) {
    const id = notificationSchemaId(n);
    for (const [name, v] of s.valid) out.push(ok(id, `${n}: ${name}`, v));
    for (const [name, v] of s.invalid) out.push(bad(id, `${n}: ${name}`, v));
    for (const [name, v] of s.invalidRule ?? []) out.push(badRule(id, `${n}: ${name}`, v));
  }
  return out;
}

export const protocol = build();
