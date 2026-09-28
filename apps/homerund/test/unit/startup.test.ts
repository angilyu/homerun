import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { echoScript, type FakeScript } from "../../src/agent/fake-engine";
import { groupAlive } from "../../src/agent/claude/spawn";
import { bootTime } from "../../src/runs/process-groups";
import { RESTART_NOTE } from "../../src/runs/recovery";
import { openDb } from "../../src/store/db";
import { sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

const KEY = "sk-ant-mock-not-a-real-key";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const never = () => new Promise<never>(() => {});

/** A runtime that is "killed" mid-run, then a fresh one on the same data dir. */
async function crashAndRestart(first: FakeScript, second: FakeScript, o: { builtin?: string[]; beforeRestart?: (dir: string, runId: string) => void; until?: (s: SocketRuntime, runId: string) => Promise<void> } = {}) {
  const env = { HOMERUN_DEV_AUTO_APPROVE: "1" };
  const a = await socketRuntime({ script: first, env });
  const shell = await a.shell();
  await shell.call("secrets.set", { name: "anthropic_api_key", value: KEY });
  const { task, thread_id } = await shell.call("tasks.create", { spec: sessionSpec({ builtin: o.builtin ?? ["Bash", "Read"] }) as never });
  const sent = await shell.call("messages.send", { thread_id, client_msg_id: uuid(), text: "go" });
  await (o.until ? o.until(a, sent.run_id) : until(() => a.engine.sessions.length === 1, 2000, "session"));
  // Past the delta coalescing window, so no timer of the dead runtime fires after the crash.
  await Bun.sleep(120);
  a.crash();
  o.beforeRestart?.(a.dir, sent.run_id);

  const b = await socketRuntime({ dir: a.dir, script: second, env });
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
        const inputs = [(await s.nextInput())!, (await s.nextInput())!];
        s.emit({ type: "message", messageId: "m2", text: "done" });
        s.result(inputs.map((i) => i.uuid));
      },
    );
    expect(b.rt.report.recovered).toEqual([{ run_id, outcome: expect.objectContaining({ kind: "requeued" }) }]);
    await b.shell().then((c) => c.call("secrets.set", { name: "anthropic_api_key", value: KEY }));
    await b.rt.scheduler.idle();
    const s = b.engine.sessions[0]!;
    expect(s.opts.resume).toBe(`fake-session-${run_id}`);
    expect(s.opts.initialInputs.map((i) => i.text)).toEqual(["go", RESTART_NOTE]);
    expect(row(b, run_id)).toMatchObject({ state: "succeeded", resume_count: 0, claude_pid: null });
    expect(eventTypes(b, thread_id)).toEqual(["user.message", "run.started", "run.resumed", "message.final", "run.end"]);
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
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
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
