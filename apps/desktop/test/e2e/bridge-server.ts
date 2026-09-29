#!/usr/bin/env bun
/**
 * The E2E stand-in for the desktop shell (plan §9). It plays the Rust shell's part (§5.1, §5.2)
 * around a real homerund, and serves the production views over a WebSocket bridge
 * (src/platform/bridge.ts) instead of Tauri IPC:
 *
 * - connects a `shell`-role connection with the launch token, hands over the stored key, then a
 *   `webview`-role connection, in the shell's order (shell-core/src/runtime.rs `connect`);
 * - forwards the page's calls on the webview connection only after the same allowlist check as
 *   shell-core/src/allowlist.rs (core's callers.json), and its notifications back in order;
 * - keeps the API key in memory and checks it with `secrets.verify`, as shell-core/src/keys.rs.
 *
 * Runtimes (one at a time, chosen by POST /__e2e/scene):
 * - `fake`: homerund in this process with the fake engine (test/e2e/fake-script.ts), like the
 *   CLI's end-to-end tests.
 * - `replay`: a real `homerund serve` subprocess and the real bundled `claude`, against one of
 *   homerund's recorded cassettes (§16.2). No key, no network, no spend.
 * - `live` (only with HOMERUN_E2E_LIVE=1; the manual check in live.manual.ts): a real
 *   `homerund serve` against the real API through a metering proxy that refuses requests once
 *   the spend cap is reached. It starts with no key, so onboarding runs for real, and it is
 *   restarted after an unexpected exit, like the supervisor's first backoff step (§5.1).
 */
import type { ServerWebSocket } from "bun";
import { appendFileSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, normalize as normPath } from "node:path";
import { ConnectionClosedError, RpcCallError, RpcClient, RuntimeUnavailableError } from "@homerun/client";
import callers from "../../../../packages/core/schema/callers.json";
import { LAUNCH_TOKEN, sessionSpec, socketRuntime, type SocketRuntime } from "../../../homerund/test/helpers";
import { HOMERUND_DIR, Homerund, REPLAY_KEY, scratchDir } from "../../../homerund/test/replay/harness";
import { ReplayServer } from "../../../homerund/test/replay/replay-server";
import { e2eScript } from "./fake-script";

const PORT = Number(process.env.HOMERUN_E2E_PORT ?? 5179);
const DIST = join(import.meta.dir, "dist");
const CASSETTES = join(HOMERUND_DIR, "test", "replay", "cassettes");
const API_KEY = "anthropic_api_key";
/** The key the fake runtime's `secrets.verify` accepts (§7.2); any other key is refused. The
 * dummy keys come from scripts/check-no-secrets.sh. */
const GOOD_KEY = /^sk-ant-mock-not-a-real-key$/;

type ShellErr = { kind: string; code: number | null; message: string; data: unknown };
type Status = Record<string, unknown> & { state: string };

// --- the webview allowlist, as shell-core/src/allowlist.rs `webview_allows` ---
const set = (v: unknown) => new Set((v as string[] | undefined) ?? []);
const WEBVIEW = set(callers.allowlists.webview);
const PREAUTH = set((callers as { preauth?: string[] }).preauth);
const SHELL_ONLY = set((callers as { shell_only?: string[] }).shell_only);
const webviewAllows = (m: string) => m !== "hello" && WEBVIEW.has(m) && !PREAUTH.has(m) && !SHELL_ONLY.has(m);

// --- replay scenes: the same layout, spec and env as homerund's scenarios.test.ts ---
interface ReplayScene {
  env: Record<string, string>;
  gapMs?: number;
  /** A session task for the scene, created as homerund's `task()` does. */
  builtin?: string[];
}
const SCENES: Record<string, ReplayScene> = {
  "text-chat": { env: {}, gapMs: 25 },
  "ask-user-question": { env: { HOMERUN_DEV_AUTO_APPROVE: "0", HOMERUN_INPUT_GRACE_MS: "600000" }, builtin: ["AskUserQuestion"] },
  "approval-defer": { env: { HOMERUN_DEV_AUTO_APPROVE: "0", HOMERUN_INPUT_GRACE_MS: "0" }, builtin: ["Bash"] },
};

type Active =
  | { kind: "fake"; srt: SocketRuntime; socketPath: string }
  | { kind: "replay"; name: string; hr: Homerund; server: ReplayServer; root: string }
  | { kind: "live"; hr: Homerund; proxy: MeteredProxy; root: string; dataDir: string; stopping: boolean };

