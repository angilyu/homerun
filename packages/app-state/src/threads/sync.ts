import type { InputResponse, MethodResult, ThreadEvent, UnknownThreadEvent } from "@homerun/core";
import type { Env } from "../env";
import { NotConnectedError, errorMessage } from "../errors";
import type { Rpc } from "../rpc";
import type { QueuedInstruction } from "../transport";
import { Store } from "../store";
import { initialThreadState, reduceThread, type ThreadAction, type ThreadState } from "./reducer";

/** Events per history page. */
export const HISTORY_PAGE = 50;

export interface SyncContext {
  rpc: Rpc;
  env: Env;
  /** Whether the runtime is reachable now. */
  connected(): boolean;
  /** Seals a message at the relay while the desktop is offline; remote clients only (§9.4). */
  queue?: (i: QueuedInstruction) => Promise<{ expires_at: number }>;
}

export type AnswerOutcome = MethodResult<"input.answer">;

/**
 * Keeps one open thread in sync (§5.2, §9.8): the latest history page, then a subscription from
 * its last seq, so the backlog and live events arrive gap-free. After a reconnect or a seq gap it
 * subscribes again from the last seq it holds. Sending goes through an outbox keyed by
 * `client_msg_id`; `messages.send` is idempotent on it, so a retry after a reconnect never
 * sends twice (§5.7). A remote client whose desktop is offline seals the message at the relay
 * instead (§9.4); the desktop applies it once when it is back.
 */
export class ThreadSync {
  readonly store: Store<ThreadState>;
  private subscription: string | null = null;
  private opening: Promise<void> | null = null;
  private resyncing = false;
  private closed = false;
  private readMarker = 0;

  constructor(
    private readonly ctx: SyncContext,
    readonly thread_id: string,
  ) {
    this.store = new Store(initialThreadState(thread_id));
  }

  private dispatch(a: ThreadAction): void {
    this.store.set((s) => reduceThread(s, a));
  }

  /** First load, or a reload after a reconnect. Safe to call more than once. */
  open(): Promise<void> {
    if (!this.opening)
      this.opening = this.load().finally(() => {
        this.opening = null;
      });
    return this.opening;
  }

  private async load(): Promise<void> {
    if (!this.store.get().loaded) {
      const page = await this.ctx.rpc.call("threads.history", { thread_id: this.thread_id, limit: HISTORY_PAGE });
      this.dispatch({ type: "latest", events: page.events, has_more: page.has_more });
    }
    await this.subscribe();
    await this.refreshPending();
  }

  private async subscribe(): Promise<void> {
    if (this.closed) return;
    const old = this.subscription;
    this.subscription = null;
    if (old) void this.ctx.rpc.call("threads.unsubscribe", { subscription_id: old }).catch(() => {});
    const r = await this.ctx.rpc.call("threads.subscribe", { thread_id: this.thread_id, after_seq: this.store.get().last_seq });
    if (this.closed) {
      void this.ctx.rpc.call("threads.unsubscribe", { subscription_id: r.subscription_id }).catch(() => {});
      return;
    }
    this.subscription = r.subscription_id;
    this.dispatch({ type: "resynced" });
  }

  /** Pending requests from before the loaded window. */
  async refreshPending(): Promise<void> {
    const r = await this.ctx.rpc.call("input.list_pending", { thread_id: this.thread_id });
    this.dispatch({ type: "pending", requests: r.requests });
  }

  /** A `thread.event` for this thread, from any subscription (a stale one is deduplicated by seq). */
  receive(event: ThreadEvent | UnknownThreadEvent): void {
    if (this.closed) return;
    this.dispatch({ type: "event", event });
    if (this.store.get().gap && !this.resyncing) {
      this.resyncing = true;
      void this.subscribe()
        .catch(() => {})
        .finally(() => {
          this.resyncing = false;
        });
    }
  }

  /** The connection was replaced: subscriptions are gone. Subscribe again and send what's queued. */
  async reconnected(): Promise<void> {
    this.subscription = null;
    await this.open();
    await this.flushOutbox();
  }

