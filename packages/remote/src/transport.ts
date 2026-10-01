import {
  NotConnectedError,
  RpcCallError as AppRpcCallError,
  type BlockedReason,
  type QueuedInstruction,
  type RuntimeStatus,
  type Transport,
  type TransportEvent,
} from "@homerun/app-state";
import { HelloResult, PROTOCOL_VERSION, RPC_ERROR, SEALED_EXPIRY_DEFAULT_MS, type ClientMsgId, type JsonValue, type ThreadId } from "@homerun/core";
import type { RemoteClient } from "./client";
import { LiveClosedError, type RemoteLive, RpcCallError } from "./live";

/**
 * `@homerun/app-state`'s `Transport` over the relay (§9.3, §9.8): a live session with one paired
 * desktop, opened when the relay says the desktop is online and opened again after it drops. The
 * views then work as they do on the desktop; what the runtime lets this device do follows its
 * role (§9.9). While the desktop is away the status is `offline` and messages are sealed at the
 * relay instead (§9.4).
 */

export interface RelayTransportOptions {
  client: RemoteClient;
  desktopId: string;
  /** Sent in `hello`; shown nowhere, logged by the runtime. */
  clientInfo: { name: string; version: string };
  /** Backoff between failed attempts while the desktop is online. */
  retry?: { initialMs: number; maxMs: number };
  openTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_RETRY = { initialMs: 1000, maxMs: 30_000 };

export class RelayTransport implements Transport {
  private current: RuntimeStatus = { state: "starting" };
  private listeners = new Set<(e: TransportEvent) => void>();
  private live: RemoteLive | null = null;
  private opening = false;
  private connection = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The desktop refused our hello; tried again only on `retry()`. */
  private refused = false;
  private closed = false;
  private readonly offs: (() => void)[];

  constructor(private readonly o: RelayTransportOptions) {
    this.offs = [o.client.onDesktops(() => this.check()), o.client.conn.onState(() => this.check())];
    this.check();
  }

  get desktopId(): string {
    return this.o.desktopId;
  }

  status(): RuntimeStatus {
    return this.current;
  }

  listen(l: (e: TransportEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const live = this.live;
    if (!live?.isOpen) throw new NotConnectedError(NOT_CONNECTED);
    try {
      return await live.request(method, params as Record<string, JsonValue> | undefined);
    } catch (e) {
      throw appError(e);
    }
  }

  /** Seals the message for the desktop, which applies it once when it is back (§9.4). */
  async queueInstruction(i: QueuedInstruction): Promise<{ expires_at: number }> {
    const ttl = SEALED_EXPIRY_DEFAULT_MS.instruction;
    const at = this.now();
    await this.o.client.sendInstruction(this.o.desktopId, { text: i.text, thread_id: i.thread_id as ThreadId, client_msg_id: i.client_msg_id as ClientMsgId }, ttl);
    return { expires_at: at + ttl };
  }

  /** Try again now: after a refused hello, or when the user asks. */
  retry(): void {
    this.refused = false;
    this.failures = 0;
    this.clearTimer();
    if (this.current.state === "blocked") this.setStatus({ state: "starting" });
    this.check();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.offs) off();
    this.clearTimer();
    this.drop();
  }

  // ---------------------------------------------------------------- the state machine

  /** What to do now, from the relay connection and the desktop's presence. */
  private check(): void {
    if (this.closed) return;
    const conn = this.o.client.connectionState;
    const d = this.o.client.desktops().find((x) => x.device_id === this.o.desktopId);
    if (conn === "removed" || !d) return this.block("unlinked", "This device is no longer linked to that computer. Link it again from Homerun there.");
    if (conn === "replaced") return this.block("other_runtime", "Homerun is open in another tab or window.");
    if (this.refused) return;
    if (conn === "ready" && !d.online) {
      // The relay says it's gone: any session with it is dead, and there is nothing to retry
      // until the relay says it is back.
      this.drop();
      this.clearTimer();
      this.failures = 0;
      if (!this.opening) this.setStatus({ state: "offline", reason: "desktop", last_seen_at: d.last_seen_at });
      return;
    }
    if (this.live || this.opening) return;
    if (conn !== "ready") return this.setStatus({ state: "offline", reason: "relay", last_seen_at: d.last_seen_at });
    if (this.timer) return;
    void this.open();
  }

