import type { RpcClient } from "@homerun/client";
import { parseThreadEventLenient, type BuildChannel, type CallerRole, type ThreadEvent, type UnknownThreadEvent } from "@homerun/core";
import type { Values } from "./args";
import type { Env } from "./connect";
import type { Output, Stream } from "./output";

export interface Io {
  argv: string[];
  env: Env;
  channel: BuildChannel;
  stdout: Stream;
  stderr: Stream;
  stdin: NodeJS.ReadStream | (NodeJS.ReadableStream & { isTTY?: boolean });
  /** Called on Ctrl-C (SIGINT). Returns an unsubscribe function. */
  onInterrupt(fn: () => void): () => void;
}

export interface Ctx {
  io: Io;
  o: Output;
  c: RpcClient;
  values: Values;
  positionals: string[];
  role: CallerRole;
  /** The release role: where its token is kept. */
  tokenStore?: string;
}

export async function readAll(stdin: Io["stdin"]): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<Buffer | string>) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export interface Received {
  event: ThreadEvent | UnknownThreadEvent;
  /** As sent, for --json. */
  raw: unknown;
}

export interface Subscription {
  lastSeq: number;
  close(): Promise<void>;
}

/**
 * Subscribe to a thread from `afterSeq`: the persisted backlog, then live events (§9.8). Events
 * are matched on thread id rather than subscription id, because the backlog can arrive before the
 * reply's subscription id has been read. Persisted events are delivered once, in seq order.
 */
export async function subscribe(
  c: RpcClient,
  threadId: string,
  afterSeq: number,
  on: (r: Received) => void,
  onInvalid: (why: string) => void,
): Promise<Subscription> {
  let high = afterSeq;
  const off = c.onNotification((method, params) => {
    if (method !== "thread.event") return;
    const raw = (params as { event?: unknown } | null)?.event;
    const parsed = parseThreadEventLenient(raw);
    if (!parsed.ok) return onInvalid(parsed.error.issues[0]?.message ?? "invalid event");
    const e = parsed.event;
    if (e.thread_id !== threadId) return;
    const seq = e.type === "unknown" ? e.seq : "seq" in e ? e.seq : null;
    if (seq !== null) {
      if (seq <= high) return;
      high = seq;
    }
    on({ event: e, raw });
  });
  let sub;
  try {
    sub = await c.call("threads.subscribe", { thread_id: threadId, after_seq: afterSeq });
  } catch (e) {
    off();
    throw e;
  }
  return {
    lastSeq: sub.last_seq,
    async close() {
      off();
      if (c.isOpen) await c.call("threads.unsubscribe", { subscription_id: sub.subscription_id }).catch(() => {});
    },
  };
}

/** The last persisted seq on a thread (0 when empty). Also checks that the thread exists. */
export async function lastSeqOf(c: RpcClient, threadId: string): Promise<number> {
  const h = await c.call("threads.history", { thread_id: threadId, limit: 1 });
  return h.events.at(-1)?.seq ?? 0;
}
