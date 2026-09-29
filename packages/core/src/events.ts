import { z } from "zod";
import { named } from "./registry";
import {
  ClientMsgId,
  Content,
  DeviceId,
  GrantId,
  MessageId,
  Origin,
  RequestId,
  RunId,
  ScheduleId,
  Seq,
  Surface,
  TaskId,
  ThreadId,
  TimestampMs,
  ToolCallId,
} from "./common";
import { Authority, RunError, RunOutcome, RunState, RunTrigger, TerminalRunState } from "./domain";
import { AnswerVia, InputPrompt, InputResponse } from "./input";
import { McpServerName, ToolClass, ToolName } from "./tools";
import { ModelId } from "./task-spec";

/**
 * Thread events (§5.3, §6 `thread_events`). Persisted events carry a per-thread `seq` assigned
 * by the runtime, the single writer (§5.7). Live-only events are streamed to connected clients
 * and never stored (§6.1); they carry `after_seq`, the last persisted seq when they were sent.
 *
 * Monitor runs persist events only when the run acts or fails; a no-change run writes nothing
 * to its thread (§8.3).
 */

const persisted = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    thread_id: ThreadId,
    seq: Seq,
    run_id: RunId.nullable(),
    ts: TimestampMs,
    type: z.literal(type),
    payload,
  });

const liveOnly = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({
    thread_id: ThreadId,
    after_seq: z.int().nonnegative(),
    run_id: RunId.nullable(),
    ts: TimestampMs,
    type: z.literal(type),
    payload,
  });

// ---------------------------------------------------------------- messages

export const UserMessageEvent = named(
  "UserMessageEvent",
  persisted(
    "user.message",
    z.object({
      client_msg_id: ClientMsgId,
      text: z.string().min(1).max(100_000),
      origin: Origin,
      /**
       * started_run: this message started `run_id`. steered: pushed into the running `run_id`
       * (§5.7). held: `run_id` is waiting for input; delivered together with the answer, or
       * never if the run ends first (`HeldMessages`).
       */
      disposition: z.enum(["started_run", "steered", "held"]),
      /** When the client sent it, if earlier than `ts`: a queued instruction (§9.4). */
      sent_at: TimestampMs.optional(),
    }),
  ),
);

export const MessageFinalEvent = named(
  "MessageFinalEvent",
  persisted(
    "message.final",
    z.object({
      message_id: MessageId,
      role: z.literal("assistant"),
      text: z.string().max(1_000_000),
      model: ModelId.optional(),
      /** Set for subagent messages. */
      parent_tool_call_id: ToolCallId.optional(),
    }),
  ),
);

export const MessageDeltaEvent = named(
  "MessageDeltaEvent",
  liveOnly(
    "message.delta",
    z.object({
      message_id: MessageId,
      /** Chunk counter within the message, from 0. Deltas are coalesced every ~50–100 ms (§9.8). */
      index: z.int().nonnegative(),
      text: z.string().max(100_000),
    }),
  ),
);

// ---------------------------------------------------------------- tools (§5.4)

export const ToolCallEvent = named(
  "ToolCallEvent",
  persisted(
    "tool.call",
    z.object({
      tool_call_id: ToolCallId,
      tool: ToolName,
      class: ToolClass,
      mcp_server: McpServerName.optional(),
      input: Content,
      /** The policy decision when the call was recorded, before dispatch. */
      policy: z.enum(["allowed", "granted", "needs_approval", "denied"]),
      grant_id: GrantId.optional(),
      parent_tool_call_id: ToolCallId.optional(),
    }),
  ),
);

export const ToolResultStatus = named(
  "ToolResultStatus",
  z.enum([
    "ok",
    "error",
    "denied", // never ran: denied by policy or by the user
    "resolved_completed", // ambiguous after a crash; the user said it happened (§5.4)
    "resolved_not_run", // ambiguous after a crash; the user said it did not run
    "interrupted_retryable", // ambiguous read/idempotent call; the model was told it may retry
  ]),
);

/** Every tool.call gets exactly one tool.result, so a call without one is ambiguous (§5.4). */
export const ToolResultEvent = named(
  "ToolResultEvent",
  persisted(
    "tool.result",
    z.object({
      tool_call_id: ToolCallId,
      status: ToolResultStatus,
      output: Content.nullable(),
      error: z.string().max(10_000).optional(),
      duration_ms: z.int().nonnegative().optional(),
    }),
  ),
);

// ---------------------------------------------------------------- input (§5.6)

export const InputRequestedEvent = named(
  "InputRequestedEvent",
  persisted(
    "input.requested",
    z.object({
      request_id: RequestId,
      prompt: InputPrompt,
      required_authority: z.enum(["any", "full"]),
      expires_at: TimestampMs.nullable(),
    }),
  ),
);