  private async open(): Promise<void> {
    this.opening = true;
    if (this.current.state !== "offline") this.setStatus({ state: "starting" });
    let live: RemoteLive;
    try {
      live = await this.o.client.openLive(this.o.desktopId, this.o.openTimeoutMs);
    } catch {
      this.opening = false;
      return this.failed();
    }
    let hello: HelloResult;
    try {
      const r = HelloResult.safeParse(
        await live.request("hello", {
          protocol: { min: 1, max: PROTOCOL_VERSION },
          role: this.o.client.role(this.o.desktopId) ?? "web",
          auth: { kind: "paired_device", device_id: this.o.client.deviceId },
          client: { ...this.o.clientInfo },
          capabilities: [],
        }),
      );
      if (!r.success) throw new RpcCallError({ code: RPC_ERROR.INCOMPATIBLE_PROTOCOL, message: "The computer's answer doesn't match this version of Homerun." });
      hello = r.data;
    } catch (e) {
      live.close();
      this.opening = false;
      if (e instanceof RpcCallError) {
        this.refused = true;
        return this.block(e.code === RPC_ERROR.INCOMPATIBLE_PROTOCOL ? "incompatible" : "failed", refusedText(e));
      }
      return this.failed();
    }
    this.opening = false;
    if (this.closed || this.current.state === "blocked") return live.close();
    this.live = live;
    this.failures = 0;
    live.onMessage((m) => {
      if (this.live !== live || !("method" in m) || ("id" in m && m.id !== undefined)) return;
      for (const l of [...this.listeners]) l({ type: "notification", method: m.method, params: m.params });
    });
    void live.closed.then(() => {
      if (this.live !== live) return;
      this.live = null;
      if (this.closed) return;
      // Dropped by the desktop or the network: back to waiting, and try again shortly.
      this.setStatus({ state: "starting" });
      this.schedule();
      this.check();
    });
    this.setStatus({ state: "ready", connection: ++this.connection, device_id: this.o.client.deviceId, runtime_version: hello.runtime_version, protocol: hello.protocol });
  }

  /** Online by the relay's account, yet no session: try again with backoff. */
  private failed(): void {
    if (this.closed) return;
    const d = this.o.client.desktops().find((x) => x.device_id === this.o.desktopId);
    this.setStatus({ state: "offline", reason: this.o.client.connectionState === "ready" ? "desktop" : "relay", last_seen_at: d?.last_seen_at ?? null });
    this.schedule();
  }

  private schedule(): void {
    const r = this.o.retry ?? DEFAULT_RETRY;
    const ms = Math.min(r.maxMs, r.initialMs * 2 ** this.failures++);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, ms);
  }

  private block(reason: BlockedReason, message: string): void {
    this.clearTimer();
    this.drop();
    this.setStatus({ state: "blocked", reason, message });
  }

  private drop(): void {
    const live = this.live;
    this.live = null;
    live?.close();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setStatus(s: RuntimeStatus): void {
    if (JSON.stringify(s) === JSON.stringify(this.current)) return;
    this.current = s;
    for (const l of [...this.listeners]) l({ type: "status", status: s });
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }
}

/**
 * One transport per paired desktop, for a client that shows several (§9.8): each keeps its own
 * live session and status.
 */
export class RemoteSessions {
  private transports = new Map<string, RelayTransport>();

  constructor(private readonly o: Omit<RelayTransportOptions, "desktopId">) {}

  transport(desktopId: string): RelayTransport {
    let t = this.transports.get(desktopId);
    if (!t) this.transports.set(desktopId, (t = new RelayTransport({ ...this.o, desktopId })));
    return t;
  }

  release(desktopId: string): void {
    this.transports.get(desktopId)?.close();
    this.transports.delete(desktopId);
  }

  closeAll(): void {
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
  }
}

const NOT_CONNECTED = "Your computer isn't reachable right now.";

function appError(e: unknown): unknown {
  if (e instanceof RpcCallError) return new AppRpcCallError(e.code, e.message, e.error.data);
  if (e instanceof LiveClosedError) return new NotConnectedError(NOT_CONNECTED);
  return e;
}

function refusedText(e: RpcCallError): string {
  if (e.code === RPC_ERROR.INCOMPATIBLE_PROTOCOL) return "This version of Homerun can't talk to the one on your computer. Update the older one.";
  return `Your computer refused this device: ${e.message}`;
}