const LIVE = process.env.HOMERUN_E2E_LIVE === "1";
const LIVE_CAP_USD = Number(process.env.HOMERUN_E2E_LIVE_CAP_USD ?? 0.1);
const LIVE_ENV = {
  HOMERUN_DEV_AUTO_APPROVE: "0",
  HOMERUN_INPUT_GRACE_MS: "600000",
  HOMERUN_CHAT_MAX_BUDGET_USD: "0.03",
};
/** USD per token, by model family; unknown models are priced as Opus, to stay under the cap. */
const PRICES: Array<[RegExp, { input: number; output: number }]> = [
  [/haiku/, { input: 1e-6, output: 5e-6 }],
  [/sonnet/, { input: 3e-6, output: 15e-6 }],
  [/.*/, { input: 5e-6, output: 25e-6 }],
];
type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

/**
 * Forwards homerund's API traffic to api.anthropic.com unchanged, including the key homerund
 * sends, so `secrets.verify` and the runs meet the real API. It adds up each response's usage and
 * refuses `/v1/messages` once the cap is reached. It never logs headers or bodies.
 */
class MeteredProxy {
  usd = 0;
  requests = 0;
  refused = 0;
  byModel: Record<string, number> = {};
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(private capUsd: number) {}

  get url(): string {
    return `http://127.0.0.1:${this.server!.port}`;
  }

  start(): this {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => this.handle(req) });
    return this;
  }

  stop(): void {
    this.server?.stop(true);
  }

  private add(model: string, u: Usage): void {
    const p = PRICES.find(([re]) => re.test(model))![1];
    const usd =
      (u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (u.cache_read_input_tokens ?? 0) * p.input * 0.1;
    this.usd += usd;
    this.byModel[model] = (this.byModel[model] ?? 0) + usd;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let model = "";
    if (url.pathname === "/v1/messages") {
      if (this.usd >= this.capUsd) {
        this.refused++;
        // A 400: claude retries 5xx and 429, and the cap should end the run.
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: `live check spend cap $${this.capUsd} reached` } }, { status: 400 });
      }
      try {
        model = String((JSON.parse(new TextDecoder().decode(raw)) as { model?: unknown }).model ?? "");
      } catch {}
      this.requests++;
    }
    const headers = new Headers();
    for (const [k, v] of req.headers) if (!["host", "content-length", "connection", "accept-encoding"].includes(k.toLowerCase())) headers.set(k, v);
    const up = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, { method: req.method, headers, body: raw });
    const out = new Headers(up.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    if (!model) return new Response(up.body, { status: up.status, headers: out });
    if (!(up.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await up.text();
      try {
        this.add(model, ((JSON.parse(text) as { usage?: Usage }).usage ?? {}) as Usage);
      } catch {}
      return new Response(text, { status: up.status, headers: out });
    }
    // message_start carries the input counts, message_delta the cumulative output: merge, count once.
    let usage: Usage = {};
    let buf = "";
    const dec = new TextDecoder();
    const reader = up.body!.getReader();
    const stream = new ReadableStream<Uint8Array>({
      pull: async (ctrl) => {
        const { value, done } = await reader.read();
        if (done) {
          this.add(model, usage);
          return ctrl.close();
        }
        buf += dec.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const data = buf
            .slice(0, i)
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          buf = buf.slice(i + 2);
          try {
            const d = JSON.parse(data) as { usage?: Usage; message?: { usage?: Usage } };
            usage = { ...usage, ...(d.message?.usage ?? d.usage) };
          } catch {}
        }
        ctrl.enqueue(value);
      },
      cancel: async () => {
        this.add(model, usage);
        await reader.cancel();
      },
    });
    return new Response(stream, { status: up.status, headers: out });
  }
}

class Shell {
  keys = new Map<string, string>();
  status: Status = { state: "starting" };
  connection = 0;
  active: Active | null = null;
  shell: RpcClient | null = null;
  webview: RpcClient | null = null;
  pages = new Set<ServerWebSocket<unknown>>();
  opened: string[] = [];
  work: string | null = null;

  emit(event: unknown): void {
    const text = JSON.stringify({ event });
    for (const p of this.pages) p.send(text);
  }

  setStatus(s: Status): void {
    this.status = s;
    this.emit({ type: "status", status: s });
  }

