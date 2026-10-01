import { DurableObject } from "cloudflare:workers";
import { type AppAttestPolicy, fromB64url, productionAppAttestPolicy, RELAY_PATHS, WS_SUBPROTOCOL } from "@homerun/protocol";
import { ApnsClient, type PushSender } from "./apns";
import { AuthError, bearerToken, TokenVerifier } from "./auth";
import { DEFAULT_LIMITS } from "./config";
import { AccountRelay, errorResponse, type RelaySocket, type SocketState } from "./core/account";
import { checkOrigin, parseWebOrigins, preflight, withCors } from "./core/cors";
import { providerAdminFrom, type ProviderAdminConfig } from "./core/provider-admin";
import { dropAll, type Sql, type SqlValue } from "./core/sql";

/**
 * The relay on Cloudflare (§9.4): the Worker checks the access token at the edge and hands the
 * request to the account's Durable Object (one per `sub`), which keeps the account's SQLite
 * tables and its devices' WebSockets through the hibernation API, so idle connections cost
 * nothing. Configuration is in wrangler.jsonc (vars) and `wrangler secret put` (the APNs key).
 */

export interface Env extends ProviderAdminConfig {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  OIDC_ISSUER: string;
  OIDC_AUDIENCE?: string;
  OIDC_CLIENT_ID?: string;
  /** The web client's origins, comma-separated and exact (§9.9). Other pages can't call the relay. */
  WEB_ORIGINS?: string;
  /** Secrets: the contents of AuthKey_<id>.p8, its key id and the team id. */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** Tests only: send pushes to a mock instead of Apple. */
  APNS_ENDPOINT?: string;
  /** "1": accept development-signed iPhone builds' App Attest (`appattestdevelop`). */
  APP_ATTEST_ALLOW_DEVELOP?: string;
  /**
   * Tests only: a root (DER, base64url) trusted instead of Apple's for App Attest. It only
   * decides pushes and lock-screen answers here; desktops verify attestations themselves (§13).
   */
  APP_ATTEST_TEST_ROOT?: string;
  // PROVIDER_ADMIN ("workos" or "none"), the secret WORKOS_API_KEY and, for tests, WORKOS_API_BASE:
  // who deletes the user at the identity provider when the account is deleted (§10.9).
}

let cachedOrigins: { raw: string; list: string[] } | null = null;
function webOrigins(env: Env): string[] {
  const raw = env.WEB_ORIGINS ?? "";
  if (cachedOrigins?.raw !== raw) cachedOrigins = { raw, list: parseWebOrigins(raw) };
  return cachedOrigins.list;
}

function appAttest(env: Env): AppAttestPolicy {
  const policy = productionAppAttestPolicy(env.APP_ATTEST_ALLOW_DEVELOP === "1");
  return env.APP_ATTEST_TEST_ROOT ? { ...policy, roots: [fromB64url(env.APP_ATTEST_TEST_ROOT)] } : policy;
}

const SUB_HEADER = "x-homerun-sub";
const EXP_HEADER = "x-homerun-exp";
const IAT_HEADER = "x-homerun-iat";

