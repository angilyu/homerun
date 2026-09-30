import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { TCPSocketListener, UnixSocketListener } from "bun";
import {
  MAX_FRAME_BYTES,
  METHODS,
  NOTIFICATIONS,
  RPC_ERROR,
  authorize,
  classifyFrame,
  mayReceive,
  maySend,
  type CallerRole,
  type MethodName,
  type NotificationName,
  type RpcId,
  type RpcNotification,
  type RpcRequest,
  type RpcFailure,
  type RpcSuccess,
} from "@homerun/core";
import { endpointPath, EndpointError, readEndpointFile } from "@homerun/client";
import { log, scrub } from "../log";
import { lockPipe, publishEndpoint, unpublishEndpoint } from "../platform/secure";
import { BudgetCapError, InvalidRequestError, NotFoundError, VersionConflictError } from "../runs/manager";
import { StateConflictError } from "../store/schedule-rows";
import { RpcFail, type Conn, type Handlers } from "./handlers";

export const HELLO_TIMEOUT_MS = 2_000;
/** A client that stops reading is dropped rather than buffered without bound (plan §6). */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export interface ServerOptions {
  /** A unix socket path, or on Windows a pipe name (`\\.\pipe\homerun-…`). */
  socketPath: string;
  /** Where the pipe name is published for clients (Windows; `<data>\run`). */
  runDir?: string;
  handlers: Handlers;
  /** Parse every result with its core schema before sending (tests and development). */
  checkResults?: boolean;
  helloTimeoutMs?: number;
  /** Notifications the shell sends the runtime (`power.*`), already checked against their schema. */
  onNotification?: (method: NotificationName, params: unknown) => void;
  /** A connection closed, for whatever reason (withdraws its CLI access request). */
  onConnectionClosed?: (conn: Connection) => void;
}

type Data = { conn: Connection };

/** Where a connection writes its NDJSON: the socket, or a live session's encryptor. */
export interface FrameSink {
  /** Bytes accepted; fewer means the rest waits for `onDrain`. */
  write(buf: Buffer): number;
  end(): void;
}

/** A paired device, authenticated by its Noise session (§9.4, §12). */
export interface RemotePeer {
  deviceId: string;
  platform: "ios" | "web";
}

export class ShellCallError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** How long the runtime waits for the shell to answer a request (`secrets.persist`). */
export const SHELL_CALL_TIMEOUT_MS = 10_000;

/** The local JSON-RPC server (§5.2): NDJSON frames on a 0600 unix socket in a 0700 directory. */
export class RpcServer {
  private listener: UnixSocketListener<Data> | TCPSocketListener<Data> | null = null;
  readonly connections = new Set<Connection>();

  constructor(private opts: ServerOptions) {}

  async start(): Promise<void> {
    if (process.platform === "win32") return this.startPipe();
    const path = this.opts.socketPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    if (existsSync(path)) {
      if (await socketAnswers(path)) throw new AlreadyRunningError(path);
      unlinkSync(path);
    }
    this.listen(path);
    chmodSync(path, 0o600);
    log.info("listening", { socket: path });
  }

  /**
   * Windows (§5.2): listen on the pipe, lock its DACL to the user before serving anyone, drop
   * whatever connected before that, then publish the name. A pipe that can't be locked is not
   * served.
   */
  private async startPipe(): Promise<void> {
    const name = this.opts.socketPath;
    const runDir = this.opts.runDir;
    if (!runDir) throw new Error("a pipe server needs a run dir to publish its name in");
    try {
      const previous = readEndpointFile(endpointPath(runDir));
      if (await socketAnswers(previous)) throw new AlreadyRunningError(previous);
    } catch (e) {
      if (!(e instanceof EndpointError)) throw e;
    }
    this.listen(name);
    try {
      await lockPipe(name);
    } catch (e) {
      this.stop();
      throw e;
    }
    // Only the lock's own handle can have connected yet, but anything accepted under the default
    // DACL goes.
    for (const c of [...this.connections]) c.close();
    publishEndpoint(runDir, name);
    log.info("listening", { socket: name });
  }