  async loadEarlier(): Promise<void> {
    const s = this.store.get();
    const first = s.events[0];
    if (!s.has_earlier || !first) return;
    const page = await this.ctx.rpc.call("threads.history", { thread_id: this.thread_id, before_seq: first.seq, limit: HISTORY_PAGE });
    this.dispatch({ type: "earlier", events: page.events, has_more: page.has_more });
  }

  /**
   * Send a message: starts a run, steers the running one, or is held while it waits for input
   * (§5.7). The bubble shows at once; it leaves the outbox when its `user.message` arrives.
   */
  async send(text: string): Promise<void> {
    const client_msg_id = this.ctx.env.newId();
    const created_at = this.ctx.env.now();
    const connected = this.ctx.connected();
    this.dispatch({ type: "outbox_add", item: { client_msg_id, text, created_at, state: connected ? "sending" : "queued" } });
    if (connected) await this.deliver(client_msg_id, text, null);
    else await this.relay(client_msg_id, text);
  }

  /** Send a failed or not-delivered message again, as a new message (§5.7). */
  async resend(text: string, failedId?: string): Promise<void> {
    if (failedId) this.dispatch({ type: "outbox_remove", client_msg_id: failedId });
    await this.send(text);
  }

  discard(client_msg_id: string): void {
    this.dispatch({ type: "outbox_remove", client_msg_id });
  }

  private async deliver(client_msg_id: string, text: string, sent_at: number | null): Promise<void> {
    this.dispatch({ type: "outbox_update", client_msg_id, state: "sending" });
    try {
      await this.ctx.rpc.call("messages.send", {
        thread_id: this.thread_id,
        client_msg_id,
        text,
        ...(sent_at !== null ? { sent_at } : {}),
      });
    } catch (e) {
      if (!(e instanceof NotConnectedError)) this.dispatch({ type: "outbox_update", client_msg_id, state: "failed", error: errorMessage(e) });
      else {
        this.dispatch({ type: "outbox_update", client_msg_id, state: "queued" });
        await this.relay(client_msg_id, text);
      }
    }
  }

  /** Sealed at the relay for the desktop, or left queued here if even that fails. */
  private async relay(client_msg_id: string, text: string): Promise<void> {
    if (!this.ctx.queue) return;
    try {
      const { expires_at } = await this.ctx.queue({ thread_id: this.thread_id, client_msg_id, text });
      this.dispatch({ type: "outbox_update", client_msg_id, state: "relayed", expires_at });
    } catch {
      // Still queued: sent when the desktop is back while this client is open.
    }
  }

  /** Queued messages go out with their original time (§9.4). Relayed ones are the desktop's to apply. */
  private async flushOutbox(): Promise<void> {
    for (const o of this.store.get().outbox) {
      if (o.state === "queued" || o.state === "sending") await this.deliver(o.client_msg_id, o.text, o.created_at);
    }
  }

  async stop(run_id: string): Promise<void> {
    await this.ctx.rpc.call("runs.stop", { run_id });
  }

  /** First answer wins (§5.6): `already_resolved` says who answered first. */
  async answer(request_id: string, response: InputResponse): Promise<AnswerOutcome> {
    const r = await this.ctx.rpc.call("input.answer", { request_id, response, via: "app" });
    if (r.status === "already_resolved") void this.refreshPending().catch(() => {});
    return r;
  }

  /** Move this device's read marker to the end (§9.8). Call while the thread is on screen. */
  async markRead(): Promise<void> {
    const seq = this.store.get().last_seq;
    if (seq <= this.readMarker || !this.ctx.connected()) return;
    this.readMarker = seq;
    try {
      await this.ctx.rpc.call("threads.mark_read", { thread_id: this.thread_id, seq });
    } catch {
      this.readMarker = 0;
    }
  }

  close(): void {
    this.closed = true;
    const sub = this.subscription;
    this.subscription = null;
    if (sub && this.ctx.connected()) void this.ctx.rpc.call("threads.unsubscribe", { subscription_id: sub }).catch(() => {});
  }
}
