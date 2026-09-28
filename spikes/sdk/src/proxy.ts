/**
 * Logging reverse proxy for ANTHROPIC_BASE_URL. Records every request body the
 * `claude` process sends, so we can see exactly what the model is shown on
 * resume (item 4). Headers are never written; as defence in depth, credential
 * headers are redacted and the key value is scrubbed from anything written.
 *
 *   bun run spikes/sdk/src/proxy.ts <port> <outdir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8787);
const out = process.argv[3] ?? ".spike/proxy";
mkdirSync(out, { recursive: true });
let n = 0;
const SECRET_HEADERS = ["x-api-key", "authorization", "anthropic-api-key", "proxy-authorization"];
const KEY = process.env.ANTHROPIC_API_KEY ?? "";
const scrub = (text: string) => (KEY.length >= 8 ? text.split(KEY).join("[REDACTED]") : text).replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
const redactedHeaders = (h: Headers) => Object.fromEntries([...h.entries()].map(([k, v]) => [k, SECRET_HEADERS.includes(k.toLowerCase()) ? "[REDACTED]" : scrub(v)]));
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
        writeFileSync(join(out, `${id}-${url.pathname.replaceAll("/", "_")}.json`), scrub(JSON.stringify({ path: url.pathname, headers: redactedHeaders(req.headers), body: JSON.parse(new TextDecoder().decode(body)) }, null, 2)));
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
