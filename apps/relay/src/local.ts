import { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AppAttestPolicy, productionAppAttestPolicy, RELAY_PATHS, WS_SUBPROTOCOL } from "@homerun/protocol";
import { ApnsClient, type ApnsConfig, type PushSender } from "./apns";
import { AuthError, bearerToken, TokenVerifier, type AuthConfig, type VerifiedToken } from "./auth";
import { DEFAULT_LIMITS, type RelayLimits } from "./config";
import { AccountRelay, errorResponse, type RelaySocket, type SocketState } from "./core/account";
import { checkOrigin, parseWebOrigins, preflight, withCors } from "./core/cors";
import { dropAll, type Sql, type SqlValue } from "./core/sql";

/**
 * The relay on Bun (§9.4): the same account core as the Durable Object, one `bun:sqlite`
 * database per account, for tests and local development. Not for production: there is no
 * hibernation, and one process holds every account.
 */

export interface LocalRelayOptions extends Omit<AuthConfig, "fetch"> {
  /** A mock APNs, a real `.p8` configuration, or a sender of your own. */
  apns?: ApnsConfig | PushSender | null;
  limits?: Partial<RelayLimits>;
  /** Whose App Attest attestations make a device an iPhone. Apple's production root by default. */
  appAttest?: AppAttestPolicy;
  /** The web client's origins, exactly (§9.9). Other pages can't call the relay. */
  webOrigins?: string[];
  hostname?: string;
  port?: number;
  /** Keep each account's database in files here, so a restart keeps queues and links. */
  dataDir?: string;
  /** A fake clock. With one, alarms don't fire by themselves: call `tick()`. */
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface LocalRelay {
  /** `http://host:port` */
  readonly url: string;
  /** `ws://host:port/v1/connect` */
  readonly wsUrl: string;
  /** Runs every account's alarm that is due by the (fake) clock. */
  tick(): Promise<void>;
  /** Open WebSocket connections, all accounts. */
  connections(): number;
  /** Drops every connection abruptly, as a relay restart would. */
  dropConnections(): void;
  stop(): Promise<void>;
}

interface WsData {
  sub: string;
  exp: number;
  state: SocketState | null;
}

class Account {
  readonly sockets = new Set<ServerWebSocket<WsData>>();
  readonly relay: AccountRelay;
  alarmAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly db: Database,
    now: () => number,
    fakeClock: boolean,
    verifyToken: (t: string) => Promise<VerifiedToken>,
    push: PushSender | null,
    limits: RelayLimits,
    appAttest: AppAttestPolicy,
    log: LocalRelayOptions["log"],
  ) {
    const sql = bunSql(db);
    this.relay = new AccountRelay({
      sql,
      sockets: () => [...this.sockets].map(wrap),
      setAlarm: (at) => {
        this.alarmAt = at;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (at !== null && !fakeClock) {
          this.timer = setTimeout(() => void this.fire(), Math.max(0, at - now()));
          this.timer.unref?.();
        }
      },
      now,
      verifyToken,
      push,
      limits,
      appAttest,
      wipe: () => dropAll(sql),
      ...(log ? { log } : {}),
    });
  }

  async fire(): Promise<void> {
    this.timer = null;
    this.alarmAt = null;
    await this.relay.alarm();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.db.close();
  }
}

const wrappers = new WeakMap<ServerWebSocket<WsData>, RelaySocket>();
function wrap(ws: ServerWebSocket<WsData>): RelaySocket {
  let w = wrappers.get(ws);
  if (!w) {
    w = {
      send: (t) => void ws.send(t),
      close: (code, reason) => ws.close(code, reason),
      state: () => ws.data.state,
      setState: (s) => {
        ws.data.state = s;
      },
    };
    wrappers.set(ws, w);
  }
  return w;
}

function bunSql(db: Database): Sql {
  return {
    all: <T>(q: string, ...p: SqlValue[]) => db.query(q).all(...p) as T[],
    run: (q, ...p) => void db.query(q).run(...p),
    tx: (f) => db.transaction(f)(),
  };
}

