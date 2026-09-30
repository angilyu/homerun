import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from "jose";
import { json, serve, type RunningServer } from "./http";

/**
 * A mock of Apple's APNs provider API (`POST /3/device/<token>`), enough to test the relay's sender:
 * it checks the ES256 provider token (kid, iss, age), the topic and push type, and the 4 KB payload
 * limit, and answers with APNs's status codes and reasons. Responses can be scripted per device
 * token. Plain HTTP/1.1 on 127.0.0.1: real HTTP/2 to Apple is a manual check (M10).
 */

export const APNS_MAX_PAYLOAD = 4096;
/** Apple rejects provider tokens older than an hour. */
const TOKEN_MAX_AGE_SEC = 60 * 60;

export interface ApnsDelivery {
  token: string;
  topic: string;
  pushType: string;
  priority: string | null;
  expiration: string | null;
  collapseId: string | null;
  apnsId: string;
  /** The provider token, so tests can check it is reused rather than minted per push. */
  providerToken: string;
  body: string;
  payload: { aps: Record<string, unknown>; [k: string]: unknown };
}

export interface ScriptedResponse {
  status: number;
  reason: string;
}

export interface ApnsMockOptions {
  teamId?: string;
  keyId?: string;
  topic?: string;
  port?: number;
}

export class ApnsMock {
  readonly teamId: string;
  readonly keyId: string;
  readonly topic: string;
  /** The provider key as the relay receives it: the contents of an AuthKey_<id>.p8 file. */
  p8 = "";
  readonly deliveries: ApnsDelivery[] = [];
  readonly rejected: { token: string; status: number; reason: string }[] = [];

  private publicKey: CryptoKey | null = null;
  private scripts = new Map<string, ScriptedResponse[]>();
  private unregistered = new Map<string, number>();
  private waiters: { pred: (d: ApnsDelivery) => boolean; resolve: (d: ApnsDelivery) => void }[] = [];
  private server: RunningServer | null = null;

  private constructor(o: ApnsMockOptions) {
    this.teamId = o.teamId ?? "TEAMID1234";
    this.keyId = o.keyId ?? "KEYID56789";
    this.topic = o.topic ?? "com.angilyu.homerun.ios";
  }

  static async start(o: ApnsMockOptions = {}): Promise<ApnsMock> {
    const m = new ApnsMock(o);
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    m.publicKey = publicKey;
    m.p8 = await exportPKCS8(privateKey);
    m.server = await serve((r) => m.handle(r), o.port);
    return m;
  }

  get url(): string {
    if (!this.server) throw new Error("mock not started");
    return this.server.url;
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  /** The next `times` pushes to this token get this response instead of 200. */
  script(token: string, response: ScriptedResponse, times = 1): void {
    const list = this.scripts.get(token) ?? [];
    for (let i = 0; i < times; i++) list.push(response);
    this.scripts.set(token, list);
  }

  /** From now on this token is gone (the app was uninstalled): 410 Unregistered. */
  unregister(token: string): void {
    this.unregistered.set(token, Date.now());
  }

  /** Resolves with the first delivery (already received or future) that matches. */
  waitFor(pred: (d: ApnsDelivery) => boolean = () => true, timeoutMs = 5000): Promise<ApnsDelivery> {
    const found = this.deliveries.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (d: ApnsDelivery) => (clearTimeout(t), resolve(d)) };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error("no matching APNs delivery"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  private reject(token: string, status: number, reason: string, extra: Record<string, unknown> = {}): Response {
    this.rejected.push({ token, status, reason });
    return json({ reason, ...extra }, status, { "apns-id": crypto.randomUUID().toUpperCase() });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const m = /^\/3\/device\/([^/]+)$/.exec(url.pathname);
    if (!m) return json({ reason: "BadPath" }, 404);
    if (req.method !== "POST") return json({ reason: "MethodNotAllowed" }, 405);
    const token = m[1]!;
    const h = req.headers;

    const auth = h.get("authorization") ?? "";
    if (!auth.toLowerCase().startsWith("bearer ")) return this.reject(token, 403, "MissingProviderToken");
    const jwt = auth.slice(7);
    try {
      const header = decodeProtectedHeader(jwt);
      if (header.alg !== "ES256" || header.kid !== this.keyId) return this.reject(token, 403, "InvalidProviderToken");
      const { payload } = await jwtVerify(jwt, this.publicKey!, { issuer: this.teamId, algorithms: ["ES256"] });
      const iat = payload.iat ?? 0;
      const now = Math.floor(Date.now() / 1000);
      if (now - iat > TOKEN_MAX_AGE_SEC) return this.reject(token, 403, "ExpiredProviderToken");
      if (iat - now > 60) return this.reject(token, 403, "InvalidProviderToken");
    } catch {
      return this.reject(token, 403, "InvalidProviderToken");
    }

    const topic = h.get("apns-topic");
    if (!topic) return this.reject(token, 400, "MissingTopic");
    if (topic !== this.topic) return this.reject(token, 400, "TopicDisallowed");
    const pushType = h.get("apns-push-type") ?? "";
    if (!["alert", "background"].includes(pushType)) return this.reject(token, 400, "InvalidPushType");
    const priority = h.get("apns-priority");
    if (priority !== null && !["5", "10"].includes(priority)) return this.reject(token, 400, "BadPriority");
    const expiration = h.get("apns-expiration");
    if (expiration !== null && !/^\d+$/.test(expiration)) return this.reject(token, 400, "BadExpirationDate");
    if (!/^[0-9a-f]{64,200}$/.test(token)) return this.reject(token, 400, "BadDeviceToken");

    const body = await req.text();
    if (new TextEncoder().encode(body).length > APNS_MAX_PAYLOAD) return this.reject(token, 413, "PayloadTooLarge");
    let payload: ApnsDelivery["payload"];
    try {
      payload = JSON.parse(body);
      if (typeof payload?.aps !== "object" || payload.aps === null) throw new Error();
    } catch {
      return this.reject(token, 400, body.length === 0 ? "PayloadEmpty" : "BadPayload");
    }

    const gone = this.unregistered.get(token);
    if (gone !== undefined) return this.reject(token, 410, "Unregistered", { timestamp: gone });
    const scripted = this.scripts.get(token)?.shift();
    if (scripted) return this.reject(token, scripted.status, scripted.reason);

    const apnsId = h.get("apns-id") ?? crypto.randomUUID().toUpperCase();
    const d: ApnsDelivery = {
      token,
      topic,
      pushType,
      priority,
      expiration,
      collapseId: h.get("apns-collapse-id"),
      apnsId,
      providerToken: jwt,
      body,
      payload,
    };
    this.deliveries.push(d);
    for (const w of this.waiters.filter((x) => x.pred(d))) {
      this.waiters = this.waiters.filter((x) => x !== w);
      w.resolve(d);
    }
    return new Response(null, { status: 200, headers: { "apns-id": apnsId } });
  }
}

/** A random APNs device token (32 bytes, hex), as iOS hands one to the app. */
export function fakeDeviceToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
