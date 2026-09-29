import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { echoScript, type FakeScript } from "../../src/agent/fake-engine";
import { groupAlive, pidAlive } from "../../src/agent/claude/spawn";
import { bootTime } from "../../src/runs/process-groups";
import { AnswerRejected } from "../../src/runs/ambiguity";
import { RESTART_NOTE } from "../../src/runs/recovery";
import { NOT_RUN_TEXT } from "../../src/runs/resume";
import { openDb } from "../../src/store/db";
import { chainEntries, chainTo, chainTools } from "../../src/store/transcript";
import { RPC_ERROR, undeliveredMessages } from "@homerun/core";
import { RpcCallError } from "../../src/rpc/client";
import { sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

const KEY = "sk-ant-mock-not-a-real-key";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const never = () => new Promise<never>(() => {});

/** A runtime that is "killed" mid-run, then a fresh one on the same data dir. */
async function crashAndRestart(first: FakeScript, second: FakeScript, o: { builtin?: string[]; roots?: string[]; env?: Record<string, string>; beforeRestart?: (dir: string, runId: string) => void; until?: (s: SocketRuntime, runId: string) => Promise<void> } = {}) {
  const env = { HOMERUN_DEV_AUTO_APPROVE: "1" };
  const a = await socketRuntime({ script: first, env });
  const shell = await a.shell();
  await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
  const { task, thread_id } = await shell.call("tasks.create", { spec: sessionSpec({ builtin: o.builtin ?? ["Bash", "Read"], ...(o.roots ? { roots: o.roots } : {}) }) as never });
  const sent = await shell.call("messages.send", { thread_id, client_msg_id: uuid(), text: "go" });
  await (o.until ? o.until(a, sent.run_id) : until(() => a.engine.sessions.length === 1, 2000, "session"));
  // Past the delta coalescing window, so no timer of the dead runtime fires after the crash.
  await Bun.sleep(120);
  a.crash();
  o.beforeRestart?.(a.dir, sent.run_id);

  const b = await socketRuntime({ dir: a.dir, script: second, env: { ...env, ...o.env } });
  cleanups.push(async () => {
    await b.close();
    (await import("node:fs")).rmSync(a.dir, { recursive: true, force: true });
  });
  return { a, b, task, thread_id, run_id: sent.run_id };
}

function row(s: SocketRuntime, runId: string) {
  return s.rt.store.db.query<Record<string, unknown>, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId)!;
}

function eventTypes(s: SocketRuntime, threadId: string): string[] {
  return s.rt.store.db.query<{ type: string }, [string]>("SELECT type FROM thread_events WHERE thread_id = ? ORDER BY seq").all(threadId).map((r) => r.type);
}

