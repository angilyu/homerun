import {
  CLOSE,
  type ClientFrame,
  DEVICE_PROOF_HEADER,
  type DeviceIdentity,
  RELAY_PATHS,
  RelayErrorBody,
  ServerFrame,
  signChallenge,
  signRequest,
  utf8,
  WS_BEARER_PREFIX,
  WS_SUBPROTOCOL,
} from "@homerun/protocol";

/**
 * One device's link to the relay (§9.2, §9.4): HTTPS requests signed with the device key, and a
 * WebSocket that answers the relay's challenge, re-authenticates before the access token
 * expires, and reconnects with backoff when dropped. Nothing here is end to end: it carries
 * Noise messages and sealed envelopes it can't read.
 */

export type ConnectionState = "idle" | "connecting" | "ready" | "closed" | "removed" | "replaced";
type ReadyFrame = Extract<ServerFrame, { type: "ready" }>;
type Of<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

/** `fetch`, or anything with its shape for these calls. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface RelayConnectionOptions {
  /** The relay's https base URL. */
  url: string;
  identity: DeviceIdentity;
  /** A valid access token. */
  token: () => Promise<string>;
  /** A new access token even if the current one looks valid (the relay said it expired). */
  freshToken: () => Promise<string>;
  /** Pass the token as a WebSocket subprotocol, as a browser must. */
  browser?: boolean;
  reconnect?: { initialMs: number; maxMs: number } | false;
  fetch?: Fetch;
  now?: () => number;
}

