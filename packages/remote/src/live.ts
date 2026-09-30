import type { JsonValue, RpcError, RpcMessage } from "@homerun/core";
import { type DeviceIdentity, fromB64url, LiveInitiator, type LiveSession, NoiseError, systemRandom, toB64url } from "@homerun/protocol";
import type { RelayConnection } from "./relay-connection";
import type { PairedDesktop } from "./store";

/**
 * A live session with a desktop (§9.3): Noise KK against the desktop's pinned static key, then
 * JSON-RPC in both directions, the same protocol as the local socket. The relay forwards frames
 * it can't read. What the desktop lets a remote do is its decision (§5.2, §13); a rejected call
 * comes back as an ordinary JSON-RPC error.
 */

export class LiveClosedError extends Error {
  override name = "LiveClosedError";
}

export class RpcCallError extends Error {
  override name = "RpcCallError";
  constructor(readonly error: RpcError) {
    super(error.message);
  }
  get code() {
    return this.error.code;
  }
}

export class RemoteLive {
  readonly sessionId: string;
  private session: LiveSession | null = null;
  private offs: (() => void)[] = [];
  private nextId = 1;
  private pending = new Map<string | number, { resolve: (v: JsonValue) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: RpcMessage) => void>();
  private closeReason: string | null = null;
  private resolveClosed!: (reason: string) => void;
  /** Resolves with why the session ended. */
  readonly closed = new Promise<string>((r) => (this.resolveClosed = r));

  constructor(
    private readonly conn: RelayConnection,
    private readonly me: DeviceIdentity,
    readonly desktop: PairedDesktop,
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? toB64url(systemRandom(16));
  }

  /** Runs the handshake. Rejects if the desktop is offline, doesn't answer, or isn't who we pinned. */
  async open(timeoutMs = 10_000): Promise<void> {
    const init = new LiveInitiator({
      initiatorId: this.me.deviceId,
      responderId: this.desktop.device_id,
      sessionId: this.sessionId,
      me: this.me.noise,
      peer: fromB64url(this.desktop.static_public_key),
    });
    const ours = (f: { from?: string; session?: string }) => f.from === this.desktop.device_id && f.session === this.sessionId;
    const reply = new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => done(new LiveClosedError("the desktop didn't answer")), timeoutMs);
      const done = (e: Error | null, data?: Uint8Array) => {
        clearTimeout(t);
        off();
        if (e) reject(e);
        else resolve(data!);
      };
      const off = this.conn.onFrame((f) => {
        if (f.type === "live" && ours(f)) done(null, fromB64url(f.data));
        else if (f.type === "live_close" && ours(f)) done(new LiveClosedError("the desktop is offline or refused the session"));
        else if (f.type === "error" && f.ref === this.sessionId) done(new LiveClosedError(`${f.code}: ${f.message}`));
      });
    });
    if (!this.conn.send({ type: "live", to: this.desktop.device_id, session: this.sessionId, data: toB64url(init.start()) })) {
      throw new LiveClosedError("not connected to the relay");
    }
    let m2: Uint8Array;
    try {
      m2 = await reply;
    } catch (e) {
      this.finish(e instanceof Error ? e.message : String(e));
      throw e;
    }
    this.session = init.finish(m2);
    this.offs.push(
      this.conn.onFrame((f) => {
        if (f.type === "live" && ours(f)) this.receive(f.data);
        else if (f.type === "live_close" && ours(f)) this.finish("closed by the desktop");
        else if (f.type === "error" && f.ref === this.sessionId) this.finish(`${f.code}: ${f.message}`);
      }),
      // Noise state doesn't survive a reconnect: a new connection needs a new session.
      this.conn.onState((s) => {
        if (s !== "ready") this.finish(`relay connection ${s}`);
      }),
    );
  }

  get isOpen(): boolean {
    return this.session !== null && this.closeReason === null;
  }

  /** Every message the desktop sends: responses too, and notifications (events). */
  onMessage(fn: (m: RpcMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(m: RpcMessage): void {
    if (!this.session || this.closeReason !== null) throw new LiveClosedError(this.closeReason ?? "not open");
    for (const frame of this.session.encrypt(m)) {
      if (!this.conn.send({ type: "live", to: this.desktop.device_id, session: this.sessionId, data: toB64url(frame) })) {
        this.finish("relay connection lost");
        throw new LiveClosedError("relay connection lost");
      }
    }
  }

  /** A JSON-RPC call over the session. */
  request(method: string, params?: Record<string, JsonValue>): Promise<JsonValue> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) } as RpcMessage);
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close(): void {
    if (this.closeReason !== null) return;
    this.conn.send({ type: "live_close", to: this.desktop.device_id, session: this.sessionId });
    this.finish("closed");
  }

  private receive(data: string): void {
    let m: RpcMessage | null;
    try {
      m = this.session!.decrypt(fromB64url(data));
    } catch (e) {
      // A frame that fails to decrypt ends the session: the transport keys are out of step.
      this.conn.send({ type: "live_close", to: this.desktop.device_id, session: this.sessionId });
      this.finish(e instanceof NoiseError ? `bad frame: ${e.message}` : "bad frame");
      return;
    }
    if (!m) return;
    if ("id" in m && m.id !== null && !("method" in m)) {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if ("error" in m) p.reject(new RpcCallError(m.error));
        else p.resolve(m.result);
      }
    }
    for (const l of [...this.listeners]) l(m);
  }

  private finish(reason: string): void {
    if (this.closeReason !== null) return;
    this.closeReason = reason;
    for (const off of this.offs) off();
    this.offs = [];
    for (const p of this.pending.values()) p.reject(new LiveClosedError(reason));
    this.pending.clear();
    this.resolveClosed(reason);
  }
}
