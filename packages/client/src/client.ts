import type { Socket } from "bun";
import {
  METHODS,
  PROTOCOL_VERSION,
  type CallerRole,
  type HelloAuth,
  type HelloParams,
  type HelloResult,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type RpcError,
} from "@homerun/core";

/** The runtime answered with a JSON-RPC error. */
export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

/** Nothing is listening on the socket (no runtime, or a stale socket file). */
export class RuntimeUnavailableError extends Error {
  constructor(
    readonly socketPath: string,
    cause?: unknown,
  ) {
    super(`nothing is answering on ${socketPath}`, { cause });
    this.name = "RuntimeUnavailableError";
  }
}

/** The connection closed before a reply arrived. */
export class ConnectionClosedError extends Error {
  constructor() {
    super("connection closed");
    this.name = "ConnectionClosedError";
  }
}

/** The runtime sent something that is not a valid frame, or a result that fails its core schema. */
export class RpcProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export interface OpenOptions {
  client?: HelloParams["client"];
  capabilities?: string[];
  /** Parse every result with its core schema (the CLI does; tests of the server's own checks don't). */
  validate?: boolean;
}

type Pending = { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * A JSON-RPC 2.0 client for homerund's local socket (§5.2): one frame per line. Used by the CLI,
 * the tests, the replay harness and the development shell.
 */
export class RpcClient {
  private socket: Socket<undefined> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inbuf = "";
  private out: Buffer[] = [];
  private listeners = new Set<(method: string, params: unknown) => void>();
  private closedResolve!: () => void;
  readonly closed = new Promise<void>((r) => (this.closedResolve = r));
  /** The `hello` result, once `open` has completed the handshake. */
  hello: HelloResult | null = null;
  validate = false;

  static async connect(socketPath: string): Promise<RpcClient> {
    const c = new RpcClient();
    try {
      c.socket = await Bun.connect({
        unix: socketPath,
        socket: {
          data: (_s, chunk) => c.onData(chunk.toString("utf8")),
          drain: () => c.flush(),
          close: () => c.onClose(),
          error: () => c.onClose(),
        },
      });
    } catch (e) {
      throw new RuntimeUnavailableError(socketPath, e);
    }
    return c;
  }

  /** Connect and complete `hello`. */
  static async open(socketPath: string, role: CallerRole, auth: HelloAuth, o: OpenOptions = {}): Promise<RpcClient> {
    const c = await RpcClient.connect(socketPath);
    c.validate = o.validate ?? false;
    try {
      c.hello = await c.call("hello", {
        protocol: { min: 1, max: PROTOCOL_VERSION },
        role,
        auth,
        client: o.client ?? { name: "homerun-test", version: "0" },
        capabilities: o.capabilities ?? [],
      });
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const p = this.raw(method, params);
    if (!this.validate) return p as Promise<MethodResult<M>>;
    return p.then((r) => {
      const parsed = METHODS[method].result.safeParse(r);
      if (!parsed.success) throw new RpcProtocolError(`the runtime's ${method} result does not match its schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return parsed.data as MethodResult<M>;
    });
  }

  /** Any method and params, unchecked (for testing the server's own checks). */
  raw(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new ConnectionClosedError());
      this.pending.set(id, { method, resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  write(frame: unknown): void {
    this.writeText(JSON.stringify(frame) + "\n");
  }

  writeText(text: string): void {
    this.out.push(Buffer.from(text));
    this.flush();
  }

  private flush(): void {
    while (this.socket && this.out.length) {
      const b = this.out[0]!;
      const n = this.socket.write(b);
      if (n < b.length) {
        this.out[0] = b.subarray(Math.max(n, 0));
        return;
      }
      this.out.shift();
    }
  }

  onNotification(fn: (method: string, params: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get isOpen(): boolean {
    return this.socket !== null;
  }

  close(): void {
    this.socket?.end();
    this.onClose();
  }

  private onData(text: string): void {
    this.inbuf += text;
    for (let nl = this.inbuf.indexOf("\n"); nl >= 0; nl = this.inbuf.indexOf("\n")) {
      const line = this.inbuf.slice(0, nl);
      this.inbuf = this.inbuf.slice(nl + 1);
      if (!line) continue;
      let f: { id?: number | null; method?: string; params?: unknown; result?: unknown; error?: RpcError };
      try {
        f = JSON.parse(line);
      } catch {
        return this.abort(new RpcProtocolError("the runtime sent a frame that is not JSON"));
      }
      if (typeof f !== "object" || f === null) return this.abort(new RpcProtocolError("the runtime sent a frame that is not an object"));
      if (f.method !== undefined && f.id === undefined) {
        for (const l of [...this.listeners]) l(f.method, f.params);
        continue;
      }
      const p = typeof f.id === "number" ? this.pending.get(f.id) : undefined;
      if (f.id === null || !p) {
        // An error without a readable id (parse error): fail the oldest pending call.
        const first = [...this.pending.entries()][0];
        if (first && f.error) {
          this.pending.delete(first[0]);
          first[1].reject(new RpcCallError(f.error.code, f.error.message, f.error.data));
        }
        continue;
      }
      this.pending.delete(f.id!);
      if (f.error) p.reject(new RpcCallError(f.error.code, f.error.message, f.error.data));
      else p.resolve(f.result);
    }
  }

  private abort(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    this.close();
  }

  private onClose(): void {
    if (!this.socket) return;
    this.socket = null;
    for (const p of this.pending.values()) p.reject(new ConnectionClosedError());
    this.pending.clear();
    this.closedResolve();
  }
}