export class RelayError extends Error {
  override name = "RelayError";
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class RelayConnection {
  state: ConnectionState = "idle";
  /** The last `ready`: the relay's view of our links when we connected. */
  ready: ReadyFrame | null = null;
  private ws: WebSocket | null = null;
  private frameListeners = new Set<(f: ServerFrame) => void>();
  private stateListeners = new Set<(s: ConnectionState, code?: number) => void>();
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private wanted = false;
  private readyWaiters: { resolve: (f: ReadyFrame) => void; reject: (e: Error) => void }[] = [];

  constructor(private readonly o: RelayConnectionOptions) {}

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  // ---------------------------------------------------------------- HTTPS

  /** A signed request. A token the relay calls expired is refreshed and the request retried once. */
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const send = async (token: string) => {
      const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        [DEVICE_PROOF_HEADER]: signRequest(this.o.identity.signing, this.o.identity.deviceId, this.now(), method, path, bytes),
      };
      if (body !== undefined) headers["content-type"] = "application/json";
      return (this.o.fetch ?? fetch)(this.o.url + path, { method, headers, ...(body !== undefined ? { body: bytes as Uint8Array<ArrayBuffer> } : {}) });
    };
    let res = await send(await this.o.token());
    if (res.status === 401 && (await errorOf(res.clone())).code === "token_expired") res = await send(await this.o.freshToken());
    return res;
  }

  /** `request`, throwing a RelayError unless the status is 2xx; returns the JSON body if any. */
  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      const e = await errorOf(res);
      throw new RelayError(e.code, e.message, res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  // ---------------------------------------------------------------- WebSocket

  onFrame(fn: (f: ServerFrame) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  onState(fn: (s: ConnectionState, code?: number) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  /** The next frame of this type that matches. */
  waitFor<T extends ServerFrame["type"]>(type: T, pred: (f: Of<T>) => boolean = () => true, timeoutMs = 10_000): Promise<Of<T>> {
    return new Promise((resolve, reject) => {
      const off = this.onFrame((f) => {
        if (f.type === type && pred(f as Of<T>)) {
          off();
          clearTimeout(t);
          resolve(f as Of<T>);
        }
      });
      const t = setTimeout(() => {
        off();
        reject(new RelayError("timeout", `no ${type} from the relay`));
      }, timeoutMs);
    });
  }

  /** Connects (and keeps reconnecting until `close()`); resolves on the first `ready`. */
  connect(): Promise<ReadyFrame> {
    this.wanted = true;
    const p = new Promise<ReadyFrame>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    if (this.state !== "connecting" && this.state !== "ready") void this.open();
    else if (this.state === "ready" && this.ready) this.settleReady(this.ready);
    return p;
  }

  send(f: ClientFrame): boolean {
    if (this.state !== "ready" || !this.ws) return false;
    this.ws.send(JSON.stringify(f));
    return true;
  }

  close(): void {
    this.wanted = false;
    this.clearTimers();
    this.ws?.close(CLOSE.NORMAL, "bye");
    this.ws = null;
    this.setState("closed");
    this.failReady(new RelayError("closed", "connection closed"));
  }

  private async open(): Promise<void> {
    this.setState("connecting");
    let token: string;
    try {
      token = await this.o.token();
    } catch (e) {
      this.failReady(e instanceof Error ? e : new Error(String(e)));
      this.setState("closed");
      return;
    }
    if (!this.wanted) return;
    const wsUrl = this.o.url.replace(/^http/, "ws") + RELAY_PATHS.connect;
    // No permessage-deflate (Bun offers it by default): ciphertext doesn't compress, the reauth
    // frame's token shouldn't share a compression context, and Bun's client fails with 1002
    // "Invalid compressed data" on some of workerd's compressed frames.
    const ws = this.o.browser
      ? new WebSocket(wsUrl, [WS_SUBPROTOCOL, WS_BEARER_PREFIX + token])
      : new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` }, protocols: [WS_SUBPROTOCOL], perMessageDeflate: false } as never);
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      if (ws !== this.ws) return;
      let f: ServerFrame;
      try {
        f = ServerFrame.parse(JSON.parse(String(e.data)));
      } catch {
        return;
      }
      this.handle(ws, f);
    });
    ws.addEventListener("close", (e) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.onClosed(e.code);
    });
  }

  private handle(ws: WebSocket, f: ServerFrame): void {
    if (f.type === "challenge") {
      const id = this.o.identity;
      ws.send(JSON.stringify({ type: "auth", device_id: id.deviceId, signature: signChallenge(id.signing, f.nonce, id.deviceId) }));
      return;
    }
    if (f.type === "ready") {
      this.attempts = 0;
      this.ready = f;
      this.setState("ready");
      this.scheduleReauth(f.token_expires_at);
      this.settleReady(f);
    } else if (f.type === "reauthed") {
      this.scheduleReauth(f.token_expires_at);
    }
    for (const l of [...this.frameListeners]) l(f);
  }

  private onClosed(code: number): void {
    this.clearTimers();
    if (code === CLOSE.DEVICE_REMOVED) {
      this.wanted = false;
      this.setState("removed", code);
      this.failReady(new RelayError("device_removed", "this device was removed from the account"));
      return;
    }
    if (code === CLOSE.REPLACED) {
      this.wanted = false;
      this.setState("replaced", code);
      this.failReady(new RelayError("replaced", "another connection for this device took over"));
      return;
    }
    if (code === CLOSE.DEVICE_PROOF_INVALID) {
      this.wanted = false;
      this.setState("closed", code);
      this.failReady(new RelayError("device_proof_invalid", "the relay refused this device"));
      return;
    }
    this.setState("closed", code);
    const r = this.o.reconnect === undefined ? { initialMs: 500, maxMs: 30_000 } : this.o.reconnect;
    if (!this.wanted || r === false) {
      this.failReady(new RelayError("closed", `connection closed (${code})`));
      return;
    }
    const base = Math.min(r.maxMs, r.initialMs * 2 ** this.attempts++) * (code === CLOSE.RATE_LIMITED ? 4 : 1);
    const delay = Math.min(r.maxMs, base * (0.75 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.wanted) return;
      if (code === CLOSE.TOKEN_EXPIRED) void this.o.freshToken().then(() => this.open(), () => this.open());
      else void this.open();
    }, delay);
  }

  /** Sends `reauth` a little before the token expires. */
  private scheduleReauth(expiresAt: number): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    const left = expiresAt - this.now();
    const at = Math.max(1000, left - Math.min(120_000, left / 2));
    this.reauthTimer = setTimeout(() => {
      this.reauthTimer = null;
      void this.o.freshToken().then(
        (token) => this.send({ type: "reauth", token }),
        () => {},
      );
    }, at);
  }

  private clearTimers(): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reauthTimer = this.reconnectTimer = null;
  }

  private setState(s: ConnectionState, code?: number): void {
    this.state = s;
    for (const l of [...this.stateListeners]) l(s, code);
  }

  private settleReady(f: ReadyFrame): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const x of w) x.resolve(f);
  }

  private failReady(e: Error): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const x of w) x.reject(e);
  }
}

async function errorOf(res: Response): Promise<{ code: string; message: string }> {
  try {
    const b = RelayErrorBody.safeParse(await res.json());
    if (b.success) return { code: b.data.error, message: b.data.message };
  } catch {
    // not JSON
  }
  return { code: `http_${res.status}`, message: `HTTP ${res.status}` };
}