describe("startup recovery (§5.4)", () => {
  test("a clean interruption resumes the same run from the stored session", async () => {
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        s.emit({ type: "delta", messageId: "m", text: "thinking" });
        await never();
      },
      async (s) => {
        const inputs = [(await s.nextInput())!];
        s.emit({ type: "message", messageId: "m2", text: "done" });
        s.result(inputs.map((i) => i.uuid));
      },
    );
    expect(b.rt.report.recovered).toEqual([{ run_id, outcome: expect.objectContaining({ kind: "requeued" }) }]);
    await b.shell().then((c) => c.call("secrets.set", { name: "anthropic_api_key", value: KEY }));
    await b.rt.scheduler.idle();
    const s = b.engine.sessions[0]!;
    expect(s.opts.resume).toBe(`fake-session-${run_id}`);
    // "go" is in the stored session already; only the note is new.
    expect(s.opts.initialInputs.map((i) => i.text)).toEqual([RESTART_NOTE]);
    expect(row(b, run_id)).toMatchObject({ state: "succeeded", resume_count: 0, claude_pid: null });
    expect(eventTypes(b, thread_id)).toEqual(["user.message", "run.started", "run.resumed", "message.final", "run.end"]);
  });

  test("a finished call whose mirrored tool_result was lost gets its recorded result in the transcript", async () => {
    // The Post hook wrote tool.result, but the SDK mirror died before storing claude's tool_result
    // (it can lag the API request). Left alone, claude would show the call as interrupted on
    // resume; the launch writes the recorded result as the call's tool_result instead.
    const { b, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "t1", tool: "Bash", input: { command: "echo ran >> side.log" } }, async () => ({ ok: true, output: "" }));
        await never();
      },
      async (s) => {
        const inputs = [(await s.nextInput())!];
        s.emit({ type: "message", messageId: "m2", text: "done" });
        s.result(inputs.map((i) => i.uuid));
      },
      {
        until: async (a, id) => until(() => a.rt.store.db.query("SELECT 1 FROM thread_events WHERE run_id = ? AND type = 'tool.result'").get(id) !== null, 2000, "tool.result"),
        beforeRestart: (dir, runId) => {
          const db = openDb(join(dir, "homerun.db"));
          const { sdk_session_id } = db.query<{ sdk_session_id: string }, [string]>("SELECT sdk_session_id FROM runs WHERE run_id = ?").get(runId)!;
          const entry = { parentUuid: firstInput(db, runId).uuid, isSidechain: false, type: "assistant", uuid: crypto.randomUUID(), sessionId: sdk_session_id, message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } };
          seed(db, sdk_session_id, [entry]);
          db.close();
        },
      },
    );
    expect(b.rt.report.recovered).toEqual([{ run_id, outcome: expect.objectContaining({ kind: "requeued" }) }]);
    await b.shell().then((c) => c.call("secrets.set", { name: "anthropic_api_key", value: KEY }));
    await b.rt.scheduler.idle();
    expect(b.engine.sessions[0]!.opts.initialInputs.map((i) => i.text)).toEqual([RESTART_NOTE]);
    const sid = row(b, run_id).sdk_session_id as string;
    const chain = chainTo(chainEntries(b.rt.store, sid));
    expect(chainTools(chain).dangling).toEqual([]);
    expect(afterCall(chain, "t1")).toMatchObject({
      type: "user",
      sessionId: sid,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "(no output)", is_error: false }] },
    });
    expect(row(b, run_id).state).toBe("succeeded");
  });

  test("a read-class call in flight gets interrupted_retryable and the run resumes", async () => {
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "r1", tool: "Read", input: { file_path: "/x" } }, never);
      },
      echoScript,
      { until: async (a, id) => until(() => a.rt.store.db.query("SELECT 1 FROM thread_events WHERE run_id = ? AND type = 'tool.call'").get(id) !== null, 2000, "tool.call") },
    );
    expect(b.rt.report.recovered[0]!.outcome.kind).toBe("requeued");
    const result = b.rt.store.db.query<{ payload: string }, []>("SELECT payload FROM thread_events WHERE type = 'tool.result'").get()!;
    expect(JSON.parse(result.payload)).toMatchObject({ tool_call_id: "r1", status: "interrupted_retryable" });
    expect(row(b, run_id).state).toBe("pending");
    expect(eventTypes(b, thread_id)).toEqual(["user.message", "run.started", "tool.call", "tool.result"]);
  });

  test("a destructive call in flight parks the run in waiting_input and never resumes it", async () => {
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf x" } }, never);
      },
      async () => {
        throw new Error("must not start");
      },
      {
        until: async (a, id) => until(() => a.rt.store.db.query("SELECT 1 FROM thread_events WHERE run_id = ? AND type = 'tool.call'").get(id) !== null, 2000, "tool.call"),
      },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    await Bun.sleep(30);
    expect(b.engine.sessions).toHaveLength(0);
    expect(row(b, run_id)).toMatchObject({ state: "waiting_input", resume_reason: "ambiguity_resolved" });
    const { requests } = await shell.call("input.list_pending", { thread_id: thread_id as never });
    expect(requests).toHaveLength(1);
    expect(requests[0]!).toMatchObject({ kind: "question", tool_call_id: "b1", prompt: { type: "ambiguous_tool_call", tool_call_id: "b1" } });
    expect(eventTypes(b, thread_id).slice(-1)).toEqual(["input.requested"]);
    const requested = b.rt.store.db.query<{ payload: string }, []>("SELECT payload FROM thread_events WHERE type = 'input.requested'").get()!;
    expect(JSON.parse(requested.payload)).toMatchObject({ required_authority: "full" });
    const sent = await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "did it?" });
    expect(sent).toMatchObject({ run_id, disposition: "held" });
  }, 10_000);

  test("stale process groups are killed before recovery; foreign or other-boot groups are left alone", async () => {
    const ours = spawn("/bin/bash", ["-c", "sleep 30; true"], { detached: true, stdio: "ignore" });
    const foreign = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const otherBoot = spawn("/bin/bash", ["-c", "sleep 30; true"], { detached: true, stdio: "ignore" });
    cleanups.push(() => {
      for (const p of [ours, foreign, otherBoot]) {
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {}
      }
    });
    const boot = bootTime();
    const { b, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await never();
      },
      echoScript,
      {
        beforeRestart: (dir) => {
          const db = openDb(join(dir, "homerun.db"));
          const ids = db.query<{ run_id: string }, []>("SELECT run_id FROM runs").all();
          db.query("UPDATE runs SET claude_pid = ?, claude_boot = ? WHERE run_id = ?").run(ours.pid!, boot, ids[0]!.run_id);
          // Finished runs whose groups were still exiting.
          for (const [pgid, b] of [[foreign.pid!, boot], [otherBoot.pid!, boot - 1000]] as const) {
            db.query(
              "INSERT INTO runs (run_id, thread_id, device_id, trigger, authority, dedupe_key, state, created_at, started_at, ended_at, pool, reap_pgid, claude_boot) SELECT ?1, thread_id, device_id, trigger, authority, ?1, 'succeeded', created_at, created_at, created_at, pool, ?2, ?3 FROM runs LIMIT 1",
            ).run(crypto.randomUUID(), pgid, b);
          }
          db.close();
        },
      },
    );
    expect(b.rt.report.killedGroups).toEqual([ours.pid!]);
    expect(groupAlive(ours.pid!)).toBe(false);
    expect(groupAlive(foreign.pid!)).toBe(true);
    expect(groupAlive(otherBoot.pid!)).toBe(true);
    expect(b.rt.store.db.query("SELECT count(*) AS n FROM runs WHERE claude_pid IS NOT NULL OR reap_pgid IS NOT NULL").get()).toEqual({ n: 0 });
    expect(row(b, run_id).state).toBe("pending");
  });

  test("tool shells that escaped claude's group are killed at startup (F8)", async () => {
    const procs: ReturnType<typeof spawn>[] = [];
    cleanups.push(() => {
      for (const p of procs) {
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {}
      }
    });
    const pgidOf = (pid: number) => Number(Bun.spawnSync(["/bin/ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim());
    const childOf = (pid: number) => Number(Bun.spawnSync(["/usr/bin/pgrep", "-P", String(pid)]).stdout.toString().trim().split("\n")[0]);
    let escaped = 0;
    let job = 0;
    const alive = pidAlive;
    const { b } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await never();
      },
      echoScript,
      {
        beforeRestart: (dir) => {
          // Like the Bash tool: a shell in its own group sourcing a snapshot under CLAUDE_CONFIG_DIR,
          // whose pipeline got yet another group (job control), both orphaned.
          const snap = join(dir, "claude-config", "shell-snapshots", "snapshot-bash-1.sh");
          const sh = spawn("/bin/bash", ["-c", `set -m; sleep 30 & wait; : ${snap}`], { detached: true, stdio: "ignore" });
          const lookalike = spawn("/bin/bash", ["-c", `sleep 30; : ${dir}-other/claude-config/x`], { detached: true, stdio: "ignore" });
          procs.push(sh, lookalike);
          escaped = sh.pid!;
          for (let i = 0; i < 100 && !job; i++) {
            Bun.sleepSync(20);
            job = childOf(escaped) || 0;
          }
          expect(job).toBeGreaterThan(0);
          expect(pgidOf(job)).toBe(job);
        },
      },
    );
    expect(b.rt.report.killedTools).toContain(escaped);
    expect(b.rt.report.killedTools).toContain(job);
    expect(alive(escaped)).toBe(false);
    expect(alive(job)).toBe(false);
    expect(groupAlive(procs[1]!.pid!)).toBe(true);
  });

  test("caches left by a killed claude are swept", async () => {
    const { b } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await never();
      },
      echoScript,
      {
        beforeRestart: (dir) => {
          mkdirSync(join(dir, "claude-config", "projects", "homerun"), { recursive: true });
          writeFileSync(join(dir, "claude-config", "projects", "homerun", "s.jsonl"), "{}\n");
          mkdirSync(join(dir, "tmp", "claude-resume-abc"), { recursive: true });
          mkdirSync(join(dir, "claude-config", "claude-resume-def"), { recursive: true });
        },
      },
    );
    expect(existsSync(join(b.dir, "claude-config", "projects", "homerun"))).toBe(false);
    expect(existsSync(join(b.dir, "tmp", "claude-resume-abc"))).toBe(false);
    expect(existsSync(join(b.dir, "claude-config", "claude-resume-def"))).toBe(false);
    expect(b.rt.report.swept).toHaveLength(3);
  });
});