  /** Stop whatever is running: close the connections, then the runtime (stdin EOF for a subprocess). */
  async stop(): Promise<void> {
    this.shell?.close();
    this.webview?.close();
    this.shell = this.webview = null;
    const a = this.active;
    this.active = null;
    if (!a) return;
    if (a.kind === "fake") await a.srt.close();
    else if (a.kind === "live") {
      a.stopping = true;
      // Spend across runs of the manual check, so the total stays under the budget.
      if (process.env.HOMERUN_E2E_LIVE_LEDGER)
        appendFileSync(process.env.HOMERUN_E2E_LIVE_LEDGER, `${JSON.stringify({ at: new Date().toISOString(), usd: a.proxy.usd, requests: a.proxy.requests, refused: a.proxy.refused })}\n`);
      await a.hr.stop().catch(() => {});
      a.proxy.stop();
      rmSync(a.root, { recursive: true, force: true });
    } else {
      a.server.stop();
      await a.hr.stop().catch(() => {});
      if (!process.env.HOMERUN_REPLAY_KEEP) rmSync(a.root, { recursive: true, force: true });
    }
  }

  /** shell-core/src/runtime.rs `connect`: shell hello, hand over secrets, then the webview hello. */
  async connect(socketPath: string, token: string): Promise<void> {
    const client = { name: "homerun-desktop-e2e", version: "0" };
    this.shell = await RpcClient.open(socketPath, "shell", { kind: "launch_token", token }, { client });
    for (const [name, value] of this.keys) await this.shell.call("secrets.set", { name: name as "anthropic_api_key", value });
    this.webview = await RpcClient.open(socketPath, "webview", { kind: "launch_token", token }, { client });
    this.webview.onNotification((method, params) => this.emit({ type: "notification", method, params }));
    const h = this.webview.hello!;
    this.setStatus({ state: "ready", connection: ++this.connection, device_id: h.device_id, runtime_version: h.runtime_version, protocol: h.protocol });
  }

  async fake(key: string | null): Promise<Record<string, unknown>> {
    await this.stop();
    this.setStatus({ state: "starting" });
    this.keys = new Map(key ? [[API_KEY, key]] : []);
    const srt = await socketRuntime({
      script: e2eScript,
      verifyKey: async (k) => (GOOD_KEY.test(k) ? { outcome: "valid" } : { outcome: "invalid", detail: "Anthropic didn't accept this key (401)." }),
    });
    const socketPath = srt.rt.config.socketPath;
    this.active = { kind: "fake", srt, socketPath };
    this.work = join(srt.dir, "work");
    mkdirSync(this.work, { recursive: true });
    await this.connect(socketPath, LAUNCH_TOKEN);
    return { work: this.work };
  }

  async replay(name: string): Promise<Record<string, unknown>> {
    const scene = SCENES[name];
    if (!scene) throw new Error(`no replay scene ${name}`);
    await this.stop();
    this.setStatus({ state: "starting" });
    // homerund's scene layout (<root>/data, <root>/work) and normalisation, so requests match.
    const root = scratchDir("hr-desktop-e2e-");
    const work = join(root, "work");
    mkdirSync(work);
    const norm: Array<[string, string]> = [
      [realpathSync(root), "<ROOT_REAL>"],
      [root, "<ROOT>"],
      [homedir(), "<HOME>"],
    ];
    if (userInfo().username.length >= 4) norm.push([userInfo().username, "<USER>"]);
    const server = new ReplayServer({ mode: "replay", scenario: name, cassettePath: join(CASSETTES, `${name}.json`), normalize: norm, expectKey: REPLAY_KEY, gapMs: scene.gapMs }).start();
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const hr = new Homerund({ dataDir, baseUrl: server.url, env: scene.env });
    this.active = { kind: "replay", name, hr, server, root };
    this.work = work;
    this.keys = new Map([[API_KEY, REPLAY_KEY]]);
    await hr.start();
    await this.connect(hr.socketPath, hr.token);
    const out: Record<string, unknown> = { work };
    if (scene.builtin) {
      const spec = sessionSpec({ max_run_usd: 0.05, roots: [work], builtin: scene.builtin });
      const created = await this.shell!.call("tasks.create", { spec: spec as never });
      Object.assign(out, { task_id: created.task.task_id, thread_id: created.thread_id, task_name: created.task.name });
    }
    return out;
  }

