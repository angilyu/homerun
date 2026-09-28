import type { Socket } from "bun";
import {
  PROTOCOL_VERSION,
  type CallerRole,
  type HelloAuth,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type RpcError,
} from "@homerun/core";

export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * A minimal client for the local socket: tests, the replay harness and `scripts/dev-shell.ts`.
 * The real CLI arrives in M3.
 */
export class RpcClient {
  private socket: Socket<undefined> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private inbuf = "";
  private listeners = new Set<(method: string, params: unknown) => void>();
  private closedResolve!: () => void;
  readonly closed = new Promise<void>((r) => (this.closedResolve = r));

  static async connect(socketPath: string): Promise<RpcClient> {
    const c = new RpcClient();
    c.socket = await Bun.connect({
      unix: socketPath,
      socket: {
        data: (_s, chunk) => c.onData(chunk.toString("utf8")),
        drain: () => c.flush(),
        close: () => c.onClose(),
        error: () => c.onClose(),
      },
    });
    return c;
  }

  /** Connect and complete `hello`. */
  static async open(socketPath: string, role: CallerRole, auth: HelloAuth): Promise<RpcClient> {
    const c = await RpcClient.connect(socketPath);
    await c.call("hello", {
      protocol: { min: 1, max: PROTOCOL_VERSION },
      role,
      auth,
      client: { name: "homerun-test", version: "0" },
      capabilities: [],
    });
    return c;
  }

  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    return this.raw(method, params) as Promise<MethodResult<M>>;
  }

  /** Any method and params, unchecked (for testing the server's own checks). */
  raw(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("not connected"));
      this.pending.set(id, { resolve, reject });
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

  private out: Buffer[] = [];

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
      const f = JSON.parse(line) as { id?: number | null; method?: string; params?: unknown; result?: unknown; error?: RpcError };
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

  private onClose(): void {
    if (!this.socket) return;
    this.socket = null;
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    this.closedResolve();
  }
}
