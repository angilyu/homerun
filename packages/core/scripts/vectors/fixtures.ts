/** Shared fixture values for golden vectors. All ids are fixed so vectors are stable. */

export const DEVICE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a01";
export const PHONE = "0b6f1c1e-6f5a-4c2e-9a51-3d1f0c9e2a02";
export const TASK = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01";
export const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f01";
export const RUN = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a01";
export const RUN2 = "3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6a02";
export const REQUEST = "4f5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b01";
export const GRANT = "5a6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c01";
export const SCHEDULE = "6b7c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d01";
export const CLIENT_MSG = "7c8d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e01";
export const SUBSCRIPTION = "8d9e0f1a-2b3c-4d4e-9f6a-7b8c9d0e1f01";
export const CLI_REQUEST = "9e0f1a2b-3c4d-4e5f-8a7b-8c9d0e1f2a01";
export const CLI_TOKEN_ID = "0f1a2b3c-4d5e-4f6a-9b8c-9d0e1f2a3b01";
export const OFFER = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c01";
export const LINK_REQUEST = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d01";
export const TOOL_CALL = "toolu_01A09q90qw90lq917835lq9";
export const MESSAGE = "msg_01XFDUDYJgAACzvnptvVoYEL";
export const SDK_SESSION = "8f7e6d5c-sdk-session";
export const SHA = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
export const LAUNCH_TOKEN = "a".repeat(64);
export const CLI_TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx";
export const MSG_ID = "q83vEjRWeJq83vEjRWeJqw";
export const STATIC_KEY = "3p7bfXt9wbTTW2HC7OQ1Nz-DQ8hbeGdNrfx-FG-IK08";
export const T0 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

export const pairedDevice = () => ({ device_id: PHONE, name: "Ada's iPhone", platform: "ios", claimed_platform: "ios", method: "qr", paired_at: T0, online: false, last_seen_at: T0 + 60_000 });

export const origin = (surface: "desktop" | "cli" | "ios" | "web" = "desktop", device_id = DEVICE) => ({ device_id, surface });

export const policy = (over: Record<string, unknown> = {}) => ({
  roots: ["~/Code/site"],
  egress: { mode: "allowlist", domains: ["api.github.com", "*.example.com"] },
  bash_patterns: [],
  use_shell_environment: false,
  input_timeout: { action: "wait", remind_after_ms: 3_600_000 },
  retention_days: 30,
  ...over,
});

export const tools = (over: Record<string, unknown> = {}) => ({
  builtin: ["Read", "Grep", "Glob", "WebFetch"],
  mcp_servers: [],
  homerun: [],
  ...over,
});

export const sessionSpec = (over: Record<string, unknown> = {}) => ({
  kind: "session",
  format: 1,
  name: "Site maintenance",
  prompt: "Keep the site's dependencies current and open PRs for updates.",
  budget: { max_run_usd: 2, monthly_cap_usd: 40 },
  tools: tools(),
  policy: policy(),
  model: { model: "claude-sonnet-4-5", fallback_model: "claude-haiku-4-5" },
  ...over,
});

