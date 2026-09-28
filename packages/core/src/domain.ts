import { z } from "zod";
import { named } from "./registry";
import {
  DeviceId,
  JsonValue,
  MONITOR_STATE_MAX_BYTES,
  RunId,
  SdkSessionId,
  Seq,
  TaskId,
  ThreadId,
  TimestampMs,
  jsonByteLength,
  type Surface,
} from "./common";
import { CheckResult, TaskSpec } from "./task-spec";

// ---------------------------------------------------------------- device (§6, §12)

export const Platform = named("Platform", z.enum(["macos", "windows", "linux"]));

export const Device = named(
  "Device",
  z.object({
    device_id: DeviceId,
    platform: Platform,
    hostname: z.string().min(1).max(255),
    /** Null when signed out (§10.10). */
    account_id: z.string().min(1).max(256).nullable(),
    created_at: TimestampMs,
  }),
);
export type Device = z.infer<typeof Device>;

// ---------------------------------------------------------------- tasks (§6)

export const TaskKind = named("TaskKind", z.enum(["session", "monitor"]));
export type TaskKind = z.infer<typeof TaskKind>;

export const Task = named(
  "Task",
  z
    .object({
      task_id: TaskId,
      device_id: DeviceId,
      kind: TaskKind,
      name: z.string().min(1).max(200),
      /** Edit counter, bumped on every edit. Runs record the version they executed. */
      version: z.int().min(1),
      spec: TaskSpec,
      archived_at: TimestampMs.nullable(),
    })
    .superRefine((t, ctx) => {
      if (t.kind !== t.spec.kind) ctx.addIssue({ code: "custom", path: ["kind"], message: "kind does not match spec.kind" });
      if (t.name !== t.spec.name) ctx.addIssue({ code: "custom", path: ["name"], message: "name does not match spec.name" });
    }),
);
export type Task = z.infer<typeof Task>;

export const TaskVersion = named(
  "TaskVersion",
  z.object({ task_id: TaskId, version: z.int().min(1), spec: TaskSpec, created_at: TimestampMs }),
  "Immutable history of edits (§6 task_versions)",
);
export type TaskVersion = z.infer<typeof TaskVersion>;

// ---------------------------------------------------------------- threads (§6, §9.8)

export const Thread = named(
  "Thread",
  z.object({
    thread_id: ThreadId,
    /** Null for a one-off chat. */
    task_id: TaskId.nullable(),
    title: z.string().max(500).nullable(),
    last_seq: z.int().nonnegative(),
    updated_at: TimestampMs,
  }),
);
export type Thread = z.infer<typeof Thread>;

// ---------------------------------------------------------------- runs (§6, §5.3, §8.3, §9.9)

export const RunState = named(
  "RunState",
  z.enum(["pending", "running", "waiting_input", "succeeded", "failed", "cancelled", "abandoned"]),
  "pending = queued for a slot; abandoned = given up without an agent outcome",
);
export type RunState = z.infer<typeof RunState>;

export const ACTIVE_RUN_STATES = ["pending", "running", "waiting_input"] as const satisfies readonly RunState[];
export const TERMINAL_RUN_STATES = ["succeeded", "failed", "cancelled", "abandoned"] as const satisfies readonly RunState[];
export type ActiveRunState = (typeof ACTIVE_RUN_STATES)[number];
export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];
export const TerminalRunState = named("TerminalRunState", z.enum(TERMINAL_RUN_STATES));

export function isTerminal(s: RunState): s is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(s);
}

/**
 * Allowed state changes.
 * - running → pending: requeued after a runtime restart while slots are full.
 * - waiting_input → pending: the answer arrived and the run waits for a slot (§5.3).
 * - waiting_input → running: the answer arrived within the grace period, process still alive.
 * - → abandoned: a queued fire merged into the next one (`run_once`), or a run that cannot resume.
 */
export const RUN_STATE_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = {
  pending: ["running", "cancelled", "abandoned"],
  running: ["pending", "waiting_input", "succeeded", "failed", "cancelled", "abandoned"],
  waiting_input: ["pending", "running", "failed", "cancelled", "abandoned"],
  succeeded: [],
  failed: [],
  cancelled: [],
  abandoned: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}

export const RunTrigger = named("RunTrigger", z.enum(["message", "manual", "schedule", "catchup"]));
export type RunTrigger = z.infer<typeof RunTrigger>;

/** `web_read_only` if the web client started or steered the run (§9.9). Only ever downgraded. */
export const Authority = named("Authority", z.enum(["full", "web_read_only"]));
export type Authority = z.infer<typeof Authority>;

/** A message from `surface` to a run with `current` authority leaves it with this authority. */
export function authorityAfterMessage(current: Authority, surface: Surface): Authority {
  return surface === "web" ? "web_read_only" : current;
}

