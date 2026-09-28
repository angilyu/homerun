import type { Server } from "bun";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CASSETTE_VERSION,
  blocksOf,
  diff,
  fingerprint,
  fpKey,
  loadCassette,
  normalizer,
  saveCassette,
  summarize,
  type Cassette,
  type Entry,
  type Fingerprint,
  type Normalizer,
  type SseEvent,
} from "./cassette";

export type Mode = "record" | "replay";

export interface ReplayServerOptions {
  mode: Mode;
  scenario: string;
  cassettePath: string;
  /** Record mode only: the real key, injected upstream. homerund and claude only see the dummy key. */
  apiKey?: string;
  /** Machine-specific strings to replace, e.g. [tempDir, "<DATA>"]. */
  normalize: Array<[string, string]>;
  /** Fail if any request body matches (the isolation scenario's canaries). */
  forbid?: RegExp;
  /** The key homerund was given; every API request must carry exactly this one. */
  expectKey?: string;
  gapMs?: number;
  upstream?: string;
}

export interface RequestRecord {
  n: number;
  path: string;
  fp: Fingerprint | null;
  at: number;
  outcome: "replayed" | "recorded" | "held" | "unmatched" | "rejected" | "ignored";
}

type Block = { type: string; [k: string]: unknown };
type Msg = { role: string; content: string | Block[] };

/** Haiku 4.5 list prices, USD per token, to cap recording spend. */
const PRICE = { input: 1e-6, output: 5e-6, cacheWrite: 1.25e-6, cacheRead: 0.1e-6 };
/** Global recording cap across every scenario in one `record` run (plan §7). */
export const RECORD_CAP_USD = 0.25;
let recordSpend = 0;
export const recordSpendUsd = () => recordSpend;

/**
 * The Messages API stand-in for replay scenarios (§16.2). In replay mode it serves recorded
 * responses; in record mode it forwards to the real API and writes the cassette. In both it
 * enforces the API's tool_use/tool_result pairing rule (carried over from the milestone 0 mock),
 * so a transcript that the real API would reject fails here too.
 */
export class ReplayServer {
  private server: Server<undefined> | null = null;
  private cassette: Cassette;
  private used = new Set<number>();
  private holds: Array<{ pred: (fp: Fingerprint, n: number) => boolean; resolve: () => void }> = [];
  private recorded: Entry[] = [];
  private norm: Normalizer;
  private denorm: Normalizer;
  readonly requests: RequestRecord[] = [];
  readonly errors: string[] = [];
  private messageCount = 0;

