import {
  isPersisted,
  type InputRequest,
  type PersistedThreadEvent,
  type ThreadEvent,
  type ThreadEventOf,
  type UnknownThreadEvent,
} from "@homerun/core";

/**
 * One thread's client state, reduced from `thread_events` (§5.3, §6, §9.8). Pure: the sync
 * (`sync.ts`) feeds it history pages and subscription events, and views derive the timeline
 * from it (`timeline.ts`).
 *
 * - Persisted events are kept as a contiguous window by `seq`, newest at the end. A duplicate
 *   is dropped; a skipped seq sets `gap` so the sync subscribes again from `last_seq`.
 * - Live-only events are never stored by the runtime (§6.1). Deltas build `streams` until their
 *   `message.final` arrives; a run that resumes or ends drops its open streams, because a
 *   resumed run starts its response again (§5.4).
 */

/** An unknown event from a newer runtime keeps its place in the seq order (§14). */
export type StoredEvent = PersistedThreadEvent | (UnknownThreadEvent & { seq: number });

export interface Stream {
  message_id: string;
  run_id: string | null;
  text: string;
  /** The next delta index expected. */
  next: number;
  /** Some text was missed (a delta skipped), so the stream shows a gap until its final. */
  gap: boolean;
  ts: number;
}

export type RunStatusEvent = ThreadEventOf<"run.status">;

/** A message the user sent that the thread doesn't show yet (§5.7, §9.4). */
export interface OutboxItem {
  client_msg_id: string;
  text: string;
  created_at: number;
  /**
   * sending: the call is out. queued: the runtime was unreachable; sent on reconnect.
   * relayed: sealed at the relay for an offline desktop, until `expires_at` (§9.4). failed: refused.
   */
  state: "sending" | "queued" | "relayed" | "failed";
  error?: string;
  expires_at?: number;
}

export interface ThreadState {
  thread_id: string;
  events: readonly StoredEvent[];
  /** The last persisted seq received; 0 when none. */
  last_seq: number;
  /** Older events exist before `events[0]`. */
  has_earlier: boolean;
  /** The first history page arrived. */
  loaded: boolean;
  streams: readonly Stream[];
  /** Latest `run.status` per run, cleared by its `run.end`. */
  status: Readonly<Record<string, RunStatusEvent>>;
  outbox: readonly OutboxItem[];
  /** Pending requests from before the loaded window (`input.list_pending`). */
  pending_before: readonly InputRequest[];
  /** A persisted event arrived after a skipped seq: resubscribe from `last_seq`. */
  gap: boolean;
}

export type ThreadAction =
  | { type: "latest"; events: readonly StoredEvent[]; has_more: boolean }
  /** The window a cache kept (`cache.ts`), shown until the runtime answers; ignored once loaded. */
  | { type: "cached"; events: readonly StoredEvent[]; has_earlier: boolean; outbox: readonly OutboxItem[] }
  | { type: "earlier"; events: readonly StoredEvent[]; has_more: boolean }
  | { type: "event"; event: ThreadEvent | UnknownThreadEvent }
  | { type: "pending"; requests: readonly InputRequest[] }
  | { type: "resynced" }
  | { type: "outbox_add"; item: OutboxItem }
  | { type: "outbox_update"; client_msg_id: string; state: OutboxItem["state"]; error?: string; expires_at?: number }
  | { type: "outbox_remove"; client_msg_id: string };

export function initialThreadState(thread_id: string): ThreadState {
  return { thread_id, events: [], last_seq: 0, has_earlier: false, loaded: false, streams: [], status: {}, outbox: [], pending_before: [], gap: false };
}

const seqOf = (e: StoredEvent) => e.seq;

export function reduceThread(s: ThreadState, a: ThreadAction): ThreadState {
  switch (a.type) {
    case "latest": {
      if (s.loaded) {
        // A reload: anything newer than the window goes through the normal path.
        let next = s;
        for (const e of a.events) next = reduceThread(next, { type: "event", event: e });
        return next;
      }
      const events = contiguousTail(a.events);
      const last = events.at(-1);
      const s2: ThreadState = {
        ...s,
        loaded: true,
        events,
        last_seq: last ? seqOf(last) : 0,
        has_earlier: a.has_more || events.length < a.events.length,
        outbox: dropSent(s.outbox, events),
      };
      return events.reduce(applySideEffects, s2);
    }
    case "cached": {
      if (s.loaded) return s;
      const events = contiguousTail(a.events);
      const last = events.at(-1);
      const s2: ThreadState = {
        ...s,
        loaded: true,
        events,
        last_seq: last ? seqOf(last) : 0,
        has_earlier: a.has_earlier || events.length < a.events.length,
        outbox: dropSent([...a.outbox.filter((o) => !s.outbox.some((x) => x.client_msg_id === o.client_msg_id)), ...s.outbox], events),
      };
      return events.reduce(applySideEffects, s2);
    }
    case "earlier": {
      const first = s.events[0];
      const limit = first ? seqOf(first) : s.last_seq + 1;
      const older = a.events.filter((e) => seqOf(e) < limit);
      // Only a page that ends right before the window extends it.
      const tail = contiguousTail(older);
      if (tail.length === 0 || seqOf(tail.at(-1)!) !== limit - 1) return { ...s, has_earlier: a.has_more || tail.length > 0 };
      return { ...s, events: [...tail, ...s.events], has_earlier: a.has_more || tail.length < older.length };
    }
    case "event":
      return reduceEvent(s, a.event);
    case "pending":
      return { ...s, pending_before: a.requests };
    case "resynced":
      return s.gap ? { ...s, gap: false } : s;
    case "outbox_add":
      return { ...s, outbox: [...s.outbox.filter((o) => o.client_msg_id !== a.item.client_msg_id), a.item] };
    case "outbox_update": {
      if (!s.outbox.some((o) => o.client_msg_id === a.client_msg_id)) return s;
      return {
        ...s,
        outbox: s.outbox.map((o) => (o.client_msg_id === a.client_msg_id ? { ...o, state: a.state, error: a.error, ...(a.expires_at !== undefined ? { expires_at: a.expires_at } : {}) } : o)),
      };
    }
    case "outbox_remove":
      return { ...s, outbox: s.outbox.filter((o) => o.client_msg_id !== a.client_msg_id) };
  }
}

