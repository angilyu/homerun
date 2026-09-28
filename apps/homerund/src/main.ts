/**
 * homerund — milestone-0 runtime (design §5.1). Compiled with `bun build --compile`.
 *
 *   homerund serve                 read launch token from stdin line 1, listen on the 0700 socket
 *   homerund version
 *   homerund keychain-read ACCOUNT   (internal; child of serve's timed startup read)
 *   homerund keychain-selftest [--data-protection] [--group G] [--read-only]
 *   homerund mcp-selftest npx|uvx [pkg[#bin]] [tool] [argsJSON]
 */
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Socket } from "bun";
import { dataDir, helperPath, socketPath } from "./paths";
import { openDb, ThreadLog } from "./store/db";
import { SqliteSessionStore } from "./store/sqlite-session-store";
import { InputQueue, startRun } from "./agent/run";
import { keychainGet, keychainSet, SEC_ERRORS, type KeychainOpts } from "./keychain";
import { mcpProbe, type McpProbeSpec } from "./mcp-probe";
import { PROTOCOL_VERSION } from "@homerun/core";

declare const HOMERUND_VERSION: string;
const VERSION = typeof HOMERUND_VERSION !== "undefined" ? HOMERUND_VERSION : "dev";
const PROTOCOL = PROTOCOL_VERSION;
const HANDSHAKE_TIMEOUT_MS = 2000;

const log = (msg: string, data?: unknown) =>
  console.log(`[homerund ${VERSION} pid=${process.pid}] ${msg}${data === undefined ? "" : " " + JSON.stringify(data)}`);

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const opt = (n: string) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);

/** Keychain item defaults. Access group = "<TeamID>.com.angilyu.homerun.shared" once we have a Team ID (§11). */
function kcOpts(account: string, over: Partial<KeychainOpts> = {}): KeychainOpts {
  const group = process.env.HOMERUN_KEYCHAIN_GROUP;
  return { service: "com.angilyu.homerun", account, accessGroup: group, dataProtection: !!group, ...over };
}
const kcStatus = (s: number) => ({ status: s, name: SEC_ERRORS[s] ?? "unknown" });

async function keychainReadTimed(account: string, timeoutMs: number) {
  const t0 = performance.now();
  const child = Bun.spawn([process.execPath, "keychain-read", account], { stdout: "pipe", stderr: "ignore", env: process.env });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const text = await new Response(child.stdout).text();
  await child.exited;
  clearTimeout(timer);
  const ms = Math.round(performance.now() - t0);
  if (child.signalCode === "SIGKILL") return { status: { status: null, name: "timeout" }, ms, timedOut: true };
  const r = JSON.parse(text || "{}") as { status: number; value?: string };
  return { status: kcStatus(r.status), value: r.value, ms, timedOut: false };
}

// ---------------------------------------------------------------- serve

