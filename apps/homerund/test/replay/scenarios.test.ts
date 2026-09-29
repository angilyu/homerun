import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { PersistedThreadEvent, RPC_ERROR, undeliveredMessages, type ThreadEvent } from "@homerun/core";
import { groupAlive } from "../../src/agent/claude/spawn";
import type { RpcClient } from "../../src/rpc/client";
import { monitorSpec, sessionSpec, uuid } from "../helpers";
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
/**
 * Scenarios added since milestone 4 run once their cassette is recorded (recording spends real
 * money, so it waits for the key); until then replay skips them.
 */
const recorded = (name: string) => MODE === "record" || existsSync(join(CASSETTES, `${name}.json`));
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

/**
 * Wait until the call is in the stored transcript. claude mirrors its transcript a little after the
 * fact (on a slow machine, after the command's effect); a scene that resumes the session after a
 * crash is about a call the store shows, so it must not crash before then.
 */
async function callStored(s: Scene, runId: string, toolCallId: string): Promise<void> {
  const stored = () =>
    sql<{ n: number }>(s.hr, "SELECT count(*) AS n FROM sdk_transcripts t JOIN runs r ON t.session_id = r.sdk_session_id WHERE r.run_id = ? AND t.entry LIKE ?", runId, `%"id":"${toolCallId}"%`)[0]!.n > 0;
  await until(stored, 10_000, "the call in the stored transcript");
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

async function scene(name: string, o: { forbid?: RegExp; home?: (root: string) => string; env?: (root: string) => Record<string, string>; gapMs?: number; normalize?: Array<[string, string]>; note: string }, body: (s: Scene) => Promise<void>): Promise<void> {
  const root = scratchDir("hr-replay-");
  const work = join(root, "work");
  mkdirSync(work);
  const normalize: Array<[string, string]> = [
    [realpathSync(root), "<ROOT_REAL>"],
    [root, "<ROOT>"],
    [homedir(), "<HOME>"],
    ...(o.normalize ?? []),
  ];
  if (userInfo().username.length >= 4) normalize.push([userInfo().username, "<USER>"]);
  const server = new ReplayServer({ mode: MODE, scenario: name, cassettePath: join(CASSETTES, `${name}.json`), apiKey, normalize, forbid: o.forbid, expectKey: REPLAY_KEY, gapMs: o.gapMs }).start();
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

async function askedFor(sub: Subscription, call: Of<"tool.call">): Promise<Of<"input.requested">> {
  const asked = (await sub.waitFor((e) => e.type === "input.requested", 10_000, "input.requested")) as Of<"input.requested">;
  expect(asked.payload.prompt).toMatchObject({ type: "ambiguous_tool_call", tool: "Bash", tool_call_id: call.payload.tool_call_id });
  expect(asked.payload.required_authority).toBe("full");
  return asked;
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

/** A local page for monitor checks to observe; its URL is normalised out of cassettes. */
function statusPage(initial: string) {
  let body = initial;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { headers: { "content-type": "text/plain" } }) });
  const url = `http://127.0.0.1:${server.port}/status`;
  return { url, set: (b: string) => (body = b), stop: () => server.stop(true), normalize: [[url, "https://status.example.com/status"]] as Array<[string, string]> };
}

/** A monitor whose model check judges the status page, with no tools (§8.3). */
function statusMonitor(url: string) {
  return {
    ...monitorSpec({
      name: "Example status",
      schedule: { kind: "cron", cron: "0 0 1 1 *", timezone: "UTC", catchup: "skip", max_catchup: 1 },
      check: {
        kind: "model",
        model: "haiku",
        instructions: 'Save the status line as new_state, as {"status": "<the line>"}. Report changed only if it differs from the saved status.',
        source: { type: "http", url, extract: { kind: "body" } },
      },
      max_run_usd: 0.1,
      act_instructions: "Do not use any tools. Reply with one sentence saying what the status is now.",
    }),
    prompt: "Tell me when the Example service's status changes.",
    tools: { builtin: [], mcp_servers: [], homerun: [] },
  };
}

type MonitorRun = { state: string; error: string | null; outcome: string | null; check_result: string | null; cost_usd: number | null; monitor_phase: string | null };

