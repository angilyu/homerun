import { z } from "zod";
import { LiveThreadEvent, PersistedThreadEvent } from "@homerun/core";
import type { Store } from "./store";

export type PersistedType = PersistedThreadEvent["type"];
type PersistedInput = z.input<typeof PersistedThreadEvent>;
export type PayloadInput<T extends PersistedType> = Extract<PersistedInput, { type: T }>["payload"];
export type EventOf<T extends PersistedType> = Extract<PersistedThreadEvent, { type: T }>;
type LiveInput = z.input<typeof LiveThreadEvent>;
export type LivePayloadInput<T extends LiveThreadEvent["type"]> = Extract<LiveInput, { type: T }>["payload"];

interface Row {
  thread_id: string;
  seq: number;
  run_id: string | null;
  ts: number;
  type: string;
  payload: string;
}

export function rowToEvent(r: Row): PersistedThreadEvent {
  return PersistedThreadEvent.parse({ thread_id: r.thread_id, seq: r.seq, run_id: r.run_id, ts: r.ts, type: r.type, payload: JSON.parse(r.payload) });
}

/**
 * Append a persisted event (§6 thread_events). Seq comes from `threads.last_seq` in the same
 * transaction, so it is gap-free: homerund is the only writer. The payload is validated with
 * the core schema first; a failure is a runtime bug and throws.
 */
export function appendEvent<T extends PersistedType>(
  store: Store,
  threadId: string,
  runId: string | null,
  type: T,
  payload: PayloadInput<T>,
  ts = Date.now(),
): EventOf<T> {
  return store.tx(() => {
    const row = store.db
      .query<{ last_seq: number }, [number, string]>("UPDATE threads SET last_seq = last_seq + 1, updated_at = ? WHERE thread_id = ? RETURNING last_seq")
      .get(ts, threadId);
    if (!row) throw new Error(`no thread ${threadId}`);
    const event = PersistedThreadEvent.parse({ thread_id: threadId, seq: row.last_seq, run_id: runId, ts, type, payload }) as EventOf<T>;
    store.db
      .query("INSERT INTO thread_events (thread_id, seq, run_id, ts, type, payload) VALUES (?, ?, ?, ?, ?, ?)")
      .run(threadId, event.seq, runId, ts, type, JSON.stringify(event.payload));
    store.afterCommit(() => store.bus.publish(event));
    return event;
  });
}

export function lastSeq(store: Store, threadId: string): number {
  return store.db.query<{ last_seq: number }, [string]>("SELECT last_seq FROM threads WHERE thread_id = ?").get(threadId)?.last_seq ?? 0;
}

/** Broadcast a live-only event (§6.1: never stored). */
export function publishLive<T extends LiveThreadEvent["type"]>(
  store: Store,
  threadId: string,
  runId: string | null,
  type: T,
  payload: LivePayloadInput<T>,
  ts = Date.now(),
): void {
  const event = LiveThreadEvent.parse({ thread_id: threadId, after_seq: lastSeq(store, threadId), run_id: runId, ts, type, payload });
  store.bus.publish(event);
}

export function eventsAfter(store: Store, threadId: string, afterSeq: number, limit = 10_000): PersistedThreadEvent[] {
  return store.db
    .query<Row, [string, number, number]>("SELECT * FROM thread_events WHERE thread_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(threadId, afterSeq, limit)
    .map(rowToEvent);
}

/** A page of history before `beforeSeq`, ascending within the page. */
export function historyPage(store: Store, threadId: string, beforeSeq: number | undefined, limit: number): { events: PersistedThreadEvent[]; has_more: boolean } {
  const rows = store.db
    .query<Row, [string, number, number]>("SELECT * FROM thread_events WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
    .all(threadId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const has_more = rows.length > limit;
  return { events: rows.slice(0, limit).reverse().map(rowToEvent), has_more };
}

export function runEvents<T extends PersistedType>(store: Store, runId: string, type: T): EventOf<T>[] {
  return store.db
    .query<Row, [string, string]>("SELECT * FROM thread_events WHERE run_id = ? AND type = ? ORDER BY seq")
    .all(runId, type)
    .map(rowToEvent) as EventOf<T>[];
}

export function findToolEvent<T extends "tool.call" | "tool.result">(store: Store, threadId: string, type: T, toolCallId: string): EventOf<T> | null {
  const r = store.db
    .query<Row, [string, string, string]>("SELECT * FROM thread_events WHERE thread_id = ? AND type = ? AND json_extract(payload, '$.tool_call_id') = ?")
    .get(threadId, type, toolCallId);
  return r ? (rowToEvent(r) as EventOf<T>) : null;
}

export function findUserMessage(store: Store, threadId: string, clientMsgId: string): EventOf<"user.message"> | null {
  const r = store.db
    .query<Row, [string, string]>("SELECT * FROM thread_events WHERE thread_id = ? AND type = 'user.message' AND json_extract(payload, '$.client_msg_id') = ?")
    .get(threadId, clientMsgId);
  return r ? (rowToEvent(r) as EventOf<"user.message">) : null;
}

/** tool.call events of a run that have no tool.result: the ambiguity anti-join (§5.4). */
export function callsWithoutResult(store: Store, runId: string): EventOf<"tool.call">[] {
  return store.db
    .query<Row, [string]>(
      `SELECT c.* FROM thread_events c
       WHERE c.run_id = ? AND c.type = 'tool.call'
         AND NOT EXISTS (SELECT 1 FROM thread_events r WHERE r.thread_id = c.thread_id AND r.type = 'tool.result'
                         AND json_extract(r.payload, '$.tool_call_id') = json_extract(c.payload, '$.tool_call_id'))
       ORDER BY c.seq`,
    )
    .all(runId)
    .map(rowToEvent) as EventOf<"tool.call">[];
}