/** Writes what claude's mirror would hold: the user turn, then one assistant message calling each tool. */
function mirrorToolUses(dir: string, runId: string, ids: string[]): string {
  const db = openDb(join(dir, "homerun.db"));
  const { sdk_session_id: sid } = db.query<{ sdk_session_id: string }, [string]>("SELECT sdk_session_id FROM runs WHERE run_id = ?").get(runId)!;
  const first = firstInput(db, runId);
  const user = { parentUuid: null, isSidechain: false, type: "user", uuid: first.uuid, sessionId: sid, message: { role: "user", content: first.text } };
  let parent = user.uuid;
  const entries: Record<string, unknown>[] = [user];
  for (const id of ids) {
    const e = { parentUuid: parent, isSidechain: false, type: "assistant", uuid: crypto.randomUUID(), sessionId: sid, message: { id: "msg1", role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: {} }] } };
    entries.push(e);
    parent = e.uuid;
  }
  seed(db, sid, entries);
  db.close();
  return user.uuid;
}

/** The entry right after the assistant message that made this call. */
function afterCall(chain: ReturnType<typeof chainTo>, toolCallId: string): Record<string, unknown> | undefined {
  const i = chain.findIndex((c) => JSON.stringify(c.entry).includes(`"id":"${toolCallId}"`));
  return chain[i + 1]?.entry as Record<string, unknown> | undefined;
}