export async function startLocalRelay(opts: LocalRelayOptions): Promise<LocalRelay> {
  const now = opts.now ?? Date.now;
  const verifier = new TokenVerifier({ ...opts, now });
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const appAttest = opts.appAttest ?? productionAppAttestPolicy(false);
  const webOrigins = parseWebOrigins(opts.webOrigins);
  const push: PushSender | null = !opts.apns ? null : "send" in opts.apns ? opts.apns : new ApnsClient({ ...opts.apns, now });
  const accounts = new Map<string, Account>();
  let stopped = false;
  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });

  const account = (sub: string): Account => {
    let a = accounts.get(sub);
    if (!a) {
      const file = opts.dataDir ? join(opts.dataDir, `${new Bun.CryptoHasher("sha256").update(sub).digest("hex").slice(0, 32)}.sqlite`) : ":memory:";
      const db = new Database(file, { create: true, strict: true });
      db.run("PRAGMA journal_mode = WAL");
      a = new Account(db, now, !!opts.now, (t) => verifier.verify(t), push, limits, appAttest, opts.log);
      accounts.set(sub, a);
    }
    return a;
  };

  const authenticate = async (req: Request): Promise<VerifiedToken | Response> => {
    const token = bearerToken(req);
    if (!token) return errorResponse("unauthenticated", "no access token");
    try {
      return await verifier.verify(token);
    } catch (e) {
      if (e instanceof AuthError) return errorResponse(e.code, e.message);
      return errorResponse("internal", "token check failed");
    }
  };

  const server: Server<WsData> = Bun.serve<WsData>({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const origin = checkOrigin(req, webOrigins);
      if (!origin.ok) return errorResponse("forbidden", "this origin may not call the relay");
      if (req.method === "OPTIONS") return origin.origin ? preflight(origin.origin) : errorResponse("not_found", "no such endpoint");
      if (url.pathname === RELAY_PATHS.health) return withCors(Response.json({ ok: true }), origin.origin);
      const auth = await authenticate(req);
      if (auth instanceof Response) return withCors(auth, origin.origin);
      if (url.pathname === RELAY_PATHS.connect) {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse("invalid", "expected a WebSocket upgrade");
        const ok = srv.upgrade(req, { data: { sub: auth.sub, exp: auth.exp, state: null }, headers: { "sec-websocket-protocol": WS_SUBPROTOCOL } });
        return ok ? undefined : errorResponse("invalid", "upgrade failed");
      }
      return withCors(await account(auth.sub).relay.http(req, auth), origin.origin);
    },
    websocket: {
      open(ws) {
        const a = account(ws.data.sub);
        a.sockets.add(ws);
        a.relay.open(wrap(ws), { sub: ws.data.sub, exp: ws.data.exp });
      },
      async message(ws, msg) {
        const a = account(ws.data.sub);
        if (typeof msg !== "string") return ws.close(4400, "text frames only");
        await a.relay.message(wrap(ws), msg);
      },
      close(ws) {
        if (stopped) return;
        const a = accounts.get(ws.data.sub);
        if (!a) return;
        a.sockets.delete(ws);
        a.relay.closed(wrap(ws));
      },
      maxPayloadLength: 1024 * 1024,
      idleTimeout: 120,
    },
  });

  const url = `http://${server.hostname}:${server.port}`;
  return {
    url,
    wsUrl: `${url.replace(/^http/, "ws")}${RELAY_PATHS.connect}`,
    async tick() {
      for (const a of accounts.values()) if (a.alarmAt !== null && a.alarmAt <= now()) await a.fire();
    },
    connections: () => [...accounts.values()].reduce((n, a) => n + a.sockets.size, 0),
    dropConnections() {
      for (const a of accounts.values()) for (const ws of a.sockets) ws.terminate();
    },
    async stop() {
      stopped = true;
      server.stop(true);
      for (const a of accounts.values()) a.close();
      accounts.clear();
    },
  };
}
