import type { ThreadEvent, ThreadSummary } from "@homerun/core";
import { threadSummary } from "../store/rows";
import { log } from "../log";
import type { Store } from "../store/store";

/** Coalesce a burst (a run starting, a tool call and its result) into one summary per thread. */
export const CHANGES_DELAY_MS = 50;

/** Every event that can change a thread's summary. Deltas cannot, and they are frequent. */
const SKIP = new Set<ThreadEvent["type"]>(["message.delta"]);

/**
 * `threads.changed` (§9.8): the thread list stays current without polling. Every persisted
 * event and `run.status` marks its thread; the runtime also touches a thread it creates or
 * whose read marker moves. Summaries are computed for this device, the only one with a local
 * connection until the relay (M9) computes its own per device.
 */
export class ThreadChanges {
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private off: (() => void) | null = null;

  constructor(
    private store: Store,
    private deviceId: string,
    private send: (summary: ThreadSummary) => void,
    private delayMs = CHANGES_DELAY_MS,
  ) {}

  start(): void {
    this.off ??= this.store.bus.subscribeAll((e) => {
      if (!SKIP.has(e.type)) this.touch(e.thread_id);
    });
  }

  /** Send this thread's summary soon, after the current transaction commits. */
  touch(threadId: string): void {
    this.store.afterCommit(() => {
      this.dirty.add(threadId);
      this.timer ??= setTimeout(() => this.flush(), this.delayMs);
    });
  }

  /** Send every pending summary now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      try {
        const s = threadSummary(this.store, id, this.deviceId);
        if (s) this.send(s);
      } catch (e) {
        // The database closed under a pending flush (shutdown); the next start sends fresh lists.
        log.warn("thread summary not sent", { thread_id: id, err: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  stop(): void {
    this.off?.();
    this.off = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty.clear();
  }
}