  private listen(path: string): void {
    this.listener = Bun.listen<Data>({
      unix: path,
      socket: {
        open: (s) => {
          const c = new Connection(s, this.opts);
          s.data = { conn: c };
          this.connections.add(c);
        },
        data: (s, chunk) => s.data.conn.onData(chunk),
        drain: (s) => s.data.conn.onDrain(),
        close: (s) => {
          s.data.conn.onClose();
          this.connections.delete(s.data.conn);
        },
        error: (s, err) => log.warn("socket error", { err: err.message, role: s.data?.conn.role }),
      },
    });
  }

  /** Send a notification to every connection whose role may receive it. */
  broadcast(method: NotificationName, params: unknown): void {
    for (const c of this.connections) c.notify(method, params);
  }

  /**
   * Serve a connection that isn't on the socket: a paired device's live session (§9.4), whose
   * Noise session already authenticated `remote`. Its frames arrive through `onData`.
   */
  adopt(sink: FrameSink, remote: RemotePeer): Connection {
    const c = new Connection(sink, this.opts, remote);
    c.onClosed(() => this.connections.delete(c));
    this.connections.add(c);
    return c;
  }

  /** The shell's own connection, if it is connected and said hello. */
  shell(): Connection | null {
    let found: Connection | null = null;
    for (const c of this.connections) if (c.role === "shell" && c.open) found = c;
    return found;
  }

  /** Close every live session from this paired device (it was unpaired). */
  closeRemoteConnections(deviceId: string): void {
    for (const c of [...this.connections]) if (c.remote?.deviceId === deviceId) c.close();
  }

  /** Close every connection that said hello with this CLI token (it was revoked, §5.2). */
  closeTokenConnections(tokenId: string): void {
    for (const c of [...this.connections]) if (c.cliTokenId === tokenId) c.close();
  }

  /** Stop accepting and close every connection. */
  stop(): void {
    this.listener?.stop(true);
    this.listener = null;
    for (const c of this.connections) c.close();
    this.connections.clear();
    if (process.platform === "win32") {
      if (this.opts.runDir) unpublishEndpoint(this.opts.runDir, this.opts.socketPath);
      return;
    }
    try {
      unlinkSync(this.opts.socketPath);
    } catch {}
  }
}

export class AlreadyRunningError extends Error {
  constructor(readonly socketPath: string) {
    super(`another homerund is answering on ${socketPath}`);
  }
}