async function serve() {
  const root = dataDir();
  const db = openDb(join(root, "homerun.db"));
  const store = new SqliteSessionStore(db);
  const threads = new ThreadLog(db);
  const active = new Map<string, { abort: AbortController; input: InputQueue }>();
  let shuttingDown = false;

  // 1. Launch token: first stdin line only (§5.2). Stdin EOF = shell asked us to stop.
  const reader = Bun.stdin.stream().getReader();
  let pending = "";
  let token = "";
  while (!token) {
    const { value, done } = await reader.read();
    if (done) {
      log("stdin closed before token; exiting");
      process.exit(2);
    }
    pending += new TextDecoder().decode(value);
    const nl = pending.indexOf("\n");
    if (nl >= 0) token = pending.slice(0, nl).trim();
  }
  const tokenBuf = Buffer.from(token);

  // 2. Single instance: if someone answers on the socket, another runtime owns it.
  const sock = socketPath(root);
  if (existsSync(sock)) {
    const alive = await Bun.connect({ unix: sock, socket: { data() {}, error() {} } }).then(
      (s) => (s.end(), true),
      () => false,
    );
    if (alive) {
      log("another homerund is serving; exiting", { sock });
      process.exit(3);
    }
    unlinkSync(sock);
  }

  // 3. Startup keychain read (§16.1 item 8: must not prompt after an update).
  // The legacy keychain ignores kSecUseAuthenticationUIFail and shows a modal ACL dialog when
  // the caller's designated requirement is not trusted, blocking SecItemCopyMatching until a
  // human answers. So read in a child process of this same binary (same code identity, same
  // ACL result) with a timeout: a timeout means "a prompt was shown".
  // It must not gate serving either (a prompt would stall the shell's first calls), so only
  // run starts wait for it.
  const keyReady = keychainReadTimed("anthropic-api-key", 5000).then((kc) => {
    log("startup keychain read", { account: "anthropic-api-key", ...kc.status, ms: kc.ms, prompted: kc.timedOut, dataProtection: !!process.env.HOMERUN_KEYCHAIN_GROUP });
    if (!process.env.ANTHROPIC_API_KEY && kc.value) process.env.ANTHROPIC_API_KEY = kc.value;
  });

  const setRun = (runId: string, fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    db.query(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE run_id = ?`).run(
      ...(Object.values(fields) as any[]),
      Date.now(),
      runId,
    );
  };

  async function drive(runId: string, resume?: { sessionId: string }) {
    await keyReady;
    const row = db.query<any, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId);
    const input = new InputQueue();
    input.push(
      resume
        ? "The Homerun runtime restarted (app update) while you were working. Any tool call that was in flight was interrupted and did not return. Check state and finish the original task."
        : row.prompt,
    );
    const { abort, messages } = startRun({
      prompt: input,
      cwd: row.cwd,
      sessionStore: store,
      dataRoot: root,
      resume: resume?.sessionId,
      tools: ["Bash"],
      canUseTool: async (_n, inp) => ({ behavior: "allow", updatedInput: inp }),
      stderr: (s) => log("claude stderr", s.slice(0, 300)),
    });
    active.set(runId, { abort, input });
    setRun(runId, { status: "running", runtime_pid: process.pid, runtime_version: VERSION, ...(resume ? { resumes: row.resumes + 1 } : {}) });
    threads.append(row.thread_id, runId, resume ? "run.resumed" : "run.started", { version: VERSION, pid: process.pid });
    try {
      for await (const m of messages) {
        if (m.type === "system" && m.subtype === "init") setRun(runId, { session_id: m.session_id });
        if (m.type === "assistant")
          for (const b of m.message.content as any[])
            if (b.type === "tool_use") threads.append(row.thread_id, runId, "tool.call", { tool_use_id: b.id, input: b.input });
        if (m.type === "result") {
          setRun(runId, { status: m.subtype === "success" ? "completed" : "failed", result: JSON.stringify({ subtype: m.subtype, result: (m as any).result, cost: m.total_cost_usd }) });
          threads.append(row.thread_id, runId, "run.completed", { subtype: m.subtype, version: VERSION });
          input.close();
        }
      }
    } catch (e) {
      if (shuttingDown) log("run interrupted by shutdown; will resume on next start", { runId });
      else {
        setRun(runId, { status: "failed", result: JSON.stringify({ error: String(e) }) });
        log("run failed", { runId, error: String(e) });
      }
    } finally {
      active.delete(runId);
    }
  }

  const methods: Record<string, (p: any) => unknown | Promise<unknown>> = {
    ping: () => ({ pong: true, version: VERSION, pid: process.pid, protocol: PROTOCOL }),
    "run.start": (p) => {
      const runId = crypto.randomUUID();
      const now = Date.now();
      db.query(
        "INSERT INTO runs (run_id, thread_id, status, prompt, cwd, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)",
      ).run(runId, p.thread_id ?? runId, String(p.prompt), p.cwd ?? root, now, now);
      void drive(runId);
      return { run_id: runId };
    },
    "run.list": () => db.query("SELECT run_id, status, session_id, runtime_version, resumes, result FROM runs ORDER BY created_at").all(),
    "keychain.set": (p) => kcStatus(keychainSet(kcOpts(p.account, p.opts), String(p.value))),
    "keychain.get": (p) => {
      const r = keychainGet(kcOpts(p.account, p.opts));
      return { ...kcStatus(r.status), length: r.value?.length ?? null };
    },
    "mcp.probe": (p: McpProbeSpec) => mcpProbe(p),
    // Spike-only (not in the shell's webview allowlist): can each bundled helper start as
    // a child of this hardened-runtime process? (§16.1 item 6, F4 options A/B)
    "helpers.check": () => helpersCheck(root),
  };

  // 4. Authenticated newline-JSON socket (§5.2).
  type Conn = { buf: string; authed: boolean; timer: Timer };
  const server = Bun.listen<Conn>({
    unix: sock,
    socket: {
      open(s) {
        s.data = {
          buf: "",
          authed: false,
          timer: setTimeout(() => !s.data.authed && s.end(), HANDSHAKE_TIMEOUT_MS),
        };
      },
      async data(s: Socket<Conn>, chunk) {
        s.data.buf += chunk.toString();
        let i;
        while ((i = s.data.buf.indexOf("\n")) >= 0) {
          const line = s.data.buf.slice(0, i);
          s.data.buf = s.data.buf.slice(i + 1);
          let req: any;
          try {
            req = JSON.parse(line);
          } catch {
            return void s.end();
          }
          const reply = (v: object) => s.write(JSON.stringify({ id: req.id, ...v }) + "\n");
          if (!s.data.authed) {
            const t = Buffer.from(String(req.params?.token ?? ""));
            const ok = req.method === "hello" && t.length === tokenBuf.length && timingSafeEqual(t, tokenBuf);
            if (!ok || req.params?.protocol !== PROTOCOL) {
              reply({ error: { code: 401, message: "unauthenticated" } });
              return void s.end();
            }
            s.data.authed = true;
            clearTimeout(s.data.timer);
            reply({ result: { version: VERSION, protocol: PROTOCOL } });
            continue;
          }
          const fn = methods[req.method];
          if (!fn) {
            reply({ error: { code: 404, message: `unknown method ${req.method}` } });
            continue;
          }
          try {
            reply({ result: await fn(req.params ?? {}) });
          } catch (e) {
            reply({ error: { code: 500, message: String(e) } });
          }
        }
      },
      close(s) {
        clearTimeout(s.data?.timer);
      },
    },
  });
  chmodSync(sock, 0o600);
  log("serving", { sock, version: VERSION, claude: helperPath("claude") });

  // 5. Crash/update resume (§5.4): runs left 'running' by a previous process.
  for (const r of db.query<any, []>("SELECT run_id, session_id FROM runs WHERE status = 'running'").all()) {
    if (!r.session_id) continue;
    log("resuming run", r);
    void drive(r.run_id, { sessionId: r.session_id });
  }

  // 6. Stdin EOF → checkpoint and exit (runs stay 'running' so the next start resumes them).
  (async () => {
    while (!(await reader.read()).done) {}
    shuttingDown = true;
    log("stdin EOF: shutting down", { active: active.size });
    for (const a of active.values()) a.abort.abort();
    server.stop(true);
    try {
      unlinkSync(sock);
    } catch {}
    db.close();
    setTimeout(() => process.exit(0), 200);
  })();
}

// ---------------------------------------------------------------- self-tests

function helpersCheck(root: string) {
  const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "/tmp" };
  const run = (name: "claude" | "node" | "uv", args: string[], extra: Record<string, string> = {}) => {
    let exe = "";
    try {
      exe = helperPath(name);
      const r = Bun.spawnSync([exe, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      return { name, exe, args, exitCode: r.exitCode, signal: r.signalCode ?? null, out: (r.stdout.toString() + r.stderr.toString()).trim().slice(0, 200) };
    } catch (e) {
      return { name, exe, args, error: String(e) };
    }
  };
  return [
    run("claude", ["--version"]),
    // Exercises claude's JS engine (JIT) with the private config dir, no network.
    run("claude", ["mcp", "list"], { CLAUDE_CONFIG_DIR: join(root, "claude-config") }),
    run("node", ["-e", "let s=0;for(let i=0;i<3e7;i++)s+=i;console.log(process.version)"]),
    run("uv", ["--version"]),
  ];
}

async function keychainSelftest() {
  const dp = flag("--data-protection");
  const o = kcOpts(opt("--account") ?? "selftest", { dataProtection: dp, accessGroup: opt("--group") });
  const out: Record<string, unknown> = { version: VERSION, exe: process.execPath, opts: o };
  if (!flag("--read-only")) out.set = kcStatus(keychainSet(o, `canary-${VERSION}-${Date.now()}`));
  const g = keychainGet(o);
  out.get = { ...kcStatus(g.status), value: g.value };
  console.log(JSON.stringify(out));
}

async function mcpSelftest() {
  const runner = (argv[1] ?? "npx") as "npx" | "uvx";
  const spec: McpProbeSpec =
    runner === "npx"
      ? { runner, pkg: (argv[2] ?? "mcp-server-sqlite@0.0.2").split("#")[0]!, bin: argv[2]?.split("#")[1], tool: argv[3] ?? "sqlite_version", toolArgs: argv[4] ? JSON.parse(argv[4]) : {} }
      : { runner, pkg: argv[2] ?? "mcp-server-time==2026.8.18", tool: argv[3] ?? "get_current_time", toolArgs: argv[4] ? JSON.parse(argv[4]) : { timezone: "UTC" } };
  const r = await mcpProbe(spec);
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}

const cmd = argv[0] ?? "serve";
if (cmd === "serve") await serve();
else if (cmd === "version") console.log(VERSION);
else if (cmd === "keychain-selftest") await keychainSelftest();
else if (cmd === "keychain-read") {
  // Internal: used by keychainReadTimed. Prints {status, value} on stdout for the parent only.
  const r = keychainGet(kcOpts(argv[1] ?? "anthropic-api-key"));
  process.stdout.write(JSON.stringify(r));
}
else if (cmd === "mcp-selftest") await mcpSelftest();
else {
  console.error(`unknown command ${cmd}`);
  process.exit(64);
}