  /** The real API behind a metering proxy, with no key yet: onboarding runs for real. */
  async live(): Promise<Record<string, unknown>> {
    if (!LIVE) throw new Error("the live scene needs HOMERUN_E2E_LIVE=1");
    await this.stop();
    this.setStatus({ state: "starting" });
    const root = scratchDir("hr-desktop-live-");
    const work = join(root, "work");
    const dataDir = join(root, "data");
    mkdirSync(work);
    mkdirSync(dataDir);
    const proxy = new MeteredProxy(LIVE_CAP_USD).start();
    const hr = new Homerund({ dataDir, baseUrl: proxy.url, env: LIVE_ENV });
    const a: Active = { kind: "live", hr, proxy, root, dataDir, stopping: false };
    this.active = a;
    this.work = work;
    this.keys = new Map();
    await hr.start();
    this.watch(a);
    await this.connect(hr.socketPath, hr.token);
    return { work };
  }

  /** Live only: an unexpected exit is restarted after 1 s, the supervisor's first backoff step (§5.1). */
  private watch(a: Extract<Active, { kind: "live" }>): void {
    const hr = a.hr;
    void hr.proc!.exited.then(async (code) => {
      if (a.stopping || this.active !== a || a.hr !== hr) return;
      this.shell?.close();
      this.webview?.close();
      this.shell = this.webview = null;
      const retryAt = Date.now() + 1000;
      this.setStatus({ state: "restarting", retry_at: retryAt, last_error: `homerund exited (${hr.proc!.signalCode ?? code})` });
      await Bun.sleep(1000);
      if (a.stopping || this.active !== a) return;
      a.hr = new Homerund({ dataDir: a.dataDir, baseUrl: a.proxy.url, env: LIVE_ENV });
      this.restarts++;
      await a.hr.start();
      this.watch(a);
      await this.connect(a.hr.socketPath, a.hr.token);
    });
  }

  restarts = 0;

  /** Live only: the runtime's pid (for `kill -9`), the spend so far, and each thread's persisted seqs. */
  async liveInfo(): Promise<Record<string, unknown>> {
    const a = this.active;
    if (a?.kind !== "live") throw new Error("no live scene");
    const threads: Array<{ thread_id: string; seqs: number[] }> = [];
    if (this.shell?.isOpen) {
      const list = (await this.shell.raw("threads.list", {})) as { threads: Array<{ thread_id: string }> };
      for (const t of list.threads) {
        // Newest page first, ascending within a page.
        let seqs: number[] = [];
        let before: number | undefined;
        for (;;) {
          const page = (await this.shell.raw("threads.history", { thread_id: t.thread_id, limit: 500, ...(before !== undefined ? { before_seq: before } : {}) })) as {
            events: Array<{ seq: number }>;
            has_more: boolean;
          };
          seqs = [...page.events.map((e) => e.seq), ...seqs];
          if (!page.has_more || !page.events.length) break;
          before = page.events[0]!.seq;
        }
        threads.push({ thread_id: t.thread_id, seqs });
      }
    }
    return { pid: a.hr.proc?.pid ?? null, restarts: this.restarts, usd: a.proxy.usd, requests: a.proxy.requests, refused: a.proxy.refused, by_model: a.proxy.byModel, threads };
  }

  /** After a replay scene: every cassette entry was used and nothing unexpected was asked. */
  finish(): string[] {
    const a = this.active;
    if (a?.kind !== "replay") return [];
    a.server.finish({ claude: "", sdk: "", model: "", note: "" });
    if (a.server.errors.length) console.error(`homerund stderr (last 40 lines):\n${a.hr.stderr.split("\n").slice(-40).join("\n")}`);
    return a.server.errors;
  }

  // --- the Tauri commands (src-tauri/src/commands.rs) ---