/** Whether something accepts connections on `path` (a live runtime, not a stale socket file). */
export function socketAnswers(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (v: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(v);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export class Connection implements Conn {
  role: CallerRole | null = null;
  cliTokenId: string | null = null;
  readonly subscriptions = new Map<string, () => void>();
  private inbuf: Buffer = Buffer.alloc(0);
  private out: Buffer[] = [];
  private outBytes = 0;
  private closed = false;
  private closeAfterFlush = false;
  private closedNotified = false;
  private helloTimer: ReturnType<typeof setTimeout> | null;
  private nextCallId = 1;
  private calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closedListeners: (() => void)[] = [];

  constructor(
    private socket: FrameSink,
    private opts: ServerOptions,
    /** Set for a paired device's live session; null on the local socket. */
    readonly remote: RemotePeer | null = null,
  ) {
    this.helloTimer = null;
    this.restartHelloTimeout();
  }

  get open(): boolean {
    return !this.closed && !this.closeAfterFlush;
  }

  onClosed(fn: () => void): void {
    this.closedListeners.push(fn);
  }

  /**
   * A runtime → shell request (§5.2: `secrets.persist`). Only on the shell's connection; the
   * reply arrives as a response frame on the same connection.
   */
  request(method: string, params: unknown, timeoutMs = SHELL_CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.role !== "shell") return Promise.reject(new ShellCallError(null, "not the shell's connection"));
    if (!this.open) return Promise.reject(new ShellCallError(null, "the shell's connection is closed"));
    const id = `rt-${this.nextCallId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new ShellCallError(null, `the shell didn't answer ${method}`));
      }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  setRole(role: CallerRole): void {
    this.role = role;
    this.holdHelloTimeout();
  }

  /** An access request is waiting for the user: don't drop the connection meanwhile. */
  holdHelloTimeout(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  /** Close the connection unless it says hello within the timeout. */
  restartHelloTimeout(): void {
    this.holdHelloTimeout();
    if (this.closed || this.role !== null) return;
    this.helloTimer = setTimeout(() => {
      if (this.role === null) this.close();
    }, this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
  }

  /** The one notification an unauthenticated connection receives: the answer to its own access request. */
  sendAccessDecision(params: unknown): void {
    if (this.role !== null) return;
    this.send({ jsonrpc: "2.0", method: "cli.access_decision", params });
  }

  onData(chunk: Buffer): void {
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.closed || this.closeAfterFlush) return;
      const nl = this.inbuf.indexOf(0x0a);
      if (nl < 0) break;
      const line = this.inbuf.subarray(0, nl);
      this.inbuf = this.inbuf.subarray(nl + 1);
      if (line.length > MAX_FRAME_BYTES) {
        this.fail(null, RPC_ERROR.INVALID_REQUEST, "Frame too large.", undefined, true);
        return;
      }
      if (line.length) this.onFrame(line.toString("utf8"));
    }
    if (this.inbuf.length > MAX_FRAME_BYTES) this.fail(null, RPC_ERROR.INVALID_REQUEST, "Frame too large.", undefined, true);
  }

  private onFrame(text: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.fail(null, RPC_ERROR.PARSE_ERROR, "Parse error.");
    }
    const c = classifyFrame(raw);
    if (c.kind === "invalid") {
      const id = readableId(raw);
      return this.fail(id, RPC_ERROR.INVALID_REQUEST, "Invalid request.", { issues: c.error.issues.slice(0, 20) as unknown as object });
    }
    if (c.kind === "notification") return this.onNotification(c.frame as RpcNotification);
    if (c.kind === "success" || c.kind === "failure") return this.onResponse(c.frame as RpcSuccess | RpcFailure);
    this.onRequest(c.frame as RpcRequest);
  }

  /** A reply to one of our requests; anything else is dropped. */
  private onResponse(r: RpcSuccess | RpcFailure): void {
    if (typeof r.id !== "string") return;
    const call = this.calls.get(r.id);
    if (!call) return;
    this.calls.delete(r.id);
    clearTimeout(call.timer);
    if ("error" in r) call.reject(new ShellCallError(r.error.code, r.error.message));
    else call.resolve(r.result);
  }

  /** Only the shell may send notifications, only known ones, and a bad one is dropped (§5.2). */
  private onNotification(n: RpcNotification): void {
    if (this.role === null || !(n.method in NOTIFICATIONS)) return;
    const name = n.method as NotificationName;
    if (!maySend(this.role, name)) {
      log.warn("notification from a caller that may not send it", { role: this.role, method: name });
      return;
    }
    const parsed = NOTIFICATIONS[name].params.safeParse(n.params ?? {});
    if (!parsed.success) {
      log.warn("invalid notification params", { method: name });
      return;
    }
    try {
      this.opts.onNotification?.(name, parsed.data);
    } catch (e) {
      log.error("notification handler failed", { method: name, err: e instanceof Error ? e : String(e) });
    }
  }

  private onRequest(req: RpcRequest): void {
    const a = authorize(this.role, req.method);
    if (!a.ok) {
      if (a.reason === "unknown_method") return this.fail(req.id, RPC_ERROR.METHOD_NOT_FOUND, `Unknown method ${req.method}.`);
      if (a.reason === "handshake_required") return this.fail(req.id, RPC_ERROR.HANDSHAKE_REQUIRED, "Send hello first.");
      return this.fail(req.id, RPC_ERROR.FORBIDDEN, `${this.role ?? "This caller"} may not call ${req.method}.`);
    }
    const method = req.method as MethodName;
    const handler = this.opts.handlers[method] as ((c: Conn, p: unknown) => unknown) | undefined;
    if (!handler) return this.fail(req.id, RPC_ERROR.METHOD_NOT_FOUND, `${method} arrives in a later version of Homerun.`, { not_implemented: true });
    const parsed = METHODS[method].params.safeParse(req.params ?? {});
    if (!parsed.success) {
      return this.fail(req.id, RPC_ERROR.INVALID_PARAMS, "Invalid params.", { issues: parsed.error.issues.slice(0, 20) as unknown as object }, method === "hello");
    }
    let reply: unknown;
    try {
      reply = handler(this, parsed.data);
    } catch (e) {
      return this.failWith(req, method, e);
    }
    // A handler that has to wait (secrets.verify asks the provider) returns a promise.
    if (reply instanceof Promise) {
      reply.then(
        (r) => this.reply(req, method, r),
        (e) => this.failWith(req, method, e),
      );
      return;
    }
    this.reply(req, method, reply);
  }

  private failWith(req: RpcRequest, method: MethodName, e: unknown): void {
    if (e instanceof RpcFail) return this.fail(req.id, e.code, e.message, e.data, e.close);
    if (e instanceof NotFoundError) return this.fail(req.id, RPC_ERROR.NOT_FOUND, e.message);
    if (e instanceof InvalidRequestError) return this.fail(req.id, RPC_ERROR.VALIDATION_FAILED, e.message);
    if (e instanceof VersionConflictError) return this.fail(req.id, RPC_ERROR.CONFLICT, e.message, { current_version: e.currentVersion });
    if (e instanceof StateConflictError) {
      return e.current === null ? this.fail(req.id, RPC_ERROR.NOT_FOUND, e.message) : this.fail(req.id, RPC_ERROR.CONFLICT, e.message, { current_version: e.current });
    }
    if (e instanceof BudgetCapError) return this.fail(req.id, RPC_ERROR.BUDGET_EXCEEDED, e.message);
    log.error("handler failed", { method, err: e instanceof Error ? e : String(e) });
    return this.fail(req.id, RPC_ERROR.INTERNAL_ERROR, "Internal error.");
  }

  private reply(req: RpcRequest, method: MethodName, reply: unknown): void {
    const { result, after } = isDeferred(reply) ? reply : { result: reply, after: null };
    if (this.opts.checkResults) {
      const r = METHODS[method].result.safeParse(result);
      if (!r.success) {
        log.error("result does not match its schema", { method, issues: r.error.issues.slice(0, 5) });
        return this.fail(req.id, RPC_ERROR.INTERNAL_ERROR, "Internal error: bad result.");
      }
    }
    this.send({ jsonrpc: "2.0", id: req.id, result });
    after?.();
  }

  notify(method: string, params: unknown): void {
    if (this.role === null || !mayReceive(this.role, method as NotificationName)) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private fail(id: RpcId | null, code: number, message: string, data?: unknown, close = false): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message: scrub(message), ...(data !== undefined ? { data } : {}) } });
    if (close) this.closeAfterWrite();
  }

  private send(frame: object): void {
    if (this.closed || this.closeAfterFlush) return;
    const buf = Buffer.from(JSON.stringify(frame) + "\n");
    if (this.out.length === 0) {
      const n = this.socket.write(buf);
      if (n === buf.length) return;
      this.out.push(buf.subarray(Math.max(n, 0)));
      this.outBytes = buf.length - Math.max(n, 0);
    } else {
      this.out.push(buf);
      this.outBytes += buf.length;
    }
    if (this.outBytes > MAX_BUFFERED_BYTES) {
      log.warn("dropping a client that stopped reading", { role: this.role, buffered: this.outBytes });
      this.close();
    }
  }

  onDrain(): void {
    while (this.out.length && !this.closed) {
      const b = this.out[0]!;
      const n = this.socket.write(b);
      if (n < b.length) {
        this.out[0] = b.subarray(Math.max(n, 0));
        this.outBytes -= Math.max(n, 0);
        return;
      }
      this.out.shift();
      this.outBytes -= b.length;
    }
    if (this.closeAfterFlush && !this.out.length) this.close();
  }

  private closeAfterWrite(): void {
    this.closeAfterFlush = true;
    if (!this.out.length) this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.end();
    this.onClose();
  }

  onClose(): void {
    const first = !this.closedNotified;
    this.closedNotified = true;
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    for (const unsub of this.subscriptions.values()) unsub();
    this.subscriptions.clear();
    for (const [, call] of this.calls) {
      clearTimeout(call.timer);
      call.reject(new ShellCallError(null, "the shell's connection closed"));
    }
    this.calls.clear();
    if (first) {
      this.opts.onConnectionClosed?.(this);
      for (const fn of this.closedListeners.splice(0)) fn();
    }
  }
}

function isDeferred(r: unknown): r is { result: unknown; after: () => void } {
  return typeof r === "object" && r !== null && "after" in r && typeof (r as { after: unknown }).after === "function" && "result" in r;
}

function readableId(raw: unknown): RpcId | null {
  if (typeof raw !== "object" || raw === null) return null;
  const id = (raw as { id?: unknown }).id;
  return (typeof id === "number" && Number.isInteger(id)) || (typeof id === "string" && id.length > 0 && id.length <= 128) ? id : null;
}
