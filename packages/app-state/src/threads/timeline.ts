import type {
  InputPrompt,
  InputRequest,
  Surface,
  ThreadEventOf,
} from "@homerun/core";
import type { OutboxItem, StoredEvent, ThreadState } from "./reducer";

/**
 * The view model of a thread: what a client renders, in order (§9.8). Derived from
 * `ThreadState`; the persisted part is cached per events array, so a delta only re-derives
 * the tail.
 */

export type Delivery =
  /** In the thread; for a steered message, pushed into the running run (§5.7). */
  | "delivered"
  /** Held while its run waits for input: delivered with the answer. */
  | "held"
  /** Held, and the run ended before it was delivered. Homerun never sends it later (§5.7). */
  | "not_delivered"
  | OutboxItem["state"];

export interface UserItem {
  kind: "user";
  key: string;
  seq: number | null;
  ts: number;
  run_id: string | null;
  client_msg_id: string;
  text: string;
  disposition: "started_run" | "steered" | "held" | null;
  surface: Surface | null;
  delivery: Delivery;
  error?: string;
}

export interface AssistantItem {
  kind: "assistant";
  key: string;
  seq: number | null;
  ts: number;
  run_id: string | null;
  text: string;
  streaming: boolean;
  /** Text was missed while streaming; the final message replaces it. */
  gap: boolean;
  /** A subagent's message (§5.3). */
  subagent: boolean;
}

export type ToolState =
  | "running"
  /** An approval or "Did this happen?" is pending for this call. */
  | "waiting"
  /** The run ended without a result, e.g. stopped mid-call. */
  | "no_result"
  | ThreadEventOf<"tool.result">["payload"]["status"];

export interface ToolItem {
  kind: "tool";
  key: string;
  seq: number;
  ts: number;
  run_id: string | null;
  call: ThreadEventOf<"tool.call">["payload"];
  result: ThreadEventOf<"tool.result">["payload"] | null;
  state: ToolState;
  subagent: boolean;
}

export interface InputResolution {
  state: "answered" | "expired" | "cancelled";
  response: ThreadEventOf<"input.resolved">["payload"]["response"];
  answered_by: string | null;
  surface: Surface | null;
  ts: number;
  grant_id?: string;
}

export interface InputItem {
  kind: "input";
  key: string;
  seq: number;
  ts: number;
  run_id: string | null;
  request_id: string;
  prompt: InputPrompt;
  required_authority: "any" | "full";
  expires_at: number | null;
  resolution: InputResolution | null;
}

export interface RunItem {
  kind: "run";
  key: string;
  seq: number;
  ts: number;
  run_id: string | null;
  event:
    | ThreadEventOf<"run.started">
    | ThreadEventOf<"run.resumed">
    | ThreadEventOf<"run.cancelled">
    | ThreadEventOf<"run.end">;
}

export interface ScheduleItem {
  kind: "schedule";
  key: string;
  seq: number;
  ts: number;
  event: ThreadEventOf<"schedule.missed"> | ThreadEventOf<"schedule.paused">;
}

export interface UnknownItem {
  kind: "unknown";
  key: string;
  seq: number;
  original_type: string;
}

export type TimelineItem = UserItem | AssistantItem | ToolItem | InputItem | RunItem | ScheduleItem | UnknownItem;

/** A request waiting for the user, whether or not its event is in the loaded window. */
export interface PendingInput {
  request_id: string;
  run_id: string | null;
  prompt: InputPrompt;
  required_authority: "any" | "full";
  requested_at: number;
  expires_at: number | null;
}

export interface ActiveRun {
  run_id: string;
  /** From the latest `run.status`, else from the events. */
  state: "pending" | "running" | "waiting_input";
  detail: ThreadEventOf<"run.status">["payload"]["detail"] | null;
  queue_position: number | null;
  retry_at: number | null;
  /** A stop was requested (`run.cancelled`); `run.end` follows. */
  stopping: boolean;
}

export interface ThreadView {
  items: TimelineItem[];
  pending: PendingInput[];
  active: ActiveRun | null;
  has_earlier: boolean;
  loaded: boolean;
}

interface Derived {
  items: TimelineItem[];
  /** Requests in the window without an `input.resolved`, oldest first. */
  pending: PendingInput[];
  resolved: Set<string>;
  active: { run_id: string; stopping: boolean; waiting: boolean } | null;
}