export const InputResolvedEvent = named(
  "InputResolvedEvent",
  persisted(
    "input.resolved",
    z
      .object({
        request_id: RequestId,
        state: z.enum(["answered", "expired", "cancelled"]),
        response: InputResponse.nullable(),
        answered_by: DeviceId.nullable(),
        surface: Surface.nullable(),
        via: AnswerVia.nullable(),
        /** The grant an "Always allow" answer created, in the same transaction (§5.6). */
        grant_id: GrantId.optional(),
      })
      .refine(
        (p) => (p.state === "answered") === (p.response !== null && p.answered_by !== null && p.surface !== null && p.via !== null),
        "response, answered_by, surface and via are set exactly when answered",
      ),
  ),
);

// ---------------------------------------------------------------- run lifecycle

export const RunStartedEvent = named(
  "RunStartedEvent",
  persisted(
    "run.started",
    z.object({
      trigger: RunTrigger,
      authority: Authority,
      /** Null for scheduled runs. */
      origin: Origin.nullable(),
      task_id: TaskId.nullable(),
      task_version: z.int().min(1).nullable(),
      scheduled_for: TimestampMs.nullable(),
      attempt: z.int().nonnegative(),
    }),
  ),
);

export const RunResumedEvent = named(
  "RunResumedEvent",
  persisted(
    "run.resumed",
    z.object({
      /**
       * runtime_restart: homerund restarted mid-run (§5.4). agent_exited: the agent process died
       * while the runtime kept running, and the run resumed the same way.
       */
      reason: z.enum(["runtime_restart", "agent_exited", "input_answered", "ambiguity_resolved"]),
    }),
  ),
);

/** A stop was requested. The run stops at the next safe point; `run.end` follows (§5.7). */
export const RunCancelledEvent = named(
  "RunCancelledEvent",
  persisted(
    "run.cancelled",
    z.object({
      /** Null when the runtime cancelled it. */
      by: Origin.nullable(),
      reason: z.enum(["user", "input_timeout", "budget_cap"]),
    }),
  ),
);

/** The single terminal event of a run. */
export const RunEndEvent = named(
  "RunEndEvent",
  persisted(
    "run.end",
    z
      .object({
        state: TerminalRunState,
        outcome: RunOutcome.nullable(),
        error: RunError.nullable(),
        authority: Authority,
        cost_usd: z.number().nonnegative().nullable(),
      })
      .refine((p) => p.outcome === null || p.state === "succeeded", "only a succeeded run has an outcome")
      .refine((p) => p.error === null || p.state === "failed" || p.state === "abandoned", "only failed or abandoned runs carry an error"),
  ),
);

/**
 * Fires that did not run on time (§8.2, §8.4). Not tied to a run. `asleep` and `not_running` say
 * why the computer could not run them, and `caught_up` how many of those the catch-up policy runs
 * late; the rest are not run. `skipped_by_policy` covers on-time fires Homerun dropped itself,
 * merged into the fire already waiting because the monitor's previous run was still going (§5.3).
 */
export const ScheduleMissedEvent = named(
  "ScheduleMissedEvent",
  persisted(
    "schedule.missed",
    z.object({
      schedule_id: ScheduleId,
      /** The first missed fire of the group. */
      scheduled_for: TimestampMs,
      reason: z.enum(["asleep", "not_running", "skipped_by_policy"]),
      /** Contiguous missed fires reported together. */
      count: z.int().min(1),
      /** The last missed fire of the group; absent when count is 1. */
      last_scheduled_for: TimestampMs.optional(),
      /** How many of these fires the catch-up policy runs late (§8.1): 0 for `skip`. */
      caught_up: z.int().nonnegative().optional(),
    }),
  ),
);

/** The runtime paused a schedule (§5.3, §7.4). A pause by hand is not an event. */
export const SchedulePausedEvent = named(
  "SchedulePausedEvent",
  persisted(
    "schedule.paused",
    z.object({
      schedule_id: ScheduleId,
      reason: z.enum(["failures", "budget_cap"]),
      /** A sentence for the thread, e.g. "Paused after 3 failed checks in a row". */
      detail: z.string().min(1).max(1000),
    }),
  ),
);

/** Transient status for the UI: "Queued — 2 runs ahead", "Waiting for Claude — retrying". */
export const RunStatusEvent = named(
  "RunStatusEvent",
  liveOnly(
    "run.status",
    z.object({
      state: RunState,
      detail: z.enum(["queued", "running", "retrying_model", "rate_limited", "waiting_input", "stopping"]),
      queue_position: z.int().nonnegative().optional(),
      retry_at: TimestampMs.optional(),
    }),
  ),
);

// ---------------------------------------------------------------- unions

export const PERSISTED_EVENT_SCHEMAS = [
  UserMessageEvent,
  MessageFinalEvent,
  ToolCallEvent,
  ToolResultEvent,
  InputRequestedEvent,
  InputResolvedEvent,
  RunStartedEvent,
  RunResumedEvent,
  RunCancelledEvent,
  RunEndEvent,
  ScheduleMissedEvent,
  SchedulePausedEvent,
] as const;

