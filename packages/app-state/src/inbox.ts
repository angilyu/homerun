import type { InputRequest } from "@homerun/core";
import { errorMessage } from "./errors";
import type { Rpc } from "./rpc";
import { Store } from "./store";

export interface InboxEntry {
  request: InputRequest;
  /** The thread to open; null until its run is looked up. */
  thread_id: string | null;
}

export interface InboxState {
  entries: readonly InboxEntry[];
  loaded: boolean;
  error: string | null;
}

/**
 * Everything waiting for the user across threads (§5.6): `input.list_pending`, refreshed when a
 * thread's summary changes. A request names its run; the run names its thread.
 */
export class Inbox {
  readonly store = new Store<InboxState>({ entries: [], loaded: false, error: null });
  private readonly threadOfRun = new Map<string, string>();
  private inflight: Promise<void> | null = null;
  private again = false;

  constructor(private readonly rpc: Rpc) {}

  /** Coalesces: a refresh while one is running runs once more after it. */
  refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = this.load().finally(() => {
      this.inflight = null;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      const r = await this.rpc.call("input.list_pending", {});
      await Promise.all(
        [...new Set(r.requests.map((q) => q.run_id as string))]
          .filter((id) => !this.threadOfRun.has(id))
          .map(async (id) => {
            try {
              const run = await this.rpc.call("runs.get", { run_id: id });
              this.threadOfRun.set(id, run.run.thread_id);
            } catch {
              // Shown without a link.
            }
          }),
      );
      const entries = r.requests
        .map((request) => ({ request, thread_id: this.threadOfRun.get(request.run_id) ?? null }))
        .sort((a, b) => a.request.requested_at - b.request.requested_at);
      this.store.set({ entries, loaded: true, error: null });
    } catch (e) {
      this.store.set((s) => ({ ...s, error: errorMessage(e) }));
    }
  }
}