let cached: { key: string; verifier: TokenVerifier } | null = null;
function verifier(env: Env): TokenVerifier {
  const key = `${env.OIDC_ISSUER}\n${env.OIDC_AUDIENCE ?? ""}\n${env.OIDC_CLIENT_ID ?? ""}`;
  if (cached?.key !== key) {
    cached = {
      key,
      verifier: new TokenVerifier({
        issuer: env.OIDC_ISSUER,
        ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}),
        ...(env.OIDC_CLIENT_ID ? { clientId: env.OIDC_CLIENT_ID } : {}),
      }),
    };
  }
  return cached.verifier;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    let origins: string[];
    try {
      origins = webOrigins(env);
      providerAdminFrom(env);
    } catch {
      return errorResponse("internal", "the relay is not configured");
    }
    const origin = checkOrigin(req, origins);
    if (!origin.ok) return errorResponse("forbidden", "this origin may not call the relay");
    if (req.method === "OPTIONS") return origin.origin ? preflight(origin.origin) : errorResponse("not_found", "no such endpoint");
    if (url.pathname === RELAY_PATHS.health) return withCors(Response.json({ ok: true }), origin.origin);
    if (!env.OIDC_ISSUER) return errorResponse("internal", "the relay is not configured");
    const token = bearerToken(req);
    if (!token) return withCors(errorResponse("unauthenticated", "no access token"), origin.origin);
    let auth;
    try {
      auth = await verifier(env).verify(token);
    } catch (e) {
      return withCors(e instanceof AuthError ? errorResponse(e.code, e.message) : errorResponse("internal", "token check failed"), origin.origin);
    }
    const headers = new Headers(req.headers);
    headers.set(SUB_HEADER, auth.sub);
    headers.set(EXP_HEADER, String(auth.exp));
    headers.set(IAT_HEADER, String(auth.iat));
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(auth.sub));
    return withCors(await stub.fetch(new Request(req, { headers })), origin.origin);
  },
} satisfies ExportedHandler<Env>;

export class AccountDurableObject extends DurableObject<Env> {
  private readonly relay: AccountRelay;
  private readonly wrappers = new WeakMap<WebSocket, RelaySocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = doSql(ctx.storage);
    this.relay = new AccountRelay({
      sql,
      sockets: () => ctx.getWebSockets().map((ws) => this.wrap(ws)),
      setAlarm: (at) => void (at === null ? ctx.storage.deleteAlarm() : ctx.storage.setAlarm(at)),
      now: Date.now,
      verifyToken: (t) => verifier(env).verify(t),
      push: apns(env),
      limits: DEFAULT_LIMITS,
      appAttest: appAttest(env),
      providerAdmin: providerAdminFrom(env),
      wipe: () => dropAll(sql),
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });
  }

  override async fetch(req: Request): Promise<Response> {
    // Only the Worker reaches this object, and it always sets these.
    const sub = req.headers.get(SUB_HEADER);
    const exp = Number(req.headers.get(EXP_HEADER));
    const iat = Number(req.headers.get(IAT_HEADER));
    if (!sub || !Number.isFinite(exp) || !Number.isFinite(iat)) return errorResponse("unauthenticated", "no account");
    const auth = { sub, exp, iat };
    const url = new URL(req.url);
    if (url.pathname === RELAY_PATHS.connect) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse("invalid", "expected a WebSocket upgrade");
      const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      this.relay.open(this.wrap(server), auth);
      return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": WS_SUBPROTOCOL } });
    }
    return this.relay.http(req, auth);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return ws.close(4400, "text frames only");
    await this.relay.message(this.wrap(ws), message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.relay.closed(this.wrap(ws));
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.relay.closed(this.wrap(ws));
  }

  override async alarm(): Promise<void> {
    await this.relay.alarm();
  }

  private wrap(ws: WebSocket): RelaySocket {
    let w = this.wrappers.get(ws);
    if (!w) {
      w = {
        send: (t) => {
          try {
            ws.send(t);
          } catch {
            // closing
          }
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // already closed
          }
        },
        state: () => (ws.deserializeAttachment() as SocketState | null) ?? null,
        setState: (s) => ws.serializeAttachment(s),
      };
      this.wrappers.set(ws, w);
    }
    return w;
  }
}

function doSql(storage: DurableObjectStorage): Sql {
  return {
    all: <T>(q: string, ...p: SqlValue[]) => storage.sql.exec(q, ...p).toArray() as T[],
    run: (q, ...p) => void storage.sql.exec(q, ...p),
    tx: (f) => storage.transactionSync(f),
  };
}

function apns(env: Env): PushSender | null {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) return null;
  return new ApnsClient({
    keyP8: env.APNS_KEY_P8,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
    ...(env.APNS_ENDPOINT ? { endpoint: env.APNS_ENDPOINT } : {}),
  });
}