const cache = new WeakMap<readonly StoredEvent[], Derived>();

export function threadView(s: ThreadState, fallbackActive?: { run_id: string; state: ActiveRun["state"] } | null): ThreadView {
  let d = cache.get(s.events);
  if (!d) {
    d = derive(s.events);
    cache.set(s.events, d);
  }
  const items = [...d.items];
  for (const st of s.streams)
    items.push({
      kind: "assistant",
      key: `stream:${st.message_id}`,
      seq: null,
      ts: st.ts,
      run_id: st.run_id,
      text: st.text,
      streaming: true,
      gap: st.gap,
      subagent: false,
    });
  for (const o of s.outbox)
    items.push({
      kind: "user",
      key: `outbox:${o.client_msg_id}`,
      seq: null,
      ts: o.created_at,
      run_id: null,
      client_msg_id: o.client_msg_id,
      text: o.text,
      disposition: null,
      surface: "desktop",
      delivery: o.state,
      error: o.error,
    });

  const inWindow = new Set(d.pending.map((p) => p.request_id));
  const before = s.pending_before
    .filter((r) => r.state === "pending" && !d.resolved.has(r.request_id) && !inWindow.has(r.request_id))
    .map(fromRequest);
  const pending = [...before, ...d.pending];

  let active: ActiveRun | null = null;
  const runId = d.active?.run_id ?? fallbackActive?.run_id ?? null;
  if (runId !== null) {
    const st = s.status[runId]?.payload;
    const waiting = pending.some((p) => p.run_id === runId) || (d.active?.run_id === runId && d.active.waiting);
    const fromEvents: ActiveRun["state"] = waiting ? "waiting_input" : d.active?.run_id === runId ? "running" : fallbackActive!.state;
    const state = st && (st.state === "pending" || st.state === "running" || st.state === "waiting_input") ? st.state : fromEvents;
    active = {
      run_id: runId,
      state,
      detail: st?.detail ?? null,
      queue_position: st?.queue_position ?? null,
      retry_at: st?.retry_at ?? null,
      stopping: (d.active?.run_id === runId && d.active.stopping) || st?.detail === "stopping",
    };
  }
  return { items, pending, active, has_earlier: s.has_earlier, loaded: s.loaded };
}

function fromRequest(r: InputRequest): PendingInput {
  return {
    request_id: r.request_id,
    run_id: r.run_id,
    prompt: r.prompt,
    required_authority: requiredAuthorityOf(r.prompt),
    requested_at: r.requested_at,
    expires_at: r.expires_at,
  };
}

function requiredAuthorityOf(p: InputPrompt): "any" | "full" {
  if (p.type === "question") return "any";
  return p.class === "read" ? "any" : "full";
}