export const LIVE_EVENT_SCHEMAS = [MessageDeltaEvent, RunStatusEvent] as const;

export const PersistedThreadEvent = named("PersistedThreadEvent", z.discriminatedUnion("type", PERSISTED_EVENT_SCHEMAS));
export type PersistedThreadEvent = z.infer<typeof PersistedThreadEvent>;

export const LiveThreadEvent = named("LiveThreadEvent", z.discriminatedUnion("type", LIVE_EVENT_SCHEMAS));
export type LiveThreadEvent = z.infer<typeof LiveThreadEvent>;

export const ThreadEvent = named("ThreadEvent", z.discriminatedUnion("type", [...PERSISTED_EVENT_SCHEMAS, ...LIVE_EVENT_SCHEMAS]));
export type ThreadEvent = z.infer<typeof ThreadEvent>;
export type ThreadEventType = ThreadEvent["type"];
export type ThreadEventOf<T extends ThreadEventType> = Extract<ThreadEvent, { type: T }>;

export const PERSISTED_EVENT_TYPES = PERSISTED_EVENT_SCHEMAS.map((s) => s.shape.type.value) as PersistedThreadEvent["type"][];
export const LIVE_ONLY_EVENT_TYPES = LIVE_EVENT_SCHEMAS.map((s) => s.shape.type.value) as LiveThreadEvent["type"][];
export const EVENT_TYPES: readonly ThreadEventType[] = [...PERSISTED_EVENT_TYPES, ...LIVE_ONLY_EVENT_TYPES];

export function isLiveOnly(type: ThreadEventType): type is LiveThreadEvent["type"] {
  return (LIVE_ONLY_EVENT_TYPES as readonly string[]).includes(type);
}

export function isPersisted(e: ThreadEvent): e is PersistedThreadEvent {
  return !isLiveOnly(e.type);
}

/** An event from a newer runtime that this client does not know. Render generically or skip. */
export interface UnknownThreadEvent {
  type: "unknown";
  original_type: string;
  thread_id: string;
  seq: number | null;
  raw: unknown;
}

const UnknownEnvelope = z.object({
  type: z.string().min(1),
  thread_id: ThreadId,
  seq: Seq.optional(),
  after_seq: z.int().nonnegative().optional(),
});

/**
 * Forward-compatible parse for clients (Tier 1 and Tier 2 update independently, §14). A known
 * type must be valid. An unknown type with a valid envelope comes back as `unknown`, keeping
 * its `seq` so sync stays gap-free.
 */
export function parseThreadEventLenient(
  raw: unknown,
): { ok: true; event: ThreadEvent | UnknownThreadEvent } | { ok: false; error: z.ZodError } {
  const env = UnknownEnvelope.safeParse(raw);
  if (!env.success) return { ok: false, error: env.error };
  if (!(EVENT_TYPES as readonly string[]).includes(env.data.type)) {
    return {
      ok: true,
      event: { type: "unknown", original_type: env.data.type, thread_id: env.data.thread_id, seq: env.data.seq ?? null, raw },
    };
  }
  const r = ThreadEvent.safeParse(raw);
  return r.success ? { ok: true, event: r.data } : { ok: false, error: r.error };
}

// ---------------------------------------------------------------- delivery of held messages (§5.7)

/**
 * Tracks messages held while a run waited for input (`disposition: "held"`) and reports the ones
 * that were never delivered. A held message is delivered when its run resumes after the answer:
 * a `run.resumed` of that run follows it. If the run ends first, typically because it was
 * stopped while it waited, the message was not delivered. Homerun never sends it later on its
 * own, so a client shows it as not delivered and can offer to resend it (a new `messages.send`
 * with a new `client_msg_id`).
 *
 * Feed events in `seq` order; live-only and unknown events are ignored.
 */
export class HeldMessages {
  private readonly held = new Map<string, ThreadEventOf<"user.message">[]>();

  /** The held messages this event leaves undelivered. Non-empty only for a `run.end`. */
  observe(e: ThreadEvent | UnknownThreadEvent): ThreadEventOf<"user.message">[] {
    if (e.type === "unknown" || e.run_id === null) return [];
    switch (e.type) {
      case "user.message":
        if (e.payload.disposition === "held") this.held.set(e.run_id, [...(this.held.get(e.run_id) ?? []), e]);
        return [];
      case "run.resumed":
        this.held.delete(e.run_id);
        return [];
      case "run.end": {
        const left = this.held.get(e.run_id) ?? [];
        this.held.delete(e.run_id);
        return left;
      }
      default:
        return [];
    }
  }
}

/** Held messages in `events` (in `seq` order) whose run ended before they were delivered. */
export function undeliveredMessages(events: readonly (ThreadEvent | UnknownThreadEvent)[]): ThreadEventOf<"user.message">[] {
  const t = new HeldMessages();
  return events.flatMap((e) => t.observe(e));
}
