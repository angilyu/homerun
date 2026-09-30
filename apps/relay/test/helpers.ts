import type { DeviceId } from "@homerun/core";
import {
  type ClientFrame,
  type DeviceIdentity,
  type DeviceKind,
  generateDeviceKeys,
  identityFromStored,
  newMsgId,
  publicOf,
  RELAY_PATHS,
  seal,
  type SealedEnvelope,
  type ServerFrame,
  signChallenge,
  signLinkStatement,
  signRequest,
  toB64url,
  utf8,
  WS_BEARER_PREFIX,
  WS_SUBPROTOCOL,
} from "@homerun/protocol";

/** Helpers shared by the relay's suites on Bun and on workerd. The relay is a black box here. */

export interface Target {
  url: string;
  wsUrl: string;
  now: () => number;
}

export const b64 = (n = 32) => toB64url(crypto.getRandomValues(new Uint8Array(n)));
export const sessionId = () => b64(16);

export class TestDevice {
  readonly id: DeviceIdentity;
  constructor(
    readonly kind: DeviceKind,
    readonly name = `${kind} ${Math.random().toString(36).slice(2, 6)}`,
  ) {
    this.id = identityFromStored(crypto.randomUUID() as DeviceId, kind, generateDeviceKeys());
  }
  get deviceId(): DeviceId {
    return this.id.deviceId;
  }
  get pub() {
    return publicOf(this.id);
  }

  async req(t: Target, token: string, method: string, path: string, body?: unknown, o: { ts?: number; sign?: boolean } = {}): Promise<Response> {
    const bytes = body === undefined ? new Uint8Array() : utf8(JSON.stringify(body));
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (o.sign !== false) headers["homerun-device"] = await signRequest(this.id.signing, this.deviceId, o.ts ?? t.now(), method, path, bytes);
    return fetch(t.url + path, { method, headers, ...(body !== undefined ? { body: bytes as Uint8Array<ArrayBuffer> } : {}) });
  }

  register(t: Target, token: string): Promise<Response> {
    return this.req(t, token, "POST", RELAY_PATHS.devices, { device: this.pub, name: this.name });
  }

  async connect(t: Target, token: string, o: { browser?: boolean; auth?: boolean } = {}): Promise<Conn> {
    const c = await Conn.open(t.wsUrl, token, o.browser ?? false);
    if (o.auth === false) return c;
    const ch = await c.next("challenge");
    c.send({ type: "auth", device_id: this.deviceId, signature: await signChallenge(this.id.signing, ch.nonce, this.deviceId) });
    await c.next("ready");
    return c;
  }

  seal(to: TestDevice, body: Record<string, unknown>, o: { now: number; ttl: number; msgId?: string }): Promise<SealedEnvelope> {
    return seal({
      inner: { v: 1, msg_id: o.msgId ?? newMsgId(), sender_device_id: this.deviceId, created_at: o.now, expires_at: o.now + o.ttl, body } as never,
      to: to.deviceId,
      sender: this.id.noise,
      recipientStatic: to.id.noise.publicKey,
    });
  }
}

export function instruction(text = "run the tests") {
  return { type: "instruction", thread_id: null, client_msg_id: crypto.randomUUID(), text };
}
export function pushBody(body = "Needs your answer") {
  return { type: "push", category: "input_request", title: "Homerun", body, request_id: crypto.randomUUID() };
}

/** The statement a desktop signs to link `device` (what pairing or linking produces). */
export function statement(desktop: TestDevice, device: TestDevice, account: string, now: number) {
  return signLinkStatement(
    {
      v: 1,
      account,
      desktop_device_id: desktop.deviceId,
      device_id: device.deviceId,
      desktop_static_public_key: desktop.pub.static_public_key,
      device_static_public_key: device.pub.static_public_key,
      device_signing_public_key: device.pub.signing_public_key,
      platform: device.kind as "ios" | "web",
      method: "qr",
      created_at: now,
    },
    desktop.id.signing,
  );
}

type Of<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

export class Conn {
  readonly frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  protocol = "";

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
    ws.addEventListener("message", (e) => {
      const f = JSON.parse(String(e.data)) as ServerFrame;
      const w = this.waiters.find((x) => x.pred(f));
      if (w) {
        this.waiters = this.waiters.filter((x) => x !== w);
        w.resolve(f);
      } else this.frames.push(f);
    });
  }

  static open(url: string, token: string, browser: boolean): Promise<Conn> {
    const ws = browser
      ? new WebSocket(url, [WS_SUBPROTOCOL, WS_BEARER_PREFIX + token])
      : new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, protocols: [WS_SUBPROTOCOL] } as never);
    const c = new Conn(ws);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => {
        c.protocol = ws.protocol;
        resolve(c);
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
      void c.closed.then((e) => reject(new Error(`closed before open: ${e.code}`)));
    });
  }

  send(f: ClientFrame | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(f));
  }

  /** The first frame (already received or future) of this type that matches. */
  next<T extends ServerFrame["type"]>(type: T, pred: (f: Of<T>) => boolean = () => true, timeoutMs = 4000): Promise<Of<T>> {
    const match = (f: ServerFrame) => f.type === type && pred(f as Of<T>);
    const i = this.frames.findIndex(match);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0] as Of<T>);
    return new Promise((resolve, reject) => {
      const w = { pred: match, resolve: (f: ServerFrame) => (clearTimeout(t), resolve(f as Of<T>)) };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`no ${type} frame; got ${JSON.stringify(this.frames.map((f) => f.type))}`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Resolves true if nothing of this type arrives within `ms`. */
  async quiet(type: ServerFrame["type"], ms = 150): Promise<boolean> {
    return this.next(type, () => true, ms).then(
      () => false,
      () => true,
    );
  }

  close(): void {
    this.ws.close(1000);
  }
}