  constructor(private o: ReplayServerOptions) {
    this.norm = normalizer(o.normalize);
    this.denorm = normalizer(o.normalize.map(([from, to]) => [to, from]));
    const c = loadCassette(o.cassettePath);
    if (o.mode === "replay" && !c) throw new Error(`no cassette at ${o.cassettePath}; record it with: pnpm --filter @homerun/homerund record`);
    if (o.mode === "record" && !o.apiKey) throw new Error("record mode needs ANTHROPIC_API_KEY in .env.local");
    this.cassette = c ?? { version: CASSETTE_VERSION, scenario: o.scenario, recorded_with: { claude_agent_sdk: "", claude: "", model: "" }, note: "", entries: [] };
  }

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  /** Messages API requests so far (not counting ignored side paths). */
  get messageRequests(): number {
    return this.messageCount;
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /**
   * Never answer the first Messages API request matching `pred` (n is 1-based); resolves when it
   * arrives. A held request is never forwarded when recording, so it costs nothing.
   */
  hold(pred: (fp: Fingerprint, n: number) => boolean): Promise<void> {
    return new Promise((resolve) => this.holds.push({ pred, resolve }));
  }

  /** Replay: every recorded entry must have been used. Record: write the cassette. */
  finish(meta: { claude: string; sdk: string; model: string; note: string }): void {
    if (this.o.mode === "replay") {
      const unused = this.cassette.entries.map((e, i) => [e, i] as const).filter(([, i]) => !this.used.has(i));
      if (unused.length) this.errors.push(`unused cassette entries: ${unused.map(([e]) => e.summary).join(" | ")}`);
      return;
    }
    mkdirSync(dirname(this.o.cassettePath), { recursive: true });
    const c: Cassette = {
      version: CASSETTE_VERSION,
      scenario: this.o.scenario,
      recorded_with: { claude_agent_sdk: meta.sdk, claude: meta.claude, model: meta.model },
      note: meta.note,
      entries: this.recorded.map(coalesce),
    };
    saveCassette(this.o.cassettePath, c, this.o.apiKey ? [this.o.apiKey] : [], this.norm);
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : "";
    // Connectivity probes and anything that is not an API call: not part of the conversation.
    if (req.method !== "POST" || !url.pathname.startsWith("/v1/")) {
      this.requests.push({ n: 0, path: url.pathname, fp: null, at: Date.now(), outcome: "ignored" });
      if (url.pathname === "/api/hello") return Response.json({});
      return Response.json({ type: "error", error: { type: "not_found_error", message: "replay: not found" } }, { status: 404 });
    }
    const key = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    if (this.o.expectKey && key !== this.o.expectKey) this.errors.push(`a request to ${url.pathname} carried an unexpected credential (${key === null ? "none" : "not the key homerund was given"})`);
    if (this.o.forbid && this.o.forbid.test(raw)) this.errors.push(`a request matched the forbidden pattern ${this.o.forbid}: ${raw.match(this.o.forbid)![0]}`);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {}
    const isMessages = url.pathname === "/v1/messages";
    const n = isMessages ? ++this.messageCount : 0;
    const fp = fingerprint(url.pathname, body, this.norm);
    const rec: RequestRecord = { n, path: url.pathname, fp, at: Date.now(), outcome: "unmatched" };
    this.requests.push(rec);

    if (isMessages) {
      const bad = validatePairing((body.messages as Msg[]) ?? []);
      if (bad) {
        rec.outcome = "rejected";
        this.errors.push(`request ${n}: ${bad}`);
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: bad } }, { status: 400 });
      }
    }
    const hi = n ? this.holds.findIndex((h) => h.pred(fp, n)) : -1;
    if (hi >= 0) {
      const [h] = this.holds.splice(hi, 1);
      rec.outcome = "held";
      h!.resolve();
      return new Promise<Response>(() => {});
    }
    return this.o.mode === "replay" ? this.replay(fp, body, rec) : this.record(req, url, raw, fp, body, rec);
  }

  private replay(fp: Fingerprint, body: Record<string, unknown>, rec: RequestRecord): Response {
    const key = fpKey(fp);
    const i = this.cassette.entries.findIndex((e, idx) => !this.used.has(idx) && fpKey(e.request) === key);
    if (i < 0) {
      const nearest = this.cassette.entries.filter((_, idx) => !this.used.has(idx)).sort((a, b) => score(b.request, fp) - score(a.request, fp))[0];
      const why = nearest ? diff(fp, nearest.request) : "the cassette has no unused entries";
      this.errors.push(`request ${rec.n} (${fp.path}) matches no cassette entry: ${why}`);
      // A 400, not a 5xx: claude retries 5xx for a long time; a mismatch should fail fast.
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: `replay mismatch: ${why}` } }, { status: 400 });
    }
    this.used.add(i);
    rec.outcome = "replayed";
    const e = this.cassette.entries[i]!;
    if (!e.response.events) return new Response(this.denorm(JSON.stringify(e.response.body)), { status: e.response.status, headers: { "content-type": "application/json" } });
    const gap = this.o.gapMs ?? 5;
    const events = e.response.events;
    const enc = new TextEncoder();
    const denorm = this.denorm;
    let k = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (k >= events.length) return ctrl.close();
        if (k > 0) await Bun.sleep(gap);
        const ev = events[k++]!;
        ctrl.enqueue(enc.encode(`event: ${ev.event}\ndata: ${denorm(JSON.stringify(ev.data))}\n\n`));
      },
    });
    void body;
    return new Response(stream, { status: e.response.status, headers: { "content-type": "text/event-stream", "request-id": `req_replay_${rec.n}` } });
  }

  private async record(req: Request, url: URL, raw: string, fp: Fingerprint, _body: Record<string, unknown>, rec: RequestRecord): Promise<Response> {
    if (recordSpend >= RECORD_CAP_USD) {
      this.errors.push(`recording spend cap $${RECORD_CAP_USD} reached`);
      return Response.json({ type: "error", error: { type: "invalid_request_error", message: "recording cap reached" } }, { status: 400 });
    }
    const headers = new Headers();
    for (const [k, v] of req.headers) {
      if (["host", "content-length", "connection", "accept-encoding", "x-api-key", "authorization"].includes(k.toLowerCase())) continue;
      headers.set(k, v);
    }
    headers.set("x-api-key", this.o.apiKey!);
    const upstream = await fetch((this.o.upstream ?? "https://api.anthropic.com") + url.pathname + url.search, { method: "POST", headers, body: raw });
    rec.outcome = "recorded";
    const ctype = upstream.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) {
      const text = await upstream.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      this.recorded.push({ summary: summarize(fp, undefined), request: fp, response: { status: upstream.status, body: parsed } });
      return new Response(text, { status: upstream.status, headers: { "content-type": ctype || "application/json" } });
    }
    const events: SseEvent[] = [];
    let usage: Usage = {};
    const entry: Entry = { summary: "", request: fp, response: { status: upstream.status, events } };
    const reader = upstream.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const onChunk = (text: string) => {
      buf += text;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (event === "ping" || !data) continue;
        const d = JSON.parse(data) as { usage?: Usage; message?: { usage?: Usage } };
        // message_delta's usage is cumulative and may omit input counts: merge, count once at the end.
        usage = { ...usage, ...(d.message?.usage ?? d.usage) };
        events.push({ event, data: d });
      }
    };
    const recorded = this.recorded;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        const { value, done } = await reader.read();
        if (done) {
          recordSpend += cost(usage);
          entry.summary = summarize(fp, events);
          recorded.push(entry);
          return ctrl.close();
        }
        onChunk(dec.decode(value, { stream: true }));
        ctrl.enqueue(value);
      },
      cancel() {
        void reader.cancel();
      },
    });
    return new Response(stream, { status: upstream.status, headers: { "content-type": ctype } });
  }
}

