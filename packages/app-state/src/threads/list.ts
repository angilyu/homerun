import type { ThreadSummary } from "@homerun/core";
import { errorMessage } from "../errors";
import type { Rpc } from "../rpc";
import { Store } from "../store";

export interface ThreadListState {
  threads: readonly ThreadSummary[];
  loaded: boolean;
  has_more: boolean;
  error: string | null;
}

const PAGE = 100;

const byRecency = (a: ThreadSummary, b: ThreadSummary) => b.updated_at - a.updated_at || (a.thread_id < b.thread_id ? -1 : 1);

/**
 * Thread summaries, most recent first (§9.8): `threads.list`, then patched by `threads.changed`,
 * which the runtime sends to every connection whenever a summary changes.
 */
export class ThreadList {
  readonly store = new Store<ThreadListState>({ threads: [], loaded: false, has_more: false, error: null });

  /** The list on screen came from a cache: the first page replaces it, deleted threads and all. */
  private cached = false;

  constructor(private readonly rpc: Rpc) {}

  /** Show the cached list until the runtime answers (§9.8). */
  restore(threads: readonly ThreadSummary[]): void {
    const s = this.store.get();
    if (s.loaded || s.threads.length > 0 || threads.length === 0) return;
    this.cached = true;
    this.store.set({ ...s, threads: merge([], threads) });
  }

  async load(): Promise<void> {
    try {
      const r = await this.rpc.call("threads.list", { limit: PAGE });
      const fresh = this.cached;
      this.cached = false;
      this.store.set((s) => ({ threads: merge(r.threads, s.loaded || fresh ? [] : s.threads), loaded: true, has_more: r.has_more, error: null }));
    } catch (e) {
      this.store.set((s) => ({ ...s, error: errorMessage(e) }));
    }
  }

  async loadMore(): Promise<void> {
    const s = this.store.get();
    const last = s.threads.at(-1);
    if (!s.has_more || !last) return;
    const r = await this.rpc.call("threads.list", { limit: PAGE, updated_before: last.updated_at });
    this.store.set((cur) => ({ ...cur, threads: merge(cur.threads, r.threads), has_more: r.has_more }));
  }

  apply(summary: ThreadSummary): void {
    this.store.set((s) => ({ ...s, threads: merge(s.threads, [summary]) }));
  }

  get(thread_id: string): ThreadSummary | undefined {
    return this.store.get().threads.find((t) => t.thread_id === thread_id);
  }
}

/** Newer summaries win (by `last_seq`, then `updated_at`). */
function merge(base: readonly ThreadSummary[], updates: readonly ThreadSummary[]): ThreadSummary[] {
  const m = new Map(base.map((t) => [t.thread_id as string, t]));
  for (const u of updates) {
    const cur = m.get(u.thread_id);
    if (!cur || u.last_seq > cur.last_seq || (u.last_seq === cur.last_seq && u.updated_at >= cur.updated_at)) m.set(u.thread_id, u);
  }
  return [...m.values()].sort(byRecency);
}

export interface ThreadGroups {
  /** An approval or question is waiting (§5.6). */
  needs_you: ThreadSummary[];
  running: ThreadSummary[];
  recent: ThreadSummary[];
}

/** The sidebar's sections. A thread appears once, in the first group that fits. */
export function groupThreads(threads: readonly ThreadSummary[]): ThreadGroups {
  const g: ThreadGroups = { needs_you: [], running: [], recent: [] };
  for (const t of threads) {
    if (t.input_pending) g.needs_you.push(t);
    else if (t.active_run) g.running.push(t);
    else g.recent.push(t);
  }
  return g;
}
