/**
 * Logging reverse proxy for ANTHROPIC_BASE_URL. Records every request body the
 * `claude` process sends, so we can see exactly what the model is shown on
 * resume (item 4). Never records headers (they carry the API key).
 *
 *   bun run spikes/sdk/src/proxy.ts <port> <outdir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8787);
const out = process.argv[3] ?? ".spike/proxy";
mkdirSync(out, { recursive: true });
let n = 0;
// Real API by default; the scripted mock (mock-api.ts) when running without a key.
const UPSTREAM = process.env.HOMERUN_PROXY_UPSTREAM ?? "https://api.anthropic.com";

Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const id = String(++n).padStart(3, "0");
    if (body && url.pathname.includes("/messages")) {
      try {
        writeFileSync(join(out, `${id}-${url.pathname.replaceAll("/", "_")}.json`), JSON.stringify({ path: url.pathname, body: JSON.parse(new TextDecoder().decode(body)) }, null, 2));
      } catch {}
    }
    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("accept-encoding");
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, { method: req.method, headers, body });
    const rh = new Headers(upstream.headers);
    rh.delete("content-encoding");
    rh.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: rh });
  },
});
console.log(`proxy listening on ${port} → ${out}`);
