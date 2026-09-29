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
 */
import type { ServerWebSocket } from "bun";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
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
  | { kind: "replay"; name: string; hr: Homerund; server: ReplayServer; root: string };

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
    else {
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
      const body = (await req.json()) as { mode: "fake" | "replay"; key?: string | null; scenario?: string };
      try {
        const out = body.mode === "replay" ? await shell.replay(body.scenario ?? "") : await shell.fake(body.key === undefined ? "sk-ant-mock-not-a-real-key" : body.key);
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
