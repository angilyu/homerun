import type { LiveThreadEvent, PersistedThreadEvent, ThreadEvent } from "@homerun/core";

export type Listener = (e: ThreadEvent) => void;

/**
 * In-process fan-out of thread events: persisted ones after commit, live-only ones directly.
 * Listeners run synchronously, so a subscriber's backlog read and its registration happen in
 * the same tick and nothing is missed or duplicated (plan §6).
 */
export class Bus {
  private byThread = new Map<string, Set<Listener>>();
  private global = new Set<Listener>();

  subscribe(threadId: string, fn: Listener): () => void {
    let s = this.byThread.get(threadId);
    if (!s) this.byThread.set(threadId, (s = new Set()));
    s.add(fn);
    return () => {
      s.delete(fn);
      if (s.size === 0) this.byThread.delete(threadId);
    };
  }

  /** Every event on every thread (tests, logging). */
  subscribeAll(fn: Listener): () => void {
    this.global.add(fn);
    return () => this.global.delete(fn);
  }

  publish(e: PersistedThreadEvent | LiveThreadEvent): void {
    for (const fn of [...(this.byThread.get(e.thread_id) ?? [])]) safe(fn, e);
    for (const fn of [...this.global]) safe(fn, e);
  }
}

function safe(fn: Listener, e: ThreadEvent) {
  try {
    fn(e);
  } catch (err) {
    process.stderr.write(`bus listener failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
