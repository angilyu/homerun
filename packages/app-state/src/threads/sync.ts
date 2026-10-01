import { approvalDecision, needsApprovalProof, type ApprovalProof, type InputPrompt, type InputResponse, type MethodResult, type ThreadEvent, type UnknownThreadEvent } from "@homerun/core";
import type { Env } from "../env";
import { ApprovalNotConfirmedError, NotConnectedError, errorMessage } from "../errors";
import type { Rpc } from "../rpc";
import type { QueuedInstruction } from "../transport";
import { Store } from "../store";
import { CACHE_WRITE_MS, cacheableThread, quietly, type ThreadCache } from "./cache";
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
  /** Where this thread is kept between launches; the iOS app only (§9.8). */
  cache?: ThreadCache;
  /** Signs a destructive approval with Face ID; the iOS app only (§9.8, §18 row 115). */
  signApproval?: ApprovalSigner;
}

export type AnswerOutcome = MethodResult<"input.answer">;

/** What an iPhone signs for an answer that needs a proof; it adds its own and its desktop's ids. */
export interface ApprovalToSign {
  request_id: string;
  decision: string;
  expires_at: number;
}

/** Face ID, then the Secure Enclave approval key. Null when the user cancels or the phone has no key. */
export type ApprovalSigner = (a: ApprovalToSign) => Promise<ApprovalProof | null>;

/** How long a proof lives: long enough to reach a slow relay, well inside the runtime's 5 minutes. */
export const APPROVAL_PROOF_TTL_MS = 2 * 60 * 1000;

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
  private restoring: Promise<void> | null = null;
  private writeTimer: unknown = null;
  private unwatch: (() => void) | null = null;

  constructor(
    private readonly ctx: SyncContext,
    readonly thread_id: string,
  ) {
    this.store = new Store(initialThreadState(thread_id));
    if (ctx.cache) this.unwatch = this.store.subscribe(() => this.scheduleWrite());
  }

  /**
   * Show what the cache kept, before or without the runtime (§9.8). Opening afterwards subscribes
   * from the cached last seq, so the backlog fills in what happened meanwhile. A message sealed at
   * the relay shows until it expires there.
   */
  restore(): Promise<void> {
    this.restoring ??= (async () => {
      const cache = this.ctx.cache;
      if (!cache || this.store.get().loaded) return;
      const t = await cache.loadThread(this.thread_id).catch(() => null);
      if (!t || this.closed) return;
      const now = this.ctx.env.now();
      this.dispatch({ type: "cached", events: t.events, has_earlier: t.has_earlier, outbox: t.outbox.filter((o) => o.state !== "relayed" || (o.expires_at ?? 0) > now) });
    })();
    return this.restoring;
  }

  private scheduleWrite(): void {
    if (this.writeTimer !== null || this.closed) return;
    this.writeTimer = this.ctx.env.setTimeout(() => {
      this.writeTimer = null;
      this.write();
    }, CACHE_WRITE_MS);
  }

  private write(): void {
    const cache = this.ctx.cache;
    const t = cache ? cacheableThread(this.store.get()) : null;
    if (cache && t) quietly(() => cache.saveThread(this.thread_id, t));
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

  /**
   * First answer wins (§5.6): `already_resolved` says who answered first. On an iPhone, allowing a
   * destructive call asks Face ID first (`request` says what was asked); if it doesn't confirm,
   * nothing is sent (§9.8).
   */
  async answer(request_id: string, response: InputResponse, request?: { prompt: InputPrompt; expires_at: number | null }): Promise<AnswerOutcome> {
    let approval: ApprovalProof | undefined;
    if (this.ctx.signApproval && request && needsApprovalProof(request.prompt, response)) {
      const expires_at = Math.min(this.ctx.env.now() + APPROVAL_PROOF_TTL_MS, request.expires_at ?? Number.MAX_SAFE_INTEGER);
      const proof = await this.ctx.signApproval({ request_id, decision: approvalDecision(response) ?? "", expires_at }).catch(() => null);
      if (!proof) throw new ApprovalNotConfirmedError();
      approval = proof;
    }
    const r = await this.ctx.rpc.call("input.answer", { request_id, response, via: "app", ...(approval ? { approval } : {}) });
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
    this.unwatch?.();
    if (this.writeTimer !== null) {
      this.ctx.env.clearTimeout(this.writeTimer);
      this.writeTimer = null;
      this.write();
    }
    const sub = this.subscription;
    this.subscription = null;
    if (sub && this.ctx.connected()) void this.ctx.rpc.call("threads.unsubscribe", { subscription_id: sub }).catch(() => {});
  }
}