/** claude stores a prompt under the uuid it was sent with. */
function firstInput(db: Database, runId: string): { uuid: string; text: string } {
  return db.query<{ uuid: string; text: string }, [string]>("SELECT uuid, text FROM run_inputs WHERE run_id = ? ORDER BY created_at, rowid LIMIT 1").get(runId)!;
}

/** Appends to a session's stored transcript; an entry already there (by uuid) is kept. */
function seed(db: Database, sid: string, entries: Record<string, unknown>[]): void {
  for (const e of entries) {
    db.query(
      "INSERT OR IGNORE INTO sdk_transcripts (project_key, session_id, subpath, seq, uuid, entry) " +
        "SELECT 'homerun', ?1, '', COALESCE(MAX(seq), 0) + 1, ?2, ?3 FROM sdk_transcripts WHERE project_key = 'homerun' AND session_id = ?1 AND subpath = ''",
    ).run(sid, e.uuid as string, JSON.stringify(e));
  }
}

const callsLogged = (n: number) => async (a: SocketRuntime, id: string) =>
  until(() => a.rt.store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM thread_events WHERE run_id = ? AND type = 'tool.call'").get(id)!.n === n, 2000, "tool.call");

async function rejectsWith(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcCallError) return e.code;
    throw e;
  }
  throw new Error("expected a rejection");
}

