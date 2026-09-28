import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { PersistedThreadEvent, type ThreadEvent } from "@homerun/core";
import { groupAlive } from "../../src/agent/claude/spawn";
import type { RpcClient } from "../../src/rpc/client";
import { sessionSpec, uuid } from "../helpers";
import { HOMERUND_DIR, Homerund, REPLAY_KEY, Subscription, loadEnvLocal, scratchDir } from "./harness";
import { recordSpendUsd, ReplayServer, type Mode } from "./replay-server";
import type { Fingerprint } from "./cassette";

/**
 * The replay harness (§16.2). Each scenario drives a real `homerund serve` subprocess, with the
 * real bundled `claude`, over its socket, against the replay server standing in for the Messages
 * API. `HOMERUN_REPLAY=record` records the cassettes against the real API once (key from
 * `.env.local`, Haiku, capped spend); the default replays them with no key and no network.
 */
const MODE: Mode = process.env.HOMERUN_REPLAY === "record" ? "record" : "replay";
const CASSETTES = join(import.meta.dir, "cassettes");
const MODEL = "claude-haiku-4-5";
const SDK_PKG = JSON.parse(readFileSync(join(HOMERUND_DIR, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")) as { version: string; claudeCodeVersion: string };
const TIMEOUT = MODE === "record" ? 240_000 : 90_000;
const apiKey = MODE === "record" ? loadEnvLocal().ANTHROPIC_API_KEY : undefined;

type Persisted = Extract<ThreadEvent, { seq: number }>;
type Of<T extends string> = Extract<Persisted, { type: T }>;

interface Scene {
  root: string;
  work: string;
  server: ReplayServer;
  hr: Homerund;
  shell: RpcClient;
  /** Kill homerund (SIGKILL, like a crash) and start it again on the same data dir. */
  crashAndRestart(): Promise<void>;
  subscribe(threadId: string): Promise<Subscription>;
}

function sql<T>(hr: Homerund, q: string, ...args: Array<string | number | null>): T[] {
  const db = new Database(hr.dbPath, { readonly: true });
  try {
    return db.query(q).all(...args) as T[];
  } finally {
    db.close();
  }
}

async function until(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const lastHasToolResult = (fp: Fingerprint) => fp.messages.at(-1)?.blocks.some((b) => b.t === "tool_result") ?? false;

const scenes: Array<{ root: string; hr: Homerund }> = [];
afterAll(async () => {
  for (const s of scenes) {
    await s.hr.stop().catch(() => {});
    s.hr.cleanup();
  }
  if (MODE === "record") console.error(`recording spend (estimated from usage): $${recordSpendUsd().toFixed(4)}`);
});

async function scene(name: string, o: { forbid?: RegExp; home?: (root: string) => string; env?: (root: string) => Record<string, string>; note: string }, body: (s: Scene) => Promise<void>): Promise<void> {
  const root = scratchDir("hr-replay-");
  const work = join(root, "work");
  mkdirSync(work);
  const normalize: Array<[string, string]> = [
    [realpathSync(root), "<ROOT_REAL>"],
    [root, "<ROOT>"],
    [homedir(), "<HOME>"],
  ];
  if (userInfo().username.length >= 4) normalize.push([userInfo().username, "<USER>"]);
  const server = new ReplayServer({ mode: MODE, scenario: name, cassettePath: join(CASSETTES, `${name}.json`), apiKey, normalize, forbid: o.forbid, expectKey: REPLAY_KEY }).start();
  const opts = { dataDir: join(root, "data"), baseUrl: server.url, home: o.home?.(root), env: o.env?.(root) };
  mkdirSync(opts.dataDir, { recursive: true });
  let hr = new Homerund(opts);
  const entry = { root, hr };
  scenes.push(entry);
  try {
    await hr.start();
    const s: Scene = {
      root,
      work,
      server,
      hr,
      shell: await hr.shell(REPLAY_KEY),
      crashAndRestart: async () => {
        await hr.kill();
        hr = new Homerund(opts);
        entry.hr = hr;
        s.hr = hr;
        await hr.start();
        s.shell = await hr.shell(REPLAY_KEY);
      },
      subscribe: async (threadId) => {
        const sub = new Subscription(s.shell);
        await s.shell.call("threads.subscribe", { thread_id: threadId, after_seq: 0 });
        return sub;
      },
    };
    await body(s);
    await checkInvariants(s.hr);
    expect(server.errors).toEqual([]);
    server.finish({ claude: SDK_PKG.claudeCodeVersion, sdk: SDK_PKG.version, model: MODEL, note: o.note });
    expect(server.errors).toEqual([]);
  } catch (e) {
    if (server.errors.length) console.error(`replay server errors for ${name}:\n${server.errors.join("\n")}`);
    console.error(`homerund stderr (last 60 lines) for ${name}:\n${hr.stderr.split("\n").slice(-60).join("\n")}`);
    throw e;
  } finally {
    server.stop();
    await hr.stop().catch(() => {});
  }
}

/** Holds for every thread after every scenario: the §6/§6.1 write-path rules. */
async function checkInvariants(hr: Homerund): Promise<void> {
  const rows = sql<{ thread_id: string; seq: number; type: string; run_id: string | null; ts: number; payload: string }>(hr, "SELECT thread_id, seq, type, run_id, ts, payload FROM thread_events ORDER BY thread_id, seq");
  const byThread = new Map<string, number[]>();
  for (const r of rows) {
    expect(PersistedThreadEvent.safeParse({ ...r, payload: JSON.parse(r.payload) }).success).toBe(true);
    byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r.seq]);
  }
  for (const seqs of byThread.values()) expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  expect(rows.filter((r) => r.type === "message.delta" || r.type === "run.status")).toEqual([]);
  // One run.end per run, and nothing after it.
  const ends = new Map<string, number>();
  for (const r of rows) if (r.type === "run.end") ends.set(r.run_id!, (ends.get(r.run_id!) ?? 0) + 1);
  for (const n of ends.values()) expect(n).toBe(1);
  for (const r of rows) if (r.run_id && ends.has(r.run_id)) {
    const end = rows.find((x) => x.run_id === r.run_id && x.type === "run.end")!;
    expect(r.seq).toBeLessThanOrEqual(end.seq);
  }
  // Every tool.call of a finished run has exactly one tool.result.
  for (const c of rows.filter((r) => r.type === "tool.call" && ends.has(r.run_id!))) {
    const id = (JSON.parse(c.payload) as { tool_call_id: string }).tool_call_id;
    expect(rows.filter((r) => r.type === "tool.result" && (JSON.parse(r.payload) as { tool_call_id: string }).tool_call_id === id)).toHaveLength(1);
  }
  // Finished runs hold no process group once claude has exited and been reaped.
  const holding = () => sql(hr, "SELECT run_id FROM runs WHERE state <> 'running' AND (claude_pid IS NOT NULL OR reap_pgid IS NOT NULL)");
  await until(() => holding().length === 0, 8_000, "finished runs to release their process groups").catch(() => {});
  expect(holding()).toEqual([]);
}

function ofType<T extends Persisted["type"]>(sub: Subscription, type: T): Array<Of<T>> {
  return sub.persisted().filter((e): e is Of<T> => e.type === type);
}

async function runEnd(sub: Subscription, runId: string, timeoutMs = TIMEOUT - 10_000): Promise<Of<"run.end">> {
  return (await sub.waitFor((e) => e.type === "run.end" && e.run_id === runId, timeoutMs, `run.end of ${runId}`)) as Of<"run.end">;
}

async function task(s: Scene, spec: Parameters<typeof sessionSpec>[0]): Promise<string> {
  const created = await s.shell.call("tasks.create", { spec: sessionSpec({ max_run_usd: 0.05, roots: [s.work], ...spec }) as never });
  return created.thread_id;
}

const send = (s: Scene, threadId: string, text: string) => s.shell.call("messages.send", { thread_id: threadId, client_msg_id: uuid(), text });

function blobText(hr: Homerund, sha256: string): string {
  const [row] = sql<{ bytes: Uint8Array; size: number }>(hr, "SELECT bytes, size FROM blobs WHERE sha256 = ?", sha256);
  expect(row).toBeDefined();
  return new TextDecoder().decode(row!.bytes);
}

function outputText(hr: Homerund, r: Of<"tool.result">): string {
  const o = r.payload.output;
  if (!o) return "";
  return o.kind === "blob" ? blobText(hr, o.sha256) : JSON.stringify(o.value);
}

/** Commands of live processes started under the scene root (a snapshot path names it) that contain `needle`. */
function liveCommands(root: string, needle: string): string[] {
  const out = Bun.spawnSync(["/bin/ps", "-Aww", "-o", "command="]).stdout.toString();
  return out.split("\n").filter((c) => c.includes(needle) && (c.includes(root) || c.includes(realpathSync(root))));
}

describe(`replay (${MODE})`, () => {
  if (MODE === "record" && !apiKey) throw new Error("HOMERUN_REPLAY=record needs ANTHROPIC_API_KEY in .env.local");

  test(
    "a text-only chat turn streams deltas, then persists the final message and the run",
    () =>
      scene("text-chat", { note: "A chat turn with no tool use." }, async (s) => {
        const { thread } = await s.shell.call("threads.create", { title: "text" });
        const sub = await s.subscribe(thread.thread_id);
        const sent = await send(s, thread.thread_id, "In two short sentences, what is a home run in baseball? Do not use any tools.");
        expect(sent.disposition).toBe("started_run");
        const end = await runEnd(sub, sent.run_id);
        expect(end.payload.state).toBe("succeeded");
        expect(end.payload.cost_usd).toBeGreaterThan(0);

        const finals = ofType(sub, "message.final");
        expect(finals.length).toBeGreaterThanOrEqual(1);
        const last = finals.at(-1)!;
        expect(last.payload.text.length).toBeGreaterThan(20);
        const deltas = sub.events.filter((e): e is Extract<ThreadEvent, { type: "message.delta" }> => e.type === "message.delta" && e.payload.message_id === last.payload.message_id);
        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.map((d) => d.payload.index)).toEqual(deltas.map((_, i) => i));
        expect(deltas.map((d) => d.payload.text).join("")).toBe(last.payload.text);
        expect(sub.events.indexOf(deltas[0]!)).toBeLessThan(sub.events.indexOf(last));
        expect(sub.persisted().map((e) => e.type)).toEqual(["user.message", "run.started", ...finals.map(() => "message.final" as const), "run.end"]);

        const history = await s.shell.call("threads.history", { thread_id: thread.thread_id });
        expect(history.events.map((e) => e.seq)).toEqual(sub.persisted().map((e) => e.seq));
        const [run] = sql<{ state: string; cost_usd: number; sdk_session_id: string }>(s.hr, "SELECT state, cost_usd, sdk_session_id FROM runs WHERE run_id = ?", sent.run_id);
        expect(run).toMatchObject({ state: "succeeded" });
        // The session lives in SQLite (F1).
        expect(sql(s.hr, "SELECT 1 FROM sdk_transcripts WHERE session_id = ?", run!.sdk_session_id).length).toBeGreaterThan(0);
      }),
    TIMEOUT,
  );

  test(
    "a Bash turn: tool.call and tool.result, a large output goes to blobs, HOME is the shell home",
    () =>
      scene("bash-tool", { note: "A session task that runs one Bash command with a 14 KB output." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const sent = await send(s, threadId, 'Run exactly this bash command once, unchanged: echo homerun > out.txt && echo "home=$HOME" && seq 1 3000\nThen reply with just the word done.');
        const end = await runEnd(sub, sent.run_id);
        expect(end.payload.state).toBe("succeeded");

        const [call] = ofType(sub, "tool.call");
        expect(call!.payload).toMatchObject({ tool: "Bash", class: "destructive", policy: "needs_approval" });
        const [result] = ofType(sub, "tool.result");
        expect(result!.payload).toMatchObject({ tool_call_id: call!.payload.tool_call_id, status: "ok" });
        expect(result!.payload.output?.kind).toBe("blob");
        const out = outputText(s.hr, result!);
        expect(out).toContain(`home=${join(s.hr.dataDir, "shell-home")}`);
        expect(out).toContain("2999");
        expect(readFileSync(join(s.work, "out.txt"), "utf8")).toBe("homerun\n");
        expect(sub.persisted().indexOf(call!)).toBeLessThan(sub.persisted().indexOf(result!));
      }),
    TIMEOUT,
  );

  test(
    "an MCP tool turn: the spec's stdio server is attached with strictMcpConfig",
    () =>
      scene("mcp-tool", { note: "A session task whose only tool is the fixture MCP server." }, async (s) => {
        const threadId = await task(s, {
          builtin: [],
          mcp_servers: [{ id: "fixture", transport: "stdio", runner: "npx", package: "fixture-mcp", version: "1.0.0", args: [], env: {} }],
        });
        const sub = await s.subscribe(threadId);
        const sent = await send(s, threadId, "Use the lookup_word tool to look up the word homerun, then quote the definition it returns.");
        const end = await runEnd(sub, sent.run_id);
        expect(end.payload.state).toBe("succeeded");
        const [call] = ofType(sub, "tool.call");
        expect(call!.payload).toMatchObject({ tool: "mcp__fixture__lookup_word", mcp_server: "fixture" });
        const [result] = ofType(sub, "tool.result");
        expect(result!.payload.status).toBe("ok");
        expect(outputText(s.hr, result!)).toContain("circle all the bases");
        expect(ofType(sub, "message.final").at(-1)!.payload.text).toContain("bases");
      }),
    TIMEOUT,
  );

  test(
    "steering: a second message during a run is pushed into it (R8)",
    () =>
      scene("steering", { note: "A second message sent while the first turn's Bash command runs." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const first = await send(s, threadId, "Run the bash command `sleep 4; echo slept` once, then tell me what it printed.");
        await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call");
        const second = await send(s, threadId, "Also: what is 17 + 25? Answer in the same reply.");
        expect(second).toMatchObject({ disposition: "steered", run_id: first.run_id });
        const end = await runEnd(sub, first.run_id);
        expect(end.payload.state).toBe("succeeded");
        expect(ofType(sub, "run.end")).toHaveLength(1);
        expect(ofType(sub, "run.started")).toHaveLength(1);
        const users = ofType(sub, "user.message");
        expect(users.map((u) => u.payload.disposition)).toEqual(["started_run", "steered"]);
        expect(users.every((u) => u.run_id === first.run_id)).toBe(true);
        const text = ofType(sub, "message.final").map((m) => m.payload.text).join("\n");
        expect(text).toContain("42");
        // claude consumed the steer: nothing is left pending for the next run.
        expect(sql(s.hr, "SELECT 1 FROM run_inputs WHERE run_id = ? AND consumed_at IS NULL", first.run_id)).toEqual([]);
      }),
    TIMEOUT,
  );

  test(
    "kill and resume: a run killed between turns resumes from the SQLite session",
    () =>
      scene("kill-resume", { note: "homerund is SIGKILLed after a tool result, before the next turn; it resumes on restart." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const held = s.server.hold(lastHasToolResult);
        const sent = await send(s, threadId, "Run the bash command `echo ran >> side.log` exactly once, then reply with just the word done.");
        await held;
        await sub.waitFor((e) => e.type === "tool.result", 10_000, "tool.result");
        const [before] = sql<{ claude_pid: number; sdk_session_id: string }>(s.hr, "SELECT claude_pid, sdk_session_id FROM runs WHERE run_id = ?", sent.run_id);
        expect(before!.claude_pid).toBeGreaterThan(0);
        await until(() => sql(s.hr, "SELECT 1 FROM sdk_transcripts WHERE session_id = ? AND entry LIKE '%tool_result%'", before!.sdk_session_id).length > 0, 10_000, "the tool result in sdk_transcripts");

        await s.crashAndRestart();
        expect(groupAlive(before!.claude_pid)).toBe(false);
        // The tool's shell runs in its own group and outlives claude (F8); startup must kill it too.
        expect(liveCommands(s.root, "echo ran >> side.log")).toEqual([]);
        const sub2 = await s.subscribe(threadId);
        const end = await runEnd(sub2, sent.run_id);
        expect(end.payload.state).toBe("succeeded");
        const resumed = ofType(sub2, "run.resumed");
        expect(resumed.map((e) => e.payload.reason)).toEqual(["runtime_restart"]);
        expect(ofType(sub2, "run.started")).toHaveLength(1);
        expect(ofType(sub2, "tool.call")).toHaveLength(1);
        expect(readFileSync(join(s.work, "side.log"), "utf8")).toBe("ran\n");
        const [after] = sql<{ sdk_session_id: string; attempt: number }>(s.hr, "SELECT sdk_session_id, attempt FROM runs WHERE run_id = ?", sent.run_id);
        expect(after!.sdk_session_id).toBe(before!.sdk_session_id);
      }),
    TIMEOUT,
  );

  test(
    "kill mid-tool: an ambiguous destructive call parks the run in waiting_input (§5.4)",
    () =>
      scene("kill-mid-tool", { note: "homerund is SIGKILLed while a destructive Bash command runs; the run waits for 'Did this happen?'." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const sent = await send(s, threadId, "Run the bash command `sleep 20 && echo ran >> side.log` exactly once, then reply with just the word done.");
        const call = (await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call")) as Of<"tool.call">;
        await Bun.sleep(750);
        const [before] = sql<{ claude_pid: number }>(s.hr, "SELECT claude_pid FROM runs WHERE run_id = ?", sent.run_id);
        const requestsBefore = s.server.messageRequests;

        await s.crashAndRestart();
        expect(groupAlive(before!.claude_pid)).toBe(false);
        // The tool's shell runs in its own group and outlives claude (F8); startup must kill it too.
        expect(liveCommands(s.root, "echo ran >> side.log")).toEqual([]);
        const sub2 = await s.subscribe(threadId);
        const asked = (await sub2.waitFor((e) => e.type === "input.requested", 10_000, "input.requested")) as Of<"input.requested">;
        expect(asked.payload.prompt).toMatchObject({ type: "ambiguous_tool_call", tool: "Bash", tool_call_id: call.payload.tool_call_id });
        expect(asked.payload.required_authority).toBe("full");
        expect((await s.shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("waiting_input");
        expect(ofType(sub2, "tool.result")).toEqual([]);
        const pending = await s.shell.call("input.list_pending", { thread_id: threadId });
        expect(pending.requests.map((r) => r.request_id)).toEqual([asked.payload.request_id]);

        // A message now is held for the answer; nothing reaches the model.
        expect((await send(s, threadId, "Status?")).disposition).toBe("held");
        await Bun.sleep(1500);
        expect(s.server.messageRequests).toBe(requestsBefore);
        expect(existsSync(join(s.work, "side.log"))).toBe(false);
        // Answering it is milestone 4: input.answer says so.
        await expect(s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "ambiguous_tool_call", outcome: "not_run" }, via: "app" } as never)).rejects.toMatchObject({ data: { not_implemented: true } });
      }),
    TIMEOUT,
  );

  test(
    "runs.stop during a tool call: the call finishes, then the process group is killed and the run ends cancelled",
    () =>
      scene("stop", { note: "A run stopped while its Bash command runs; stop waits for the call (§5.7)." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        void s.server.hold(lastHasToolResult);
        const sent = await send(s, threadId, "Run the bash command `sleep 2; echo once >> side.log` exactly once, then reply with just the word done.");
        await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call");
        const [before] = sql<{ claude_pid: number }>(s.hr, "SELECT claude_pid FROM runs WHERE run_id = ?", sent.run_id);
        expect(await s.shell.call("runs.stop", { run_id: sent.run_id })).toEqual({ state: "running" });
        const end = await runEnd(sub, sent.run_id, 20_000);
        expect(end.payload.state).toBe("cancelled");
        expect(ofType(sub, "run.cancelled").map((e) => e.payload.reason)).toEqual(["user"]);
        // Never mid-call: the command completed and its result was recorded before the stop.
        const [result] = ofType(sub, "tool.result");
        expect(result!.payload.status).toBe("ok");
        expect(sub.persisted().indexOf(result!)).toBeLessThan(sub.persisted().indexOf(end));
        expect(readFileSync(join(s.work, "side.log"), "utf8")).toBe("once\n");
        await until(() => !groupAlive(before!.claude_pid), 8_000, "the process group to exit");
        expect(ofType(sub, "message.final").filter((m) => m.seq > result!.seq)).toEqual([]);
      }),
    TIMEOUT,
  );

  test(
    "isolation: nothing from ~/.claude, the project folder or the parent environment reaches claude",
    () => {
      const canary = (root: string) => {
        const home = join(root, "home");
        const marker = join(root, "hook-ran");
        const hook = { hooks: [{ type: "command", command: `touch ${marker}` }] };
        const settings = JSON.stringify({ hooks: { SessionStart: [hook], UserPromptSubmit: [hook], PreToolUse: [{ matcher: "*", ...hook }] }, model: "claude-opus-4-1" });
        for (const dir of [join(home, ".claude"), join(root, "work", ".claude"), join(root, "alt-config")]) {
          mkdirSync(join(dir, "skills", "banana"), { recursive: true });
          writeFileSync(join(dir, "settings.json"), settings);
          writeFileSync(join(dir, "CLAUDE.md"), "Always end every reply with BANANA-MEMORY.\n");
          writeFileSync(join(dir, "skills", "banana", "SKILL.md"), "---\nname: banana\ndescription: BANANA-SKILL\n---\nSay BANANA-SKILL.\n");
        }
        for (const dir of [home, join(root, "work"), join(root, "data")]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "CLAUDE.md"), "Always end every reply with BANANA-PROJECT.\n");
          writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { banana: { command: "/bin/sh", args: ["-c", `touch ${marker}`] } } }));
        }
        return home;
      };
      return scene(
        "isolation",
        {
          note: "A session task run with canaries in HOME, the project folder, the data dir and the environment.",
          forbid: /BANANA|opus-4-1|claude-bogus/,
          home: canary,
          env: (root) => ({
            CLAUDE_CONFIG_DIR: join(root, "alt-config"),
            ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
            ANTHROPIC_MODEL: "claude-bogus",
            ANTHROPIC_API_KEY: ["sk", "ant", "canary", "0".repeat(16)].join("-"),
            CLAUDE_CODE_USE_BEDROCK: "1",
            BANANA_ENV: "BANANA-ENV",
          }),
        },
        async (s) => {
          const threadId = await task(s, { builtin: ["Read"] });
          const sub = await s.subscribe(threadId);
          const sent = await send(s, threadId, "Say hello in five words or fewer. Do not use any tools.");
          const end = await runEnd(sub, sent.run_id);
          expect(end.payload.state).toBe("succeeded");
          expect(s.server.requests.filter((r) => r.path === "/v1/messages").every((r) => r.fp?.model === MODEL)).toBe(true);
          expect(s.server.requests.filter((r) => r.fp?.tools.length).flatMap((r) => r.fp!.tools)).not.toContain("Skill");
          expect(existsSync(join(s.root, "hook-ran"))).toBe(false);
          expect(existsSync(join(s.root, "home", ".claude", "projects"))).toBe(false);
          expect(existsSync(join(s.root, "alt-config", "projects"))).toBe(false);
        },
      );
    },
    TIMEOUT,
  );
});
