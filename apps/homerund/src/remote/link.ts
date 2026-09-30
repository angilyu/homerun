import type { RelayLinkState } from "@homerun/core";
import { CLOSE, type ClientFrame, type DeviceIdentity, publicOf, RELAY_PATHS, type ServerFrame } from "@homerun/protocol";
import { type Fetch, RelayConnection, RelayError } from "@homerun/remote";
import { log } from "../log";

/**
 * The desktop's outbound link to the relay (§9.2, §9.4), kept up for as long as the account is
 * signed in: register the device, open the WebSocket, and when it drops, reconnect with
 * exponential backoff and jitter (1 s to 60 s). A wake from sleep retries at once, and checks a
 * link that looks up is really up. The relay saying the token expired refreshes it first.
 */

export const LINK_BACKOFF = { initialMs: 1000, maxMs: 60_000 };
/** After a wake, how long a ping may take before the link is presumed dead. */
export const WAKE_PING_MS = 5000;

type Ready = Extract<ServerFrame, { type: "ready" }>;

export interface RelayLinkDeps {
  url: string;
  /** The device's identity, created on first use. */
  identity: () => DeviceIdentity;
  /** Shown on other devices and the account's device list. */
  name: string;
  token: () => Promise<string>;
  freshToken: () => Promise<string>;
  onFrame: (f: ServerFrame) => void;
  onReady: (f: Ready) => void;
  /** The link went down (or stopped): live sessions over it are gone. */
  onDown: () => void;
  /** The relay no longer knows this device (the account was deleted elsewhere): start afresh. */
  onRemoved: () => void;
  onChange: () => void;
  /** Whether a failure getting a token means the account is signed out (stop, don't retry). */
  signedOut: (e: unknown) => boolean;
  now: () => number;
  fetch?: Fetch;
  backoff?: { initialMs: number; maxMs: number };
  wakePingMs?: number;
}

export class RelayLink {
  state: RelayLinkState = "off";
  since: number | null = null;
  error: string | null = null;
  private conn: RelayConnection | null = null;
  private running = false;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private registered = new Set<string>();
  /** Why the last token request failed: the connection only reports that it closed. */
  private tokenError: unknown = null;

  constructor(private d: RelayLinkDeps) {}

  get connected(): boolean {
    return this.state === "connected";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempts = 0;
    this.error = null;
    void this.attempt();
  }

  stop(): void {
    if (!this.running && this.state === "off") return;
    this.running = false;
    this.clearTimer();
    const c = this.conn;
    this.conn = null;
    c?.close();
    this.error = null;
    this.set("off");
    this.d.onDown();
  }

  /** The machine woke: retry now, or check that a link that looks up still is. */
  wake(): void {
    if (!this.running) return;
    if (this.timer) {
      this.clearTimer();
      this.attempts = 0;
      void this.attempt();
      return;
    }
    const c = this.conn;
    if (!c || this.state !== "connected") return;
    const pong = c.waitFor("pong", () => true, this.d.wakePingMs ?? WAKE_PING_MS);
    if (!c.send({ type: "ping" })) return;
    pong.catch(() => {
      if (this.conn !== c) return;
      log.info("relay link didn't answer after wake; reconnecting");
      this.dropped(c, "closed");
    });
  }

  send(f: ClientFrame): boolean {
    return this.state === "connected" && (this.conn?.send(f) ?? false);
  }

