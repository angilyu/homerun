import { NOTIFICATIONS, parseThreadEventLenient, type HealthDigest } from "@homerun/core";
import { defaultEnv, type Env } from "./env";
import { Inbox } from "./inbox";
import { Remote } from "./remote";
import { Rpc } from "./rpc";
import { Store } from "./store";
import { Tasks } from "./tasks";
import { ThreadList } from "./threads/list";
import { ThreadSync } from "./threads/sync";
import type { ClientRole, RuntimeStatus, Transport, TransportEvent } from "./transport";

export interface AppClientOptions {
  env?: Env;
  /** How long a thread nobody shows stays subscribed, so switching back is instant. */
  keepThreadMs?: number;
  /** Reports a notification that didn't parse (a bug or a version mismatch). */
  onProtocolError?: (what: string, detail: unknown) => void;
  /** Load the account and paired devices on connect: the desktop's local UI only (§10). */
  remote?: boolean;
  /** Who this client is to the runtime; decides what the views offer (§9.9). Default `webview`. */
  role?: ClientRole;
}

/**
 * The client state layer's root (§9.8): one per app. It owns the typed RPC, the runtime status,
 * the thread list, the inbox, tasks and open threads, and routes notifications to them. Views
 * read its stores; nothing here knows about React, the DOM or Tauri.
 */
export class AppClient {
  readonly env: Env;
  readonly role: ClientRole;
  readonly rpc: Rpc;
  readonly runtime: Store<RuntimeStatus>;
  readonly threads: ThreadList;
  readonly inbox: Inbox;
  readonly tasks: Tasks;
  /** The desktop's account, relay link and paired devices (§10). */
  readonly remote: Remote;
  /** The latest daily digest pushed by the runtime (§8.3), until read. */
  readonly digest = new Store<HealthDigest | null>(null);

  private readonly syncs = new Map<string, { sync: ThreadSync; refs: number; timer: unknown }>();
  private readonly keepMs: number;
  private connection = -1;
  private unlisten: (() => void) | null = null;
  private inboxTimer: unknown = null;

  constructor(
    private readonly transport: Transport,
    private readonly opts: AppClientOptions = {},
  ) {
    this.env = opts.env ?? defaultEnv();
    this.role = opts.role ?? "webview";
    this.keepMs = opts.keepThreadMs ?? 60_000;
    this.rpc = new Rpc(transport);
    this.runtime = new Store(transport.status());
    this.threads = new ThreadList(this.rpc);
    this.inbox = new Inbox(this.rpc);
    this.tasks = new Tasks(this.rpc);
    this.remote = new Remote(this.rpc);
  }

  start(): void {
    if (this.unlisten) return;
    this.unlisten = this.transport.listen((e) => this.onEvent(e));
    this.onStatus(this.transport.status());
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
    for (const { sync, timer } of this.syncs.values()) {
      if (timer !== null) this.env.clearTimeout(timer);
      sync.close();
    }
    this.syncs.clear();
  }

  get connected(): boolean {
    return this.runtime.get().state === "ready";
  }

  get deviceId(): string | null {
    const s = this.runtime.get();
    return s.state === "ready" ? s.device_id : null;
  }

  /**
   * Hold a thread open while a view shows it. Call the returned function when it goes away; the
   * subscription lingers for `keepThreadMs`.
   */
  retainThread(thread_id: string): { sync: ThreadSync; release: () => void } {
    let entry = this.syncs.get(thread_id);
    if (!entry) {
      const queue = this.transport.queueInstruction?.bind(this.transport);
      const sync = new ThreadSync({ rpc: this.rpc, env: this.env, connected: () => this.connected, ...(queue ? { queue } : {}) }, thread_id);
      entry = { sync, refs: 0, timer: null };
      this.syncs.set(thread_id, entry);
      if (this.connected) void sync.open().catch(() => {});
    }
    if (entry.timer !== null) {
      this.env.clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.refs++;
    const e = entry;
    let released = false;
    return {
      sync: e.sync,
      release: () => {
        if (released) return;
        released = true;
        e.refs--;
        if (e.refs > 0) return;
        e.timer = this.env.setTimeout(() => {
          if (e.refs > 0 || this.syncs.get(thread_id) !== e) return;
          this.syncs.delete(thread_id);
          e.sync.close();
        }, this.keepMs);
      },
    };
  }

  /** Start a chat: a one-off, or a new chat on a session task (§2.1). */
  /** A thread, titled by the caller (a new chat uses `chatTitle` of its first message). */
  async createThread(task_id?: string, title?: string): Promise<string> {
    const r = await this.rpc.call("threads.create", { ...(task_id ? { task_id } : {}), ...(title ? { title } : {}) });
    return r.thread.thread_id;
  }

  private onEvent(e: TransportEvent): void {
    if (e.type === "status") return this.onStatus(e.status);
    this.onNotification(e.method, e.params);
  }

  private onStatus(s: RuntimeStatus): void {
    this.runtime.set(s);
    if (s.state !== "ready" || s.connection === this.connection) return;
    this.connection = s.connection;
    // A new connection: subscriptions belong to the old one (§5.2). Reload and resubscribe.
    void this.threads.load();
    void this.inbox.refresh();
    void this.tasks.refresh();
    if (this.opts.remote) void this.remote.refresh();
    for (const { sync } of this.syncs.values()) void sync.reconnected().catch(() => {});
  }

  private onNotification(method: string, params: unknown): void {
    if (this.remote.apply(method, params, this.opts.onProtocolError)) return;
    switch (method) {
      case "thread.event": {
        const raw = (params as { event?: unknown } | null)?.event;
        const r = parseThreadEventLenient(raw);
        if (!r.ok) return this.opts.onProtocolError?.("thread.event", r.error.issues);
        this.syncs.get(r.event.thread_id)?.sync.receive(r.event);
        return;
      }
      case "threads.changed": {
        const r = NOTIFICATIONS["threads.changed"].params.safeParse(params);
        if (!r.success) return this.opts.onProtocolError?.("threads.changed", r.error.issues);
        const before = this.threads.get(r.data.summary.thread_id);
        this.threads.apply(r.data.summary);
        if (!before || before.input_pending !== r.data.summary.input_pending || r.data.summary.input_pending) this.pokeInbox();
        return;
      }
      case "health.digest_ready": {
        const r = NOTIFICATIONS["health.digest_ready"].params.safeParse(params);
        if (!r.success) return this.opts.onProtocolError?.("health.digest_ready", r.error.issues);
        this.digest.set(r.data.digest);
        return;
      }
    }
  }

  /** Summaries change in bursts; refresh the inbox once per burst. */
  private pokeInbox(): void {
    if (this.inboxTimer !== null) return;
    this.inboxTimer = this.env.setTimeout(() => {
      this.inboxTimer = null;
      void this.inbox.refresh();
    }, 150);
  }
}
