import { DurableObject } from "cloudflare:workers";
import { RELAY_PATHS, WS_SUBPROTOCOL } from "@homerun/protocol";
import { ApnsClient, type PushSender } from "./apns";
import { AuthError, bearerToken, TokenVerifier } from "./auth";
import { DEFAULT_LIMITS } from "./config";
import { AccountRelay, errorResponse, type RelaySocket, type SocketState } from "./core/account";
import { dropAll, type Sql, type SqlValue } from "./core/sql";

/**
 * The relay on Cloudflare (§9.4): the Worker checks the access token at the edge and hands the
 * request to the account's Durable Object (one per `sub`), which keeps the account's SQLite
 * tables and its devices' WebSockets through the hibernation API, so idle connections cost
 * nothing. Configuration is in wrangler.jsonc (vars) and `wrangler secret put` (the APNs key).
 */

export interface Env {
  ACCOUNTS: DurableObjectNamespace<AccountDurableObject>;
  OIDC_ISSUER: string;
  OIDC_AUDIENCE?: string;
  OIDC_CLIENT_ID?: string;
  /** Secrets: the contents of AuthKey_<id>.p8, its key id and the team id. */
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  /** Tests only: send pushes to a mock instead of Apple. */
  APNS_ENDPOINT?: string;
}

const SUB_HEADER = "x-homerun-sub";
const EXP_HEADER = "x-homerun-exp";

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
    if (url.pathname === RELAY_PATHS.health) return Response.json({ ok: true });
    if (!env.OIDC_ISSUER) return errorResponse("internal", "the relay is not configured");
    const token = bearerToken(req);
    if (!token) return errorResponse("unauthenticated", "no access token");
    let auth;
    try {
      auth = await verifier(env).verify(token);
    } catch (e) {
      return e instanceof AuthError ? errorResponse(e.code, e.message) : errorResponse("internal", "token check failed");
    }
    const headers = new Headers(req.headers);
    headers.set(SUB_HEADER, auth.sub);
    headers.set(EXP_HEADER, String(auth.exp));
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(auth.sub));
    return stub.fetch(new Request(req, { headers }));
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
      wipe: () => dropAll(sql),
      log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
    });
  }

  override async fetch(req: Request): Promise<Response> {
    // Only the Worker reaches this object, and it always sets these.
    const sub = req.headers.get(SUB_HEADER);
    const exp = Number(req.headers.get(EXP_HEADER));
    if (!sub || !Number.isFinite(exp)) return errorResponse("unauthenticated", "no account");
    const auth = { sub, exp };
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