  /** A signed HTTPS call to the relay; works whether or not the WebSocket is up. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const c = this.conn ?? this.connection(this.d.identity());
    return c.call<T>(method, path, body);
  }

  private connection(identity: DeviceIdentity): RelayConnection {
    return new RelayConnection({
      url: this.d.url,
      identity,
      token: () => this.watch(this.d.token()),
      freshToken: () => this.watch(this.d.freshToken()),
      reconnect: false,
      now: this.d.now,
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
    });
  }

  private watch(p: Promise<string>): Promise<string> {
    return p.then(
      (t) => ((this.tokenError = null), t),
      (e) => {
        this.tokenError = e;
        throw e;
      },
    );
  }

  private async attempt(): Promise<void> {
    if (!this.running) return;
    this.tokenError = null;
    this.set("connecting");
    let identity: DeviceIdentity;
    try {
      identity = this.d.identity();
    } catch (e) {
      return this.failed(null, e);
    }
    const c = this.connection(identity);
    this.conn = c;
    c.onFrame((f) => {
      if (this.conn !== c) return;
      if (f.type === "ready") {
        this.attempts = 0;
        this.error = null;
        this.set("connected");
        this.d.onReady(f);
      }
      this.d.onFrame(f);
    });
    c.onState((s, code) => {
      if (this.conn !== c || s === "connecting" || s === "ready" || s === "idle") return;
      this.dropped(c, s, code);
    });
    try {
      if (!this.registered.has(identity.deviceId)) {
        await c.call("POST", RELAY_PATHS.devices, { device: publicOf(identity), name: this.d.name });
        this.registered.add(identity.deviceId);
      }
      if (this.conn !== c) return;
      await c.connect();
    } catch (e) {
      if (this.conn !== c) return;
      this.failed(c, e);
    }
  }

  /** The WebSocket closed. */
  private dropped(c: RelayConnection, s: string, code?: number): void {
    if (this.conn !== c) return;
    this.conn = null;
    c.close();
    this.d.onDown();
    if (!this.running) return;
    if (this.tokenError) {
      const e = this.tokenError;
      this.tokenError = null;
      return this.failed(null, e);
    }
    if (s === "removed" || code === CLOSE.DEVICE_REMOVED) {
      log.info("the relay removed this desktop; registering afresh");
      this.registered.clear();
      this.d.onRemoved();
      return this.retry(0);
    }
    if (s === "replaced") {
      // Another connection with this desktop's key took over. Not retried until the next wake
      // or start, so two copies don't take turns forever.
      this.error = "Another copy of Homerun took over this desktop's relay link.";
      this.running = false;
      return this.set("offline");
    }
    if (code === CLOSE.TOKEN_EXPIRED) {
      void this.d.freshToken().then(
        () => this.retry(0),
        (e) => this.failed(null, e),
      );
      return this.set("connecting");
    }
    if (code === CLOSE.DEVICE_PROOF_INVALID) this.registered.clear();
    this.error ??= "Lost the connection to the relay.";
    this.retry();
  }

  private failed(c: RelayConnection | null, e: unknown): void {
    if (c && this.conn === c) {
      this.conn = null;
      c.close();
      this.d.onDown();
    }
    if (!this.running) return;
    if (this.d.signedOut(e)) {
      this.running = false;
      this.error = null;
      return this.set("off");
    }
    if (e instanceof RelayError && e.code === "device_key_mismatch") {
      this.registered.clear();
      this.d.onRemoved();
      return this.retry();
    }
    this.error = describe(e);
    log.info("relay link failed", { error: this.error });
    this.retry();
  }

  private retry(delayMs?: number): void {
    if (!this.running) return;
    this.clearTimer();
    const b = this.d.backoff ?? LINK_BACKOFF;
    const base = Math.min(b.maxMs, b.initialMs * 2 ** this.attempts++);
    const delay = delayMs ?? Math.min(b.maxMs, base * (0.75 + Math.random() * 0.5));
    if (delay > 0 || this.state !== "connecting") this.set("offline");
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.attempt();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private set(s: RelayLinkState): void {
    if (this.state === s) return;
    this.state = s;
    this.since = s === "off" ? null : this.d.now();
    this.d.onChange();
  }
}

function describe(e: unknown): string {
  if (e instanceof RelayError) {
    if (e.code === "too_many_devices") return "This account has too many devices. Unpair one on another device, then try again.";
    if (e.code === "rate_limited") return "The relay is limiting this account for a while.";
    if (e.code === "unauthenticated" || e.code === "token_expired") return "The relay didn't accept this sign-in.";
    if (e.code === "closed" || e.code === "timeout") return "Lost the connection to the relay.";
    return `The relay refused the connection: ${e.message}`.slice(0, 500);
  }
  if (e instanceof TypeError) return "Couldn't reach the relay. Check your connection.";
  return `Couldn't connect to the relay: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
}