export const RunOutcome = named("RunOutcome", z.enum(["changed", "no_change"]), "Monitors only (§8.3)");
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunError = named("RunError", z.object({ code: z.string().min(1).max(100), message: z.string().max(10_000) }));
export type RunError = z.infer<typeof RunError>;

/** Monitor runs are retried twice on failure (§5.3), as new attempts of the same fire. */
export const MONITOR_RETRY_BACKOFF_MS = [60_000, 300_000] as const;
export const MAX_RUN_ATTEMPT = MONITOR_RETRY_BACKOFF_MS.length;
/** A monitor that fails this many scheduled fires in a row is paused (§5.3). */
export const MONITOR_PAUSE_AFTER_FAILED_FIRES = 3;
/** Default concurrency limits (§5.3). */
export const DEFAULT_CONCURRENCY = { session: 3, monitor: 2 } as const;
/** An input request unanswered this long defers the run (§5.6). */
export const INPUT_DEFER_GRACE_MS = 120_000;

export const Run = named(
  "Run",
  z
    .object({
      run_id: RunId,
      thread_id: ThreadId,
      task_id: TaskId.nullable(),
      task_version: z.int().min(1).nullable(),
      sdk_session_id: SdkSessionId.nullable(),
      device_id: DeviceId,
      trigger: RunTrigger,
      /** Device that started it; null for scheduled runs. */
      origin_device: DeviceId.nullable(),
      authority: Authority,
      scheduled_for: TimestampMs.nullable(),
      /** Opaque here; the scheduler owns its format. */
      dedupe_key: z.string().min(1).max(512),
      /** 0 for the first try; monitor retries are 1 and 2. */
      attempt: z.int().min(0).max(MAX_RUN_ATTEMPT),
      state: RunState,
      started_at: TimestampMs.nullable(),
      ended_at: TimestampMs.nullable(),
      outcome: RunOutcome.nullable(),
      error: RunError.nullable(),
      /** Monitors: the check's result, kept as evidence (§8.3). */
      check_result: CheckResult.nullable(),
      /** The SDK's reported `total_cost_usd`, summed per task for budgets (§7.4). */
      cost_usd: z.number().nonnegative().nullable(),
      /** Leader of the run's claude process group (§5.1). */
      claude_pid: z.int().positive().nullable(),
    })
    .superRefine((r, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
      if ((r.task_id === null) !== (r.task_version === null)) issue("task_version", "task_version is set exactly when task_id is");
      const scheduled = r.trigger === "schedule" || r.trigger === "catchup";
      if (scheduled && r.origin_device !== null) issue("origin_device", "scheduled runs have no origin device");
      if (!scheduled && r.origin_device === null) issue("origin_device", "user-started runs record their origin device");
      if (scheduled !== (r.scheduled_for !== null)) issue("scheduled_for", "scheduled_for is set exactly for scheduled runs");
      if (scheduled && r.task_id === null) issue("task_id", "scheduled runs belong to a task");
      if (r.attempt > 0 && !scheduled) issue("attempt", "only scheduled runs are retried automatically");
      if (isTerminal(r.state) !== (r.ended_at !== null)) issue("ended_at", "ended_at is set exactly when the run is terminal");
      if (r.outcome !== null && r.state !== "succeeded") issue("outcome", "only a succeeded run has an outcome");
      if (r.error !== null && r.state !== "failed" && r.state !== "abandoned") issue("error", "only failed or abandoned runs carry an error");
      if (r.claude_pid !== null && r.state !== "running" && r.state !== "waiting_input")
        issue("claude_pid", "only a running run (or one in a short wait) has a claude process");
    }),
);
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------- monitor state (§8.3)

export const MonitorState = named(
  "MonitorState",
  z.object({
    task_id: TaskId,
    state: JsonValue.refine((v) => jsonByteLength(v) <= MONITOR_STATE_MAX_BYTES, `at most ${MONITOR_STATE_MAX_BYTES} bytes`),
    version: z.int().min(1),
    last_run_id: RunId,
    updated_at: TimestampMs,
  }),
);
export type MonitorState = z.infer<typeof MonitorState>;

// ---------------------------------------------------------------- thread summaries (§9.8)

export const ThreadSummary = named(
  "ThreadSummary",
  z.object({
    thread_id: ThreadId,
    task_id: TaskId.nullable(),
    title: z.string().max(500).nullable(),
    last_seq: z.int().nonnegative(),
    updated_at: TimestampMs,
    last_message: z
      .object({ seq: Seq, role: z.enum(["user", "assistant"]), preview: z.string().max(500), ts: TimestampMs })
      .nullable(),
    /** Events after this device's read marker. */
    unread_count: z.int().nonnegative(),
    input_pending: z.boolean(),
    active_run: z.object({ run_id: RunId, state: z.enum(ACTIVE_RUN_STATES) }).nullable(),
  }),
);
export type ThreadSummary = z.infer<typeof ThreadSummary>;