/** A quiet check writes no thread events, so wait on the run row itself. */
async function monitorRun(s: Scene, runId: string): Promise<MonitorRun> {
  const row = () => sql<MonitorRun>(s.hr, "SELECT state, error, outcome, check_result, cost_usd, monitor_phase FROM runs WHERE run_id = ?", runId)[0];
  await until(() => ["succeeded", "failed", "cancelled", "abandoned"].includes(row()?.state ?? ""), TIMEOUT - 10_000, `monitor run ${runId}`);
  return row()!;
}

const monitorState = (s: Scene, taskId: string) =>
  sql<{ state: string; version: number; last_run_id: string }>(s.hr, "SELECT state, version, last_run_id FROM monitor_state WHERE task_id = ?", taskId)[0] ?? null;

/** The model check's requests: their first message is the check prompt (`checkPrompt`). */
function checkRequests(s: Scene) {
  return s.server.requests.filter((r) => {
    const first = r.fp?.messages[0]?.blocks[0];
    return r.path === "/v1/messages" && first?.t === "text" && first.text.startsWith("Monitor: ");
  });
}

describe(`replay (${MODE})`, () => {
  if (MODE === "record" && !apiKey) throw new Error("HOMERUN_REPLAY=record needs ANTHROPIC_API_KEY in .env.local");

  test(
    "a text-only chat turn streams deltas, then persists the final message and the run",
    () =>
      // Stream slowly enough that the text spans several delta windows even on a loaded machine.
      scene("text-chat", { note: "A chat turn with no tool use.", gapMs: 25 }, async (s) => {
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
    "steering: a second message during a run is pushed into it (§5.7)",
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
        // The mirrored tool_result entry itself (not just any entry naming it: the prompt snapshot
        // does). Without this wait the crash races the mirror, and the resumed request differs.
        const mirrored = () =>
          sql<{ entry: string }>(s.hr, "SELECT entry FROM sdk_transcripts WHERE session_id = ? AND json_extract(entry, '$.type') = 'user'", before!.sdk_session_id).some((r) => {
            const content = (JSON.parse(r.entry) as { message?: { content?: unknown } }).message?.content;
            return Array.isArray(content) && content.some((b: { type?: string; is_error?: boolean }) => b.type === "tool_result" && !b.is_error);
          });
        await until(mirrored, 10_000, "the tool result in sdk_transcripts");

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
    "kill mid-tool: an ambiguous destructive call parks the run; stopping it gives the call an 'outcome unknown' result (§5.4)",
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
        const asked = await askedFor(sub2, call);
        expect((await s.shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("waiting_input");
        expect(ofType(sub2, "tool.result")).toEqual([]);
        const pending = await s.shell.call("input.list_pending", { thread_id: threadId });
        expect(pending.requests.map((r) => r.request_id)).toEqual([asked.payload.request_id]);

        // A message now is held for the answer; nothing reaches the model.
        expect((await send(s, threadId, "Status?")).disposition).toBe("held");
        await Bun.sleep(1500);
        expect(s.server.messageRequests).toBe(requestsBefore);
        expect(existsSync(join(s.work, "side.log"))).toBe(false);
        // "Did this happen?" needs the full app: not a lock-screen action.
        await expect(
          s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "ambiguous_tool_call", outcome: "not_run" }, via: "notification" }),
        ).rejects.toMatchObject({ code: RPC_ERROR.AUTHORITY_INSUFFICIENT });

        // Stopped unanswered, the call gets a result that says its outcome is unknown.
        expect(await s.shell.call("runs.stop", { run_id: sent.run_id })).toEqual({ state: "cancelled" });
        const result = (await sub2.waitFor((e) => e.type === "tool.result", 5_000, "tool.result")) as Of<"tool.result">;
        expect(result.payload).toMatchObject({ tool_call_id: call.payload.tool_call_id, status: "error" });
        expect(await s.shell.call("input.list_pending", { thread_id: threadId })).toEqual({ requests: [] });
        expect(s.server.messageRequests).toBe(requestsBefore);
        // The held message was never delivered, and clients show it that way (§5.7).
        await runEnd(sub2, sent.run_id, 5_000);
        expect(undeliveredMessages(sub2.persisted()).map((e) => e.payload.text)).toEqual(["Status?"]);
      }),
    TIMEOUT,
  );

  test.skipIf(!recorded("ambiguity-completed"))(
    "answered 'completed': the answer becomes the call's result and the run resumes with the held message (§5.4)",
    () =>
      scene(
        "ambiguity-completed",
        { note: "homerund is SIGKILLed while a destructive Bash command runs; the user answers 'Did this happen?' with completed, and a held message follows." },
        async (s) => {
          const threadId = await task(s, { builtin: ["Bash"] });
          const sub = await s.subscribe(threadId);
          const sent = await send(s, threadId, "Run the bash command `echo ran >> side.log && sleep 20` exactly once, then reply with just the word done.");
          const call = (await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call")) as Of<"tool.call">;
          const log = join(s.work, "side.log");
          await until(() => existsSync(log) && readFileSync(log, "utf8") === "ran\n", 10_000, "the command's effect");
          await callStored(s, sent.run_id, call.payload.tool_call_id);
          const [before] = sql<{ claude_pid: number }>(s.hr, "SELECT claude_pid FROM runs WHERE run_id = ?", sent.run_id);
          const requestsBefore = s.server.messageRequests;

          await s.crashAndRestart();
          expect(groupAlive(before!.claude_pid)).toBe(false);
          // The tool's shell runs in its own group and outlives claude (F8); startup must kill it too.
          expect(liveCommands(s.root, "sleep 20")).toEqual([]);
          const sub2 = await s.subscribe(threadId);
          const asked = await askedFor(sub2, call);
          expect((await s.shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("waiting_input");
          expect(ofType(sub2, "tool.result")).toEqual([]);
          const pending = await s.shell.call("input.list_pending", { thread_id: threadId });
          expect(pending.requests.map((r) => r.request_id)).toEqual([asked.payload.request_id]);

          // A message now is held for the answer; nothing reaches the model.
          expect((await send(s, threadId, "Status?")).disposition).toBe("held");
          await Bun.sleep(1500);
          expect(s.server.messageRequests).toBe(requestsBefore);
          // "Did this happen?" needs the full app: not a lock-screen action.
          const answer = (outcome: "completed" | "not_run", via: "app" | "notification" = "app") =>
            s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "ambiguous_tool_call", outcome }, via });
          await expect(answer("completed", "notification")).rejects.toMatchObject({ code: RPC_ERROR.AUTHORITY_INSUFFICIENT });
          expect(await answer("completed")).toEqual({ status: "applied" });
          expect(await answer("not_run")).toMatchObject({ status: "already_resolved", state: "answered" });

          const end = await runEnd(sub2, sent.run_id);
          expect(end.payload.state).toBe("succeeded");
          expect(ofType(sub2, "run.resumed").map((e) => e.payload.reason)).toEqual(["ambiguity_resolved"]);
          expect(ofType(sub2, "tool.call")).toHaveLength(1);
          expect(ofType(sub2, "tool.result").map((e) => e.payload.status)).toEqual(["resolved_completed"]);
          expect(ofType(sub2, "input.resolved").map((e) => e.payload.response)).toEqual([{ type: "ambiguous_tool_call", outcome: "completed" }]);
          // Told the call completed, the model does not run it again.
          expect(readFileSync(log, "utf8")).toBe("ran\n");
          expect(ofType(sub2, "message.final").length).toBeGreaterThan(0);
          // The held message reached the model with the answer.
          expect(undeliveredMessages(sub2.persisted())).toEqual([]);
          expect(sql<{ n: number }>(s.hr, "SELECT COUNT(*) AS n FROM sdk_transcripts WHERE instr(entry, 'Status?') > 0")[0]!.n).toBeGreaterThan(0);
        },
      ),
    TIMEOUT,
  );

  test.skipIf(!recorded("kill-claude-mid-tool"))(
    "claude killed mid-tool: its orphaned shell is killed; answered 'not run', the call runs again once (§5.4)",
    () =>
      scene("kill-claude-mid-tool", { note: "claude is SIGKILLed while a destructive Bash command runs; the user answers 'Did this happen?' with not run." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const sent = await send(s, threadId, "Run the bash command `sleep 20 && echo ran >> side.log` exactly once, then reply with just the word done.");
        const call = (await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call")) as Of<"tool.call">;
        await until(() => liveCommands(s.root, "sleep 20").length > 0, 10_000, "the tool's shell");
        await callStored(s, sent.run_id, call.payload.tool_call_id);
        const [before] = sql<{ claude_pid: number }>(s.hr, "SELECT claude_pid FROM runs WHERE run_id = ?", sent.run_id);
        process.kill(before!.claude_pid, "SIGKILL");

        const asked = await askedFor(sub, call);
        // claude is gone, and so is the shell it left behind in its session.
        await until(() => liveCommands(s.root, "sleep 20").length === 0, 5_000, "the orphaned shell to be killed");
        expect(existsSync(join(s.work, "side.log"))).toBe(false);
        expect((await s.shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("waiting_input");
        expect(await s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "ambiguous_tool_call", outcome: "not_run" }, via: "app" })).toEqual({
          status: "applied",
        });

        const end = await runEnd(sub, sent.run_id);
        expect(end.payload.state).toBe("succeeded");
        expect(ofType(sub, "run.resumed").map((e) => e.payload.reason)).toEqual(["ambiguity_resolved"]);
        const results = ofType(sub, "tool.result");
        expect(results[0]!.payload).toMatchObject({ tool_call_id: call.payload.tool_call_id, status: "resolved_not_run" });
        // Told the call did not run, the model runs it again, once.
        expect(ofType(sub, "tool.call")).toHaveLength(2);
        expect(results.map((r) => r.payload.status)).toEqual(["resolved_not_run", "ok"]);
        expect(readFileSync(join(s.work, "side.log"), "utf8")).toBe("ran\n");
      }),
    TIMEOUT,
  );

  test.skipIf(!recorded("ambiguity-truncate"))(
    "truncate mode: the resume starts before the ambiguous call and the note says what happened (§5.4 fallback)",
    () =>
      scene(
        "ambiguity-truncate",
        { note: "As kill-mid-tool, with HOMERUN_DEV_AMBIGUITY_MODE=truncate: claude resumes at the message before the call.", env: () => ({ HOMERUN_DEV_AMBIGUITY_MODE: "truncate" }) },
        async (s) => {
          const threadId = await task(s, { builtin: ["Bash"] });
          const sub = await s.subscribe(threadId);
          const sent = await send(s, threadId, "Run the bash command `echo ran >> side.log && sleep 20` exactly once, then reply with just the word done.");
          const call = (await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call")) as Of<"tool.call">;
          const log = join(s.work, "side.log");
          await until(() => existsSync(log) && readFileSync(log, "utf8") === "ran\n", 10_000, "the command's effect");
          await callStored(s, sent.run_id, call.payload.tool_call_id);

          await s.crashAndRestart();
          const sub2 = await s.subscribe(threadId);
          const asked = await askedFor(sub2, call);
          await s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "ambiguous_tool_call", outcome: "completed" }, via: "app" });
          const end = await runEnd(sub2, sent.run_id);
          expect(end.payload.state).toBe("succeeded");
          expect(ofType(sub2, "tool.call")).toHaveLength(1);
          expect(readFileSync(log, "utf8")).toBe("ran\n");
          // The resumed conversation branches from before the assistant message with the call.
          const [row] = sql<{ sdk_session_id: string; resume_at: string | null }>(s.hr, "SELECT sdk_session_id, resume_at FROM runs WHERE run_id = ?", sent.run_id);
          expect(row!.resume_at).toBeNull();
          const results = sql<{ n: number }>(s.hr, "SELECT count(*) AS n FROM sdk_transcripts WHERE session_id = ? AND entry LIKE ?", row!.sdk_session_id, `%"tool_use_id":"${call.payload.tool_call_id}"%`);
          expect(results[0]!.n).toBe(0);
        },
      ),
    TIMEOUT,
  );

  test.skipIf(!recorded("cancel-parked"))(
    "stopping a parked run: the call gets an 'outcome unknown' result, and the next turn sees it (§5.4)",
    () =>
      scene("cancel-parked", { note: "A run parked on 'Did this happen?' is stopped; a follow-up turn in the same thread." }, async (s) => {
        const threadId = await task(s, { builtin: ["Bash"] });
        const sub = await s.subscribe(threadId);
        const sent = await send(s, threadId, "Run the bash command `sleep 20 && echo ran >> side.log` exactly once, then reply with just the word done.");
        const call = (await sub.waitFor((e) => e.type === "tool.call", TIMEOUT, "tool.call")) as Of<"tool.call">;
        // The follow-up resumes this session, so it must hold the call.
        await callStored(s, sent.run_id, call.payload.tool_call_id);

        await s.crashAndRestart();
        const sub2 = await s.subscribe(threadId);
        await askedFor(sub2, call);
        expect((await send(s, threadId, "Status?")).disposition).toBe("held");
        expect(await s.shell.call("runs.stop", { run_id: sent.run_id })).toEqual({ state: "cancelled" });
        const result = (await sub2.waitFor((e) => e.type === "tool.result", 5_000, "tool.result")) as Of<"tool.result">;
        expect(result.payload).toMatchObject({ tool_call_id: call.payload.tool_call_id, status: "error" });
        expect(await s.shell.call("input.list_pending", { thread_id: threadId })).toEqual({ requests: [] });
        await runEnd(sub2, sent.run_id, 5_000);
        expect(undeliveredMessages(sub2.persisted()).map((e) => e.payload.text)).toEqual(["Status?"]);

        // The next run resumes the thread's session: the call has a result (the replay server
        // fails a request with a dangling tool_use), and it says the outcome is unknown.
        const next = await send(s, threadId, "Did the command finish? Reply with one short sentence and do not run anything.");
        expect(next.run_id).not.toBe(sent.run_id);
        const end = await runEnd(sub2, next.run_id);
        expect(end.payload.state).toBe("succeeded");
        expect(ofType(sub2, "tool.call")).toHaveLength(1);
        expect(existsSync(join(s.work, "side.log"))).toBe(false);
        // The message held by the stopped run is not sent with the follow-up, or ever (§5.7).
        expect(sql<{ n: number }>(s.hr, "SELECT COUNT(*) AS n FROM sdk_transcripts WHERE instr(entry, 'Status?') > 0")[0]!.n).toBe(0);
        expect(undeliveredMessages(sub2.persisted()).map((e) => e.payload.text)).toEqual(["Status?"]);
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
  test.skipIf(!recorded("monitor-model-no-change"))(
    "a model check with a source: a baseline, then no change; the thread stays quiet (§8.3)",
    () => {
      const page = statusPage("Example status: all systems operational.");
      return scene(
        "monitor-model-no-change",
        { note: "A monitor's model check (structured output, no tools) run twice on an unchanged status page.", normalize: page.normalize },
        async (s) => {
          const created = await s.shell.call("tasks.create", { spec: statusMonitor(page.url) as never });
          const taskId = created.task.task_id;
          const first = (await s.shell.call("tasks.run_now", { task_id: taskId } as never)) as { run_id: string };
          const a = await monitorRun(s, first.run_id);
          expect(a).toMatchObject({ state: "succeeded", outcome: "no_change", monitor_phase: "model_check" });
          expect(JSON.parse(a.check_result!)).toMatchObject({ changed: false, evidence: expect.any(String) });
          expect(a.cost_usd).toBeGreaterThan(0);
          const baseline = monitorState(s, taskId);
          expect(baseline).toMatchObject({ last_run_id: first.run_id });
          expect(JSON.parse(baseline!.state)).toMatchObject({ status: expect.stringContaining("operational") });

          const second = (await s.shell.call("tasks.run_now", { task_id: taskId } as never)) as { run_id: string };
          const b = await monitorRun(s, second.run_id);
          expect(b).toMatchObject({ state: "succeeded", outcome: "no_change" });
          expect(JSON.parse(b.check_result!).changed).toBe(false);
          expect(JSON.parse(monitorState(s, taskId)!.state)).toEqual(JSON.parse(baseline!.state));

          // Quiet: no-change runs write nothing to the monitor's thread.
          expect(sql(s.hr, "SELECT seq FROM thread_events WHERE thread_id = ?", created.thread_id)).toEqual([]);
          // Structured output with no tools: the model is offered only claude's answer tool, and
          // one request per check suffices.
          const checks = checkRequests(s);
          expect(checks).toHaveLength(2);
          for (const r of checks) expect(r.fp!.tools).toEqual(["StructuredOutput"]);
        },
      ).finally(page.stop);
    },
    TIMEOUT,
  );

  test.skipIf(!recorded("monitor-model-changed-act"))(
    "a model check finds a change: the act step reports it, and the state advances with the run (§8.3)",
    () => {
      const page = statusPage("Example status: all systems operational.");
      return scene(
        "monitor-model-changed-act",
        { note: "A monitor's model check sees the status page change, and the act step reports it.", normalize: page.normalize },
        async (s) => {
          const created = await s.shell.call("tasks.create", { spec: statusMonitor(page.url) as never });
          const taskId = created.task.task_id;
          const first = (await s.shell.call("tasks.run_now", { task_id: taskId } as never)) as { run_id: string };
          expect(await monitorRun(s, first.run_id)).toMatchObject({ state: "succeeded", outcome: "no_change" });
          const baseline = monitorState(s, taskId)!;

          page.set("Example status: major outage. The API is returning errors.");
          const sub = await s.subscribe(created.thread_id);
          const second = (await s.shell.call("tasks.run_now", { task_id: taskId } as never)) as { run_id: string };
          const end = await runEnd(sub, second.run_id);
          expect(end.payload.state).toBe("succeeded");
          const b = await monitorRun(s, second.run_id);
          expect(b).toMatchObject({ state: "succeeded", outcome: "changed", monitor_phase: "act" });
          const found = JSON.parse(b.check_result!) as { changed: boolean; evidence: string };
          expect(found.changed).toBe(true);
          expect(found.evidence.toLowerCase()).toContain("outage");

          // The thread gets the act step's report, and nothing from the quiet baseline.
          const types = sub.persisted().map((e) => e.type);
          expect(types[0]).toBe("run.started");
          expect(types.at(-1)).toBe("run.end");
          expect(ofType(sub, "message.final").at(-1)!.payload.text.toLowerCase()).toContain("outage");
          expect(sub.persisted().every((e) => e.run_id === second.run_id)).toBe(true);

          // The state advanced in the transaction that ended the run.
          const after = monitorState(s, taskId)!;
          expect(after.version).toBe(baseline.version + 1);
          expect(after.last_run_id).toBe(second.run_id);
          expect(JSON.parse(after.state)).toMatchObject({ status: expect.stringContaining("outage") });
          expect(checkRequests(s)).toHaveLength(2);
          for (const r of checkRequests(s)) expect(r.fp!.tools).toEqual(["StructuredOutput"]);
        },
      ).finally(page.stop);
    },
    TIMEOUT,
  );

  test.skipIf(!recorded("approval-defer"))(
    "a destructive call waits for approval with no process (defer), and the answer resumes it (§5.6)",
    () =>
      scene(
        "approval-defer",
        {
          note: "A Bash command needs approval; the call is deferred at once and claude exits; a message is held; the approval resumes the session, the command runs, then the held message.",
          env: () => ({ HOMERUN_DEV_AUTO_APPROVE: "0", HOMERUN_INPUT_GRACE_MS: "0" }),
        },
        async (s) => {
          const threadId = await task(s, { builtin: ["Bash"] });
          const sub = await s.subscribe(threadId);
          const sent = await send(s, threadId, "Run the bash command `echo approved >> side.log` exactly once, then reply with just the word done.");
          const asked = (await sub.waitFor((e) => e.type === "input.requested", TIMEOUT, "input.requested")) as Of<"input.requested">;
          const [call] = ofType(sub, "tool.call");
          expect(call!.payload).toMatchObject({ tool: "Bash", class: "destructive", policy: "needs_approval" });
          expect(asked.payload.prompt).toMatchObject({ type: "approval", tool: "Bash", tool_call_id: call!.payload.tool_call_id, reason: "destructive", offer_always: false });
          // A redirect is a shell metacharacter: approved one call at a time, never always (§5.5).
          expect(asked.payload.required_authority).toBe("full");

          // Deferred: claude has exited and the run holds no process while it waits (spike 3).
          const row = () => sql<{ state: string; claude_pid: number | null; reap_pgid: number | null }>(s.hr, "SELECT state, claude_pid, reap_pgid FROM runs WHERE run_id = ?", sent.run_id)[0]!;
          await until(() => row().claude_pid === null && row().reap_pgid === null, 15_000, "claude to exit");
          expect(row().state).toBe("waiting_input");
          expect(sql(s.hr, "SELECT 1 FROM input_requests WHERE request_id = ? AND deferred_at IS NOT NULL", asked.payload.request_id)).toHaveLength(1);
          const log = join(s.work, "side.log");
          expect(existsSync(log)).toBe(false);
          expect((await send(s, threadId, "After that, also reply with the word held.")).disposition).toBe("held");

          const answer = (decision: "allow" | "deny") =>
            s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "approval", decision }, via: "app" });
          expect(await answer("allow")).toEqual({ status: "applied" });
          expect(await answer("deny")).toMatchObject({ status: "already_resolved", state: "answered" });

          const end = await runEnd(sub, sent.run_id);
          expect(end.payload.state).toBe("succeeded");
          expect(readFileSync(log, "utf8")).toBe("approved\n");
          expect(ofType(sub, "run.resumed").map((e) => e.payload.reason)).toEqual(["input_answered"]);
          // The deferred call ran once, under its own id, on resume (F6).
          expect(ofType(sub, "tool.call").map((e) => e.payload.tool_call_id)).toEqual([call!.payload.tool_call_id]);
          expect(ofType(sub, "tool.result").map((e) => [e.payload.tool_call_id, e.payload.status])).toEqual([[call!.payload.tool_call_id, "ok"]]);
          expect(sql(s.hr, "SELECT 1 FROM input_requests WHERE request_id = ? AND applied_at IS NOT NULL", asked.payload.request_id)).toHaveLength(1);
          // The held message followed the call's result.
          expect(undeliveredMessages(sub.persisted())).toEqual([]);
          expect(sql<{ n: number }>(s.hr, "SELECT COUNT(*) AS n FROM sdk_transcripts WHERE instr(entry, 'also reply with the word held') > 0")[0]!.n).toBeGreaterThan(0);
        },
      ),
    TIMEOUT,
  );

  test.skipIf(!recorded("ask-user-question"))(
    "AskUserQuestion pauses for the user's answer, which reaches the model (§5.6)",
    () =>
      scene(
        "ask-user-question",
        {
          note: "A session task asks the user a multiple-choice question; the answer is given while claude waits, and the model uses it.",
          env: () => ({ HOMERUN_DEV_AUTO_APPROVE: "0", HOMERUN_INPUT_GRACE_MS: "600000" }),
        },
        async (s) => {
          const threadId = await task(s, { builtin: ["AskUserQuestion"] });
          const sub = await s.subscribe(threadId);
          const sent = await send(
            s,
            threadId,
            "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options: Blue and Green. Then reply with only the colour I chose.",
          );
          const asked = (await sub.waitFor((e) => e.type === "input.requested", TIMEOUT, "input.requested")) as Of<"input.requested">;
          const prompt = asked.payload.prompt;
          expect(prompt.type).toBe("question");
          if (prompt.type !== "question") return;
          expect(prompt.questions).toHaveLength(1);
          const green = prompt.questions[0]!.options.find((o) => /green/i.test(o.label));
          expect(green).toBeDefined();
          expect(asked.payload.required_authority).toBe("any");
          // A short wait: the process is still there.
          expect(sql<{ claude_pid: number | null }>(s.hr, "SELECT claude_pid FROM runs WHERE run_id = ?", sent.run_id)[0]!.claude_pid).not.toBeNull();

          const r = await s.shell.call("input.answer", { request_id: asked.payload.request_id, response: { type: "question", answers: [{ selected: [green!.label] }] }, via: "app" });
          expect(r).toEqual({ status: "applied" });
          const end = await runEnd(sub, sent.run_id);
          expect(end.payload.state).toBe("succeeded");
          const [result] = ofType(sub, "tool.result");
          expect(result!.payload).toMatchObject({ tool_call_id: prompt.tool_call_id, status: "ok" });
          expect(outputText(s.hr, result!)).toContain(green!.label);
          expect(ofType(sub, "message.final").at(-1)!.payload.text).toMatch(/green/i);
          expect(ofType(sub, "run.resumed").map((e) => e.payload.reason)).toEqual(["input_answered"]);
        },
      ),
    TIMEOUT,
  );
});