describe('answering "Did this happen?" (milestone 4)', () => {
  test("needs full authority; the answer becomes the call's tool_result and the run resumes with a note", async () => {
    let userUuid = "";
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      async (s) => {
        const inputs: string[] = [];
        for (let i = 0; i < s.opts.initialInputs.length; i++) inputs.push((await s.nextInput())!.uuid);
        s.emit({ type: "message", messageId: "m2", text: "done" });
        s.result(inputs);
      },
      { until: callsLogged(1), beforeRestart: (dir, id) => void (userUuid = mirrorToolUses(dir, id, ["b1"])) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "did it?" });
    const [req] = (await shell.call("input.list_pending", {})).requests;
    const origin = { device_id: b.rt.device.device_id, surface: "web" as const };
    const answer = { type: "ambiguous_tool_call" as const, outcome: "not_run" as const };

    // The web and the release CLI can't answer it; a lock-screen action can't either.
    for (const [role, via] of [["web", "app"], ["cli", "app"], ["shell", "notification"]] as const) {
      expect(() => b.rt.manager.answerAmbiguous(req!.request_id, { response: answer, role, via, origin })).toThrow(AnswerRejected);
    }
    const dev = await b.dev();
    expect(await rejectsWith(dev.raw("input.answer", { request_id: req!.request_id, response: { type: "question", answers: [{ selected: ["yes"] }] }, via: "app" }))).toBe(RPC_ERROR.VALIDATION_FAILED);
    expect(await rejectsWith(dev.raw("input.answer", { request_id: uuid(), response: answer, via: "app" }))).toBe(RPC_ERROR.NOT_FOUND);
    expect(row(b, run_id).state).toBe("waiting_input");

    // cli_dev may answer; the first answer wins.
    expect(await dev.call("input.answer", { request_id: req!.request_id, response: answer, via: "app" })).toEqual({ status: "applied" });
    expect(await shell.call("input.answer", { request_id: req!.request_id, response: { ...answer, outcome: "completed" }, via: "app" })).toMatchObject({
      status: "already_resolved",
      state: "answered",
    });
    await until(() => row(b, run_id).state === "succeeded", 3000, "resumed run");

    const s = b.engine.sessions[0]!;
    const sid = row(b, run_id).sdk_session_id as string;
    expect(s.opts.resume).toBe(sid);
    expect(s.opts.resumeAt ?? null).toBeNull();
    const texts = s.opts.initialInputs.map((i) => i.text);
    expect(texts[0]).toContain("The user confirmed that it did not run");
    expect(texts[0]).toContain("rm -rf build");
    expect(texts).toContain("did it?");
    const chain = chainTo(chainEntries(b.rt.store, sid));
    expect(chainTools(chain).dangling).toEqual([]);
    expect(afterCall(chain, "b1")).toMatchObject({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: NOT_RUN_TEXT }] } });
    expect(chain[0]!.uuid).toBe(userUuid);
    const types = eventTypes(b, thread_id);
    expect(types.slice(types.indexOf("input.requested"))).toEqual(["input.requested", "user.message", "input.resolved", "tool.result", "run.resumed", "message.final", "run.end"]);
    const result = b.rt.store.db.query<{ payload: string }, []>("SELECT payload FROM thread_events WHERE type = 'tool.result'").get()!;
    expect(JSON.parse(result.payload)).toMatchObject({ tool_call_id: "b1", status: "resolved_not_run" });
    expect(row(b, run_id)).toMatchObject({ resume_note: null, resume_at: null });
    const events = (await shell.call("threads.history", { thread_id: thread_id as never, limit: 500 })).events;
    expect(undeliveredMessages(events)).toEqual([]);
  }, 10_000);

  test("a resume that cannot start never delivered its held messages", async () => {
    const root = mkdtempSync(join(tmpdir(), "hr-root-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      async () => {
        throw new Error("must not start");
      },
      { until: callsLogged(1), roots: [root], beforeRestart: (dir, id) => void mirrorToolUses(dir, id, ["b1"]) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "did it?" });
    const [req] = (await shell.call("input.list_pending", {})).requests;
    // The task's folder is gone, so the resumed run fails before claude starts.
    rmSync(root, { recursive: true, force: true });
    await shell.call("input.answer", { request_id: req!.request_id, response: { type: "ambiguous_tool_call", outcome: "completed" }, via: "app" });
    await until(() => row(b, run_id).state === "failed", 3000, "failed resume");
    expect(b.engine.sessions).toHaveLength(0);
    const events = (await shell.call("threads.history", { thread_id: thread_id as never, limit: 500 })).events;
    expect(events.at(-1)).toMatchObject({ type: "run.end", payload: { state: "failed", error: { code: "root_missing" } } });
    expect(undeliveredMessages(events).map((e) => e.payload.text)).toEqual(["did it?"]);
  }, 10_000);

  test("stopping a parked run leaves its held messages visibly undelivered; nothing sends them later (§5.7)", async () => {
    const { a, b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      async (s) => {
        const inputs: string[] = [];
        for (let i = 0; i < s.opts.initialInputs.length; i++) inputs.push((await s.nextInput())!.uuid);
        s.emit({ type: "message", messageId: "m3", text: "unknown" });
        s.result(inputs);
      },
      { until: callsLogged(1), beforeRestart: (dir, id) => void mirrorToolUses(dir, id, ["b1"]) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    const held = await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "did it?" });
    expect(held).toMatchObject({ run_id, disposition: "held" });
    expect(await shell.call("runs.stop", { run_id: run_id as never })).toEqual({ state: "cancelled" });
    const history = async () => (await shell.call("threads.history", { thread_id: thread_id as never, limit: 500 })).events;
    const undelivered = undeliveredMessages(await history());
    expect(undelivered.map((e) => [e.run_id, e.payload.text])).toEqual([[run_id, "did it?"]]);
    expect(b.engine.sessions).toHaveLength(0);

    // A follow-up starts a new run with only its own message; the held one is not carried over.
    const next = await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "next" });
    expect(next.run_id).not.toBe(run_id);
    await until(() => row(b, next.run_id).state === "succeeded", 3000, "follow-up run");
    expect(b.engine.sessions.flatMap((s) => s.opts.initialInputs.map((i) => i.text))).toEqual(["next"]);
    expect(undeliveredMessages(await history()).map((e) => e.payload.text)).toEqual(["did it?"]);

    // Nor after a restart.
    b.crash();
    const c = await socketRuntime({ dir: a.dir, script: async () => { throw new Error("must not start"); } });
    cleanups.push(() => c.close());
    await Bun.sleep(50);
    expect(c.engine.sessions).toHaveLength(0);
    expect(row(c, run_id).state).toBe("cancelled");
  }, 10_000);

  test("parallel calls wait for every answer; truncate mode resumes from before the assistant message", async () => {
    let userUuid = "";
    const { b, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        void s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "git push" } }, never);
        await s.tool({ toolCallId: "b2", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      async (s) => {
        const inputs: string[] = [];
        for (let i = 0; i < s.opts.initialInputs.length; i++) inputs.push((await s.nextInput())!.uuid);
        s.result(inputs);
      },
      { until: callsLogged(2), env: { HOMERUN_DEV_AMBIGUITY_MODE: "truncate" }, beforeRestart: (dir, id) => void (userUuid = mirrorToolUses(dir, id, ["b1", "b2"])) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    const { requests } = await shell.call("input.list_pending", {});
    expect(requests.map((r) => r.tool_call_id as string).sort()).toEqual(["b1", "b2"]);
    const byCall = (id: string) => requests.find((r) => r.tool_call_id === id)!.request_id;

    await shell.call("input.answer", { request_id: byCall("b1"), response: { type: "ambiguous_tool_call", outcome: "completed" }, via: "app" });
    await Bun.sleep(30);
    expect(row(b, run_id).state).toBe("waiting_input");
    expect(b.engine.sessions).toHaveLength(0);

    await shell.call("input.answer", { request_id: byCall("b2"), response: { type: "ambiguous_tool_call", outcome: "not_run" }, via: "app" });
    await until(() => row(b, run_id).state === "succeeded", 3000, "resumed run");
    const s = b.engine.sessions[0]!;
    expect(s.opts.resumeAt).toBe(userUuid);
    const note = s.opts.initialInputs[0]!.text;
    expect(note).toContain('"git push"');
    expect(note).toContain("it completed: its effect happened, so do not run it again");
    expect(note).toContain('"rm -rf build"');
    expect(note).toContain("it did not run; run it again");
    // Nothing was injected: the model resumes from before the calls.
    const content = b.rt.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sdk_transcripts WHERE entry LIKE '%tool_result%'").get()!.n;
    expect(content).toBe(0);
  }, 10_000);

  test("a crash before claude stored anything of the conversation: the answer starts the run over, task first, then the note", async () => {
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      async (s) => {
        const inputs: string[] = [];
        for (let i = 0; i < s.opts.initialInputs.length; i++) inputs.push((await s.nextInput())!.uuid);
        s.emit({ type: "message", messageId: "m2", text: "done" });
        s.result(inputs);
      },
      // claude mirrors its transcript a little after the fact: nothing of it made it.
      { until: callsLogged(1), beforeRestart: (dir, id) => forgetSession(dir, id) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "did it?" });
    const [req] = (await shell.call("input.list_pending", {})).requests;
    const dev = await b.dev();
    await dev.call("input.answer", { request_id: req!.request_id, response: { type: "ambiguous_tool_call", outcome: "completed" }, via: "app" });
    await until(() => row(b, run_id).state === "succeeded", 3000, "resumed run");

    // Resuming a session with nothing stored fails in claude ("No conversation found"), so the
    // run starts a new one and gets its task again, before the note that says the call happened.
    const s = b.engine.sessions[0]!;
    expect(s.opts.resume).toBeNull();
    const texts = s.opts.initialInputs.map((i) => i.text);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toBe("go");
    expect(texts[1]).toContain("it completed: its effect happened, so do not run it again");
    expect(texts[2]).toBe("did it?");
    const sid = row(b, run_id).sdk_session_id as string;
    const gos = chainEntries(b.rt.store, sid).filter((e) => (e.entry as { message?: { content?: unknown } }).message?.content === "go");
    expect(gos).toHaveLength(1);
    expect(row(b, run_id).sdk_cost_baseline).toBe(0);
  }, 10_000);

  test("a follow-up after a run whose conversation was never stored starts a new session", async () => {
    const { b, thread_id, run_id } = await crashAndRestart(
      async (s) => {
        await s.nextInput();
        await s.tool({ toolCallId: "b1", tool: "Bash", input: { command: "rm -rf build" } }, never);
      },
      echoScript,
      { until: callsLogged(1), beforeRestart: (dir, id) => forgetSession(dir, id) },
    );
    const shell = await b.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
    expect(await shell.call("runs.stop", { run_id: run_id as never })).toEqual({ state: "cancelled" });
    const next = await shell.call("messages.send", { thread_id: thread_id as never, client_msg_id: uuid(), text: "next" });
    await until(() => row(b, next.run_id).state === "succeeded", 3000, "follow-up run");
    const s = b.engine.sessions[0]!;
    expect(s.opts.resume).toBeNull();
    expect(s.opts.initialInputs.map((i) => i.text)).toEqual(["next"]);
  }, 10_000);
});

/** Drops what claude's mirror stored of the run's session, as if the crash came before it flushed. */
function forgetSession(dir: string, runId: string): void {
  const db = openDb(join(dir, "homerun.db"));
  const { sdk_session_id: sid } = db.query<{ sdk_session_id: string }, [string]>("SELECT sdk_session_id FROM runs WHERE run_id = ?").get(runId)!;
  db.query("DELETE FROM sdk_transcripts WHERE session_id = ?").run(sid);
  db.query("DELETE FROM sdk_session_summaries WHERE session_id = ?").run(sid);
  db.close();
}