function reduceEvent(s: ThreadState, e: ThreadEvent | UnknownThreadEvent): ThreadState {
  if (e.thread_id !== s.thread_id) return s;
  if (e.type === "unknown") {
    if (e.seq === null) return s; // an unknown live-only event: nothing to keep
    return appendPersisted(s, e as StoredEvent);
  }
  if (isPersisted(e)) return appendPersisted(s, e);
  switch (e.type) {
    case "message.delta":
      return applyDelta(s, e);
    case "run.status":
      return e.run_id === null ? s : { ...s, status: { ...s.status, [e.run_id]: e } };
  }
  return s;
}

function appendPersisted(s: ThreadState, e: StoredEvent): ThreadState {
  if (e.seq <= s.last_seq) return s;
  if (e.seq !== s.last_seq + 1) return s.gap ? s : { ...s, gap: true };
  const next: ThreadState = {
    ...s,
    events: [...s.events, e],
    last_seq: e.seq,
    outbox: e.type === "user.message" ? s.outbox.filter((o) => o.client_msg_id !== e.payload.client_msg_id) : s.outbox,
  };
  return applySideEffects(next, e);
}

/** What a persisted event does to live state. */
function applySideEffects(s: ThreadState, e: StoredEvent): ThreadState {
  switch (e.type) {
    case "message.final": {
      const streams = s.streams.filter((x) => x.message_id !== e.payload.message_id);
      return streams.length === s.streams.length ? s : { ...s, streams };
    }
    case "run.resumed":
    case "run.end": {
      const streams = s.streams.filter((x) => x.run_id !== e.run_id);
      let status = s.status;
      if (e.type === "run.end" && e.run_id !== null && e.run_id in status) {
        const { [e.run_id]: _gone, ...rest } = status;
        status = rest;
      }
      return streams.length === s.streams.length && status === s.status ? s : { ...s, streams, status };
    }
    default:
      return s;
  }
}

function applyDelta(s: ThreadState, e: ThreadEventOf<"message.delta">): ThreadState {
  const { message_id, index, text } = e.payload;
  // A delta for a message whose final is already here is late: ignore it.
  if (s.events.some((x) => x.type === "message.final" && x.payload.message_id === message_id)) return s;
  const i = s.streams.findIndex((x) => x.message_id === message_id);
  if (i < 0) {
    const stream: Stream = { message_id, run_id: e.run_id, text, next: index + 1, gap: index > 0, ts: e.ts };
    return { ...s, streams: [...s.streams, stream] };
  }
  const cur = s.streams[i]!;
  if (index < cur.next) return s; // duplicate (a resubscribe replays nothing live, but two subscriptions may overlap)
  const updated: Stream = { ...cur, text: cur.text + text, next: index + 1, gap: cur.gap || index > cur.next };
  const streams = [...s.streams];
  streams[i] = updated;
  return { ...s, streams };
}

/** The longest run of consecutive seqs at the end of an ascending page. */
function contiguousTail(events: readonly StoredEvent[]): StoredEvent[] {
  const sorted = [...events].sort((a, b) => seqOf(a) - seqOf(b));
  const dedup = sorted.filter((e, i) => i === 0 || seqOf(e) !== seqOf(sorted[i - 1]!));
  let start = dedup.length - 1;
  while (start > 0 && seqOf(dedup[start - 1]!) === seqOf(dedup[start]!) - 1) start--;
  return start < 0 ? [] : dedup.slice(start);
}

function dropSent(outbox: readonly OutboxItem[], events: readonly StoredEvent[]): readonly OutboxItem[] {
  if (outbox.length === 0) return outbox;
  const sent = new Set(events.flatMap((e) => (e.type === "user.message" ? [e.payload.client_msg_id as string] : [])));
  return outbox.filter((o) => !sent.has(o.client_msg_id));
}
