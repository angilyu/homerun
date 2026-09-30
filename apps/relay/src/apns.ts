import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import type { ApnsPayload } from "@homerun/protocol";

/**
 * Sends pushes to Apple (§9.7) with token-based authentication: an ES256 provider JWT from the
 * `.p8` key, reused for 30 minutes (Apple wants 20–60) and re-minted once if Apple calls it
 * expired. Only `fetch` and WebCrypto, so it runs in the Worker. APNs accepts only HTTP/2; a
 * Worker's `fetch` negotiates it with Apple in practice, but Cloudflare doesn't document that, so
 * real delivery is checked in milestone 10 (§18 row 78). The relay never sees what a push says:
 * the payload carries the sealed envelope.
 */

export interface ApnsConfig {
  /** Contents of AuthKey_<id>.p8 (PKCS #8 PEM). */
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
  /** Overrides both Apple hosts (the mock APNs in tests). */
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export type ApnsEnvironment = "sandbox" | "production";

export type ApnsResult =
  | { ok: true; apnsId: string | null }
  | { ok: false; status: number; reason: string; unregistered: boolean };

export interface PushSender {
  send(deviceToken: string, environment: ApnsEnvironment, payload: ApnsPayload): Promise<ApnsResult>;
}

const HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
const TOKEN_REUSE_MS = 30 * 60 * 1000;

export class ApnsClient implements PushSender {
  private key: CryptoKey | null = null;
  private jwt: { token: string; at: number } | null = null;

  constructor(private readonly cfg: ApnsConfig) {}

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  private async providerToken(fresh = false): Promise<string> {
    const now = this.now();
    if (!fresh && this.jwt && now - this.jwt.at < TOKEN_REUSE_MS) return this.jwt.token;
    this.key ??= await importPKCS8(this.cfg.keyP8, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.cfg.keyId })
      .setIssuer(this.cfg.teamId)
      .setIssuedAt(Math.floor(now / 1000))
      .sign(this.key);
    this.jwt = { token, at: now };
    return token;
  }

  async send(deviceToken: string, environment: ApnsEnvironment, payload: ApnsPayload): Promise<ApnsResult> {
    let r = await this.post(deviceToken, environment, payload, false);
    if (!r.ok && r.status === 403 && r.reason === "ExpiredProviderToken") r = await this.post(deviceToken, environment, payload, true);
    return r;
  }

  private async post(deviceToken: string, environment: ApnsEnvironment, payload: ApnsPayload, fresh: boolean): Promise<ApnsResult> {
    const f = this.cfg.fetch ?? fetch;
    const base = this.cfg.endpoint ?? HOSTS[environment];
    let res: Response;
    try {
      res = await f(`${base}/3/device/${deviceToken}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${await this.providerToken(fresh)}`,
          "apns-topic": this.cfg.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(payload.expiration),
          "content-type": "application/json",
        },
        body: payload.body,
      });
    } catch (e) {
      return { ok: false, status: 0, reason: e instanceof Error ? e.message : "network error", unregistered: false };
    }
    if (res.status === 200) {
      await res.body?.cancel();
      return { ok: true, apnsId: res.headers.get("apns-id") };
    }
    let reason = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { reason?: unknown };
      if (typeof j.reason === "string") reason = j.reason;
    } catch {
      // keep the status
    }
    const unregistered = res.status === 410 || (res.status === 400 && (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic"));
    return { ok: false, status: res.status, reason, unregistered };
  }
}