/**
 * Merge consecutive tool-input and thinking deltas of one block into a single delta before
 * saving: the cassette stays small, and a path in a tool input is never split across chunks, so
 * normalization always sees it whole. Text deltas are kept as recorded; they are what streams.
 */
function coalesce(e: Entry): Entry {
  if (!e.response.events) return e;
  const out: SseEvent[] = [];
  const fields: Record<string, string> = { input_json_delta: "partial_json", thinking_delta: "thinking" };
  for (const ev of e.response.events) {
    const d = ev.data as { type?: string; index?: number; delta?: Record<string, unknown> };
    const prev = out.at(-1)?.data as typeof d | undefined;
    const f = d.delta && typeof d.delta.type === "string" ? fields[d.delta.type] : undefined;
    if (f && ev.event === "content_block_delta" && prev?.type === "content_block_delta" && prev.index === d.index && prev.delta?.type === d.delta!.type) {
      prev.delta![f] = String(prev.delta![f] ?? "") + String(d.delta![f] ?? "");
      continue;
    }
    const copy = structuredClone(ev.data) as typeof d & { content_block?: Record<string, unknown> };
    // Thinking signatures are opaque and only the real API checks them.
    if (copy.delta?.type === "signature_delta") copy.delta.signature = "replay-signature";
    if (copy.content_block && typeof copy.content_block.signature === "string" && copy.content_block.signature) copy.content_block.signature = "replay-signature";
    out.push({ event: ev.event, data: copy });
  }
  return { ...e, response: { ...e.response, events: out } };
}

type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
function cost(u: Usage | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead;
}

function score(a: Fingerprint, b: Fingerprint): number {
  let s = a.path === b.path ? 1000 : 0;
  for (let i = 0; i < Math.min(a.messages.length, b.messages.length); i++) {
    if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) break;
    s++;
  }
  return s - Math.abs(a.messages.length - b.messages.length);
}

/** The API's rule: every tool_use must be answered by a tool_result in the next user message. */
export function validatePairing(messages: Msg[]): string | null {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const ids = blocksOf(m).filter((b) => b.type === "tool_use").map((b) => String(b.id));
    if (!ids.length) continue;
    const next = messages[i + 1];
    const answered = new Set(next && next.role === "user" ? blocksOf(next).filter((b) => b.type === "tool_result").map((b) => String(b.tool_use_id)) : []);
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length) {
      return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(", ")}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`;
    }
  }
  return null;
}