export const monitorSpec = (over: Record<string, unknown> = {}) => ({
  kind: "monitor",
  format: 1,
  name: "Release watcher",
  prompt: "When a new release appears, summarise the changelog.",
  budget: { max_run_usd: 0.5 },
  tools: tools({ builtin: ["WebFetch"] }),
  policy: policy({ roots: [] }),
  schedule: { kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/London", catchup: "run_once", max_catchup: 1 },
  check: {
    kind: "rule",
    source: { type: "feed", url: "https://github.com/oven-sh/bun/releases.atom", format: "atom" },
    comparator: { op: "new_items" },
  },
  act: { model: { model: "claude-haiku-4-5" } },
  ...over,
});

export const inline = (value: unknown) => ({ kind: "inline", value });

export const approvalPrompt = (over: Record<string, unknown> = {}) => ({
  type: "approval",
  tool: "Bash",
  tool_call_id: TOOL_CALL,
  class: "write",
  input: inline({ command: "npm install left-pad@1.3.0" }),
  reason: "not_allowlisted",
  offer_always: true,
  suggested_grant: { tool: "Bash", pattern: "npm install *", class: "write" },
  ...over,
});

export const questionPrompt = (over: Record<string, unknown> = {}) => ({
  type: "question",
  tool_call_id: TOOL_CALL,
  questions: [
    {
      question: "Which branch should I target?",
      header: "Branch",
      options: [{ label: "main" }, { label: "develop", description: "Integration branch" }],
      multi_select: false,
      allow_freeform: true,
    },
  ],
  ...over,
});

export const run = (over: Record<string, unknown> = {}) => ({
  run_id: RUN,
  thread_id: THREAD,
  task_id: TASK,
  task_version: 3,
  sdk_session_id: SDK_SESSION,
  device_id: DEVICE,
  trigger: "message",
  origin_device: PHONE,
  authority: "full",
  scheduled_for: null,
  dedupe_key: `msg:${CLIENT_MSG}`,
  attempt: 0,
  state: "running",
  started_at: T0,
  ended_at: null,
  outcome: null,
  error: null,
  check_result: null,
  cost_usd: null,
  claude_pid: 4242,
  ...over,
});

export const task = (over: Record<string, unknown> = {}) => ({
  task_id: TASK,
  device_id: DEVICE,
  kind: "session",
  name: "Site maintenance",
  version: 3,
  spec: sessionSpec(),
  archived_at: null,
  ...over,
});

export const thread = (over: Record<string, unknown> = {}) => ({
  thread_id: THREAD,
  task_id: TASK,
  title: "Site maintenance",
  last_seq: 42,
  updated_at: T0,
  ...over,
});

export const summary = (over: Record<string, unknown> = {}) => ({
  ...thread(),
  last_message: { seq: 42, role: "assistant", preview: "Opened PR #12 bumping astro to 5.2.", ts: T0 },
  unread_count: 2,
  input_pending: false,
  active_run: { run_id: RUN, state: "running" },
  ...over,
});

export const persisted = (type: string, payload: unknown, over: Record<string, unknown> = {}) => ({
  thread_id: THREAD,
  seq: 7,
  run_id: RUN,
  ts: T0,
  type,
  payload,
  ...over,
});

export const live = (type: string, payload: unknown, over: Record<string, unknown> = {}) => ({
  thread_id: THREAD,
  after_seq: 7,
  run_id: RUN,
  ts: T0,
  type,
  payload,
  ...over,
});

export const inputRequest = (over: Record<string, unknown> = {}) => ({
  request_id: REQUEST,
  run_id: RUN,
  kind: "approval",
  tool_call_id: TOOL_CALL,
  prompt: approvalPrompt(),
  state: "pending",
  requested_at: T0,
  expires_at: null,
  answered_at: null,
  response: null,
  answered_by: null,
  ...over,
});

export const grant = (over: Record<string, unknown> = {}) => ({
  grant_id: GRANT,
  task_id: TASK,
  tool: "Bash",
  pattern: "npm install",
  class: "write",
  granted_by: DEVICE,
  granted_at: T0,
  revoked_at: null,
  ...over,
});

export const scheduleState = (over: Record<string, unknown> = {}) => ({
  schedule_id: SCHEDULE,
  task_id: TASK,
  schedule: { kind: "cron", cron: "0 9 * * 1-5", timezone: "Europe/London", catchup: "run_once", max_catchup: 1 },
  enabled: true,
  paused_reason: null,
  next_fire_at: T0 + 3_600_000,
  last_fired_at: T0,
  consecutive_failures: 0,
  missed_since_last_run: 0,
  ...over,
});

export const monitorHealth = (over: Record<string, unknown> = {}) => ({
  task_id: TASK,
  name: "Release watcher",
  schedule_id: SCHEDULE,
  enabled: true,
  paused_reason: null,
  expected: 96,
  succeeded: 40,
  changes: 1,
  failed: 0,
  missed_asleep: 56,
  missed_not_running: 0,
  skipped: 0,
  caught_up: 1,
  cost_usd: 0.02,
  last_run_at: T0 + 80_000_000,
  next_fire_at: T0 + 86_400_000 + 900_000,
  needs_attention: true,
  ...over,
});

export const healthDigest = (over: Record<string, unknown> = {}) => ({
  from: T0,
  to: T0 + 86_400_000,
  generated_at: T0 + 86_400_000,
  timezone: "Europe/London",
  monitors: [monitorHealth()],
  downtime: [{ start_at: T0 + 3_600_000, end_at: T0 + 27_600_000, cause: "asleep" }],
  cost_usd: 0.02,
  needs_attention: true,
  ...over,
});

export const monitorState = (over: Record<string, unknown> = {}) => ({
  task_id: TASK,
  state: { seen: ["v1.2.0", "v1.2.1"] },
  version: 4,
  last_run_id: RUN,
  updated_at: T0,
  ...over,
});
