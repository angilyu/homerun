import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (req: Request) => Response | Promise<Response>;

export interface RunningServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serves a Web-standard handler on 127.0.0.1 over node:http, so the test servers run under Bun and
 * Node alike (the relay's workerd tests are driven from Node).
 */
export async function serve(handler: Handler, port = 0): Promise<RunningServer> {
  const server = createServer((req, res) => void respond(handler, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const p = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${p}`,
    port: p,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function respond(handler: Handler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    const method = req.method ?? "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
    const r = await handler(new Request(`http://127.0.0.1${req.url ?? "/"}`, { method, headers, body }));
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => (out[k] = v));
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(e instanceof Error ? e.message : String(e));
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