function derive(events: readonly StoredEvent[]): Derived {
  const items: TimelineItem[] = [];
  const toolItems = new Map<string, ToolItem>();
  const inputItems = new Map<string, InputItem>();
  /** Calls answered through a question card: their tool row would repeat it. */
  const questionCalls = new Set<string>();
  const pendingByCall = new Map<string, string>();
  const ended = new Set<string>();
  const held = new Map<string, UserItem[]>();
  /** Resolutions of requests from before the window: they hide those from `pending_before`. */
  const resolved = new Set<string>();
  let active: Derived["active"] = null;

  for (const e of events) {
    switch (e.type) {
      case "user.message": {
        const p = e.payload;
        const item: UserItem = {
          kind: "user",
          key: `seq:${e.seq}`,
          seq: e.seq,
          ts: p.sent_at ?? e.ts,
          run_id: e.run_id,
          client_msg_id: p.client_msg_id,
          text: p.text,
          disposition: p.disposition,
          surface: p.origin.surface,
          delivery: p.disposition === "held" ? "held" : "delivered",
        };
        if (p.disposition === "held" && e.run_id !== null) held.set(e.run_id, [...(held.get(e.run_id) ?? []), item]);
        items.push(item);
        break;
      }
      case "message.final":
        items.push({
          kind: "assistant",
          key: `seq:${e.seq}`,
          seq: e.seq,
          ts: e.ts,
          run_id: e.run_id,
          text: e.payload.text,
          streaming: false,
          gap: false,
          subagent: e.payload.parent_tool_call_id !== undefined,
        });
        break;
      case "tool.call": {
        const item: ToolItem = {
          kind: "tool",
          key: `seq:${e.seq}`,
          seq: e.seq,
          ts: e.ts,
          run_id: e.run_id,
          call: e.payload,
          result: null,
          state: "running",
          subagent: e.payload.parent_tool_call_id !== undefined,
        };
        toolItems.set(e.payload.tool_call_id, item);
        items.push(item);
        break;
      }
      case "tool.result": {
        const t = toolItems.get(e.payload.tool_call_id);
        if (t) {
          t.result = e.payload;
          t.state = e.payload.status;
        }
        break;
      }
      case "input.requested": {
        const p = e.payload;
        const item: InputItem = {
          kind: "input",
          key: `seq:${e.seq}`,
          seq: e.seq,
          ts: e.ts,
          run_id: e.run_id,
          request_id: p.request_id,
          prompt: p.prompt,
          required_authority: p.required_authority,
          expires_at: p.expires_at,
          resolution: null,
        };
        inputItems.set(p.request_id, item);
        const call = p.prompt.tool_call_id;
        if (call !== undefined) {
          pendingByCall.set(call, p.request_id);
          if (p.prompt.type === "question") questionCalls.add(call);
        }
        items.push(item);
        break;
      }
      case "input.resolved": {
        const p = e.payload;
        const it = inputItems.get(p.request_id);
        if (it) {
          it.resolution = { state: p.state, response: p.response, answered_by: p.answered_by, surface: p.surface, ts: e.ts, grant_id: p.grant_id };
          const call = it.prompt.tool_call_id;
          if (call !== undefined && pendingByCall.get(call) === p.request_id) pendingByCall.delete(call);
        } else resolved.add(p.request_id);
        break;
      }
      case "run.started":
        active = { run_id: e.run_id!, stopping: false, waiting: false };
        items.push(runItem(e));
        break;
      case "run.resumed":
        if (e.run_id !== null) {
          for (const m of held.get(e.run_id) ?? []) m.delivery = "delivered";
          held.delete(e.run_id);
        }
        items.push(runItem(e));
        break;
      case "run.cancelled":
        if (active && active.run_id === e.run_id) active.stopping = true;
        items.push(runItem(e));
        break;
      case "run.end":
        if (e.run_id !== null) {
          ended.add(e.run_id);
          for (const m of held.get(e.run_id) ?? []) m.delivery = "not_delivered";
          held.delete(e.run_id);
        }
        if (active && active.run_id === e.run_id) active = null;
        items.push(runItem(e));
        break;
      case "schedule.missed":
      case "schedule.paused":
        items.push({ kind: "schedule", key: `seq:${e.seq}`, seq: e.seq, ts: e.ts, event: e });
        break;
      case "unknown":
        items.push({ kind: "unknown", key: `seq:${e.seq}`, seq: e.seq, original_type: e.original_type });
        break;
    }
  }

  const pending: PendingInput[] = [];
  for (const it of inputItems.values()) {
    if (it.resolution !== null) {
      resolved.add(it.request_id);
      continue;
    }
    // A request whose run ended without a resolution is stale (§5.6 cancels it; defensive).
    if (it.run_id !== null && ended.has(it.run_id)) continue;
    pending.push({
      request_id: it.request_id,
      run_id: it.run_id,
      prompt: it.prompt,
      required_authority: it.required_authority,
      requested_at: it.ts,
      expires_at: it.expires_at,
    });
  }
  for (const t of toolItems.values()) {
    if (t.result !== null) continue;
    if (pendingByCall.has(t.call.tool_call_id) && pending.some((p) => p.request_id === pendingByCall.get(t.call.tool_call_id))) t.state = "waiting";
    else if (t.run_id !== null && ended.has(t.run_id)) t.state = "no_result";
  }
  if (active) active.waiting = pending.some((p) => p.run_id === active!.run_id);
  const visible = items.filter((i) => !(i.kind === "tool" && questionCalls.has(i.call.tool_call_id) && i.call.tool === "AskUserQuestion"));
  return { items: visible, pending, resolved, active };
}

function runItem(e: RunItem["event"]): RunItem {
  return { kind: "run", key: `seq:${e.seq}`, seq: e.seq, ts: e.ts, run_id: e.run_id, event: e };
}