  async command(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case "rpc_call": {
        const method = String(args.method);
        const params = args.params ?? {};
        if (!webviewAllows(method)) throw err("rpc", `The app may not call ${method}.`, -32003);
        if (typeof params !== "object" || params === null || Array.isArray(params)) throw err("rpc", "Params must be an object.", -32602);
        if (!this.webview?.isOpen) throw err("not_connected", "Homerun's runtime isn't running right now.");
        return this.webview.raw(method, params);
      }
      case "rpc_attach":
        return null;
      case "key_status": {
        const v = this.keys.get(API_KEY);
        return { present: v !== undefined, hint: v ? v.slice(-4) : null, store: "memory" };
      }
      case "key_set":
        return this.setKey(String(args.value ?? ""));
      case "key_clear":
        if (this.shell) await this.shell.call("secrets.clear", { name: API_KEY });
        this.keys.delete(API_KEY);
        return null;
      case "runtime_status":
        return this.status;
      case "runtime_restart":
        return null;
      case "open_external":
        this.opened.push(String(args.url));
        return null;
      case "reveal_logs":
        return null;
      case "app_info":
        return { version: "0.0.1-e2e", build: "debug", platform: "e2e", data_dir: this.active?.kind === "fake" ? this.active.srt.dir : "", log_path: "", key_store: "memory" };
      default:
        throw err("shell", `unknown command ${cmd}`);
    }
  }

  /** shell-core/src/keys.rs `set_key`. */
  private async setKey(value: string): Promise<unknown> {
    const key = value.trim();
    if (!key) throw err("shell", "Paste your API key.");
    if (/\s/.test(key)) throw err("shell", "An API key has no spaces or line breaks.");
    if (key.length < 20) throw err("shell", "That doesn't look like an API key.");
    if (!this.shell) {
      this.keys.set(API_KEY, key);
      return { outcome: "saved_unverified", detail: "Homerun's runtime isn't running, so the key wasn't checked yet." };
    }
    const v = (await this.shell.call("secrets.verify", { name: API_KEY, value: key })) as { outcome: string; detail?: string };
    if (v.outcome === "invalid") return { outcome: "rejected", detail: v.detail ?? "Anthropic didn't accept this key." };
    this.keys.set(API_KEY, key);
    await this.shell.call("secrets.set", { name: API_KEY, value: key });
    return v.outcome === "valid" ? { outcome: "saved" } : { outcome: "saved_unverified", detail: v.detail ?? "Anthropic couldn't be reached, so the key wasn't checked." };
  }
}

function err(kind: string, message: string, code: number | null = null, data: unknown = null): ShellErr {
  return { kind, code, message, data };
}

function toShellErr(e: unknown): ShellErr {
  if (e && typeof e === "object" && "kind" in e && "message" in e) return e as ShellErr;
  if (e instanceof RpcCallError) return err("rpc", e.message, e.code, e.data ?? null);
  if (e instanceof ConnectionClosedError || e instanceof RuntimeUnavailableError) return err("not_connected", "Homerun's runtime isn't running right now.");
  return err("shell", e instanceof Error ? e.message : String(e));
}

const shell = new Shell();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/bridge") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    if (url.pathname === "/__e2e/health") return Response.json({ ok: true });
    if (url.pathname === "/__e2e/scene" && req.method === "POST") {
      const body = (await req.json()) as { mode: "fake" | "replay" | "live"; key?: string | null; scenario?: string };
      try {
        const out =
          body.mode === "replay" ? await shell.replay(body.scenario ?? "") : body.mode === "live" ? await shell.live() : await shell.fake(body.key === undefined ? "sk-ant-mock-not-a-real-key" : body.key);
        shell.opened = [];
        return Response.json(out);
      } catch (e) {
        console.error(e);
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    if (url.pathname === "/__e2e/finish" && req.method === "POST") {
      const errors = shell.finish();
      await shell.stop();
      return Response.json({ errors });
    }
    if (url.pathname === "/__e2e/opened") return Response.json({ opened: shell.opened });
    if (url.pathname === "/__e2e/live") {
      try {
        return Response.json(await shell.liveInfo());
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    // The built views (scripts/build.ts --e2e).
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(join(DIST, normPath(path).replace(/^(\.\.[/\\])+/, "")));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      shell.pages.add(ws);
      // As `rpc_attach`: the current status first, then everything after it, in order.
      ws.send(JSON.stringify({ event: { type: "status", status: shell.status } }));
    },
    close(ws) {
      shell.pages.delete(ws);
    },
    async message(ws, raw) {
      const { id, cmd, args } = JSON.parse(String(raw)) as { id: number; cmd: string; args?: Record<string, unknown> };
      try {
        const ok = await shell.command(cmd, args ?? {});
        ws.send(JSON.stringify({ id, ok: ok ?? null }));
      } catch (e) {
        ws.send(JSON.stringify({ id, err: toShellErr(e) }));
      }
    },
  },
});

console.log(`e2e bridge on http://127.0.0.1:${server.port}`);
const quit = async () => {
  await shell.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void quit());
process.on("SIGINT", () => void quit());
