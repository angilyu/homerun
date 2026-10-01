import type { ThreadSummary } from "@homerun/core";
import type { OutboxItem, StoredEvent, ThreadState } from "./reducer";

/**
 * What a client keeps of one thread between launches (§9.8): the newest persisted events, and
 * the messages the desktop hasn't applied yet. The iOS app stores it in its encrypted SQLite
 * cache; the desktop and the web keep nothing (§18 row 106). One cache per desktop.
 */
export interface CachedThread {
  events: readonly StoredEvent[];
  has_earlier: boolean;
  outbox: readonly OutboxItem[];
}

/**
 * The cache seam `ThreadSync` and `ThreadList` read on open and write as state changes. Writes are
 * best effort: a failure (the phone locked, the disk full) costs only the next launch's head start.
 * Reads that fail or return null start from the runtime, as without a cache.
 */
export interface ThreadCache {
  loadThread(thread_id: string): Promise<CachedThread | null>;
  saveThread(thread_id: string, t: CachedThread): void | Promise<void>;
  loadList(): Promise<readonly ThreadSummary[] | null>;
  saveList(threads: readonly ThreadSummary[]): void | Promise<void>;
}

/** Events kept per thread: a screenful or two, read offline; older pages come from the desktop. */
export const CACHED_EVENTS = 200;
/** Thread summaries kept: the first `threads.list` page. */
export const CACHED_THREADS = 100;
/** How long state settles before it's written, so a streaming run isn't written per delta. */
export const CACHE_WRITE_MS = 1000;

/** What to write for a thread, or null while it has nothing contiguous to keep. */
export function cacheableThread(s: ThreadState): CachedThread | null {
  if (!s.loaded || s.gap) return null;
  const events = s.events.slice(-CACHED_EVENTS);
  return {
    events,
    has_earlier: s.has_earlier || s.events.length > events.length,
    // A message whose call was out may have arrived: `messages.send` is idempotent, so it's sent again.
    outbox: s.outbox.flatMap((o) => (o.state === "failed" ? [] : [o.state === "sending" ? { ...o, state: "queued" as const } : o])),
  };
}

/** Best-effort write: a cache never fails what it caches. */
export function quietly(write: () => void | Promise<void>): void {
  try {
    void Promise.resolve(write()).catch(() => {});
  } catch {
    // ignored: see `ThreadCache`
  }
}
