import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeScript } from "../../../homerund/src/agent/fake-engine";
import { sessionSpec, until, type SocketRuntime } from "../../../homerund/test/helpers";
import { cli, devToken, events, runtime, spawnCli } from "./support";

/**
 * The CLI from source (a development build) against the whole runtime with the fake engine: no
 * claude, no network, no API key.
 */

let srt: SocketRuntime;
afterEach(async () => {
  await srt?.close();
});

async function thread(title?: string): Promise<string> {
  const dev = await srt.dev();
  return (await dev.call("threads.create", title ? { title } : {})).thread.thread_id;
}

describe("status and the connection", () => {
  test("status reports the runtime and the cli_dev role", async () => {
    srt = await runtime();
    const r = await cli(srt.dir, ["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("homerund ");
    expect(r.stdout).toContain("connected as cli_dev");
    expect(r.stdout).toContain("no active runs");
    const j = await cli(srt.dir, ["status", "--json"]);
    expect(JSON.parse(j.stdout)).toMatchObject({ role: "cli_dev", protocol: 1, cli: { build: "development" }, active_runs: [], pending_input: [] });
  });

  test("no runtime: exit 69 with a hint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-cli-none-"));
    try {
      const r = await cli(dir, ["status"]);
      expect(r.code).toBe(69);
      expect(r.stderr).toContain("homerund is not running");
      expect(r.stderr).toContain("pnpm --filter @homerun/homerund dev");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dev token readable by others, or a wrong one, is refused with 77", async () => {
    srt = await runtime();
    const path = devToken(srt.dir);
    chmodSync(path, 0o644);
    let r = await cli(srt.dir, ["status"]);
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("readable by other users");
    chmodSync(path, 0o600);

    const other = join(srt.dir, "other-token");
    writeFileSync(other, "x".repeat(43), { mode: 0o600 });
    r = await cli(srt.dir, ["status", "--dev-token-file", other]);
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("refused the development token");
  });

  test("--socket and HOMERUN_SOCKET pick the socket in a development build", async () => {
    srt = await runtime();
    const sock = srt.rt.config.socketPath;
    const elsewhere = mkdtempSync(join(tmpdir(), "hr-cli-else-"));
    try {
      expect((await cli(elsewhere, ["status", "--socket", sock])).code).toBe(0);
      expect((await cli(elsewhere, ["status"], { env: { HOMERUN_SOCKET: sock } })).code).toBe(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("usage errors exit 64", async () => {
    srt = await runtime();
    expect((await cli(srt.dir, ["frobnicate"])).code).toBe(64);
    expect((await cli(srt.dir, ["threads", "show"])).code).toBe(64);
    expect((await cli(srt.dir, ["threads", "list", "--limit", "0"])).code).toBe(64);
    expect((await cli(srt.dir, ["blob", "abc", "--json"])).code).toBe(64);
    expect((await cli(srt.dir, ["send", "--title", "x", "abcd", "hi"])).code).toBe(64);
  });
});

describe("send", () => {
  test("--new starts a thread; the answer alone goes to stdout; exit 0", async () => {
    srt = await runtime();
    const r = await cli(srt.dir, ["send", "--new", "hello there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("echo: hello there\n");
    expect(r.stderr).toContain("new thread ");
    expect(r.stderr).toContain("— done");

    const list = await cli(srt.dir, ["threads", "list"]);
    expect(list.stdout).toContain("hello there");
    const dev = await srt.dev();
    const { threads } = await dev.call("threads.list", {});
    expect(threads).toHaveLength(1);
    expect(threads[0]!.title).toBe("hello there");
    // --json is the method's result, as is.
    expect(JSON.parse((await cli(srt.dir, ["threads", "list", "--json"])).stdout)).toEqual(await dev.call("threads.list", { limit: 20 }));

    const show = await cli(srt.dir, ["threads", "show", threads[0]!.thread_id.slice(0, 6)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("you› hello there");
    expect(show.stdout).toContain("claude› echo: hello there");
  });

  test("deltas stream, and the final message adds only what was not printed", async () => {
    srt = await runtime({
      script: async (s) => {
        const i = (await s.nextInput())!;
        s.emit({ type: "delta", messageId: "m1", text: "Hel" });
        s.emit({ type: "delta", messageId: "m1", text: "lo" });
        await Bun.sleep(20);
        s.emit({ type: "message", messageId: "m1", text: "Hello, world" });
        s.result([i.uuid]);
      },
    });
    const t = await thread();
    const r = await cli(srt.dir, ["send", t, "hi"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Hello, world\n");
  });

  test("TEXT from stdin with -; --json prints the run's events as NDJSON", async () => {
    srt = await runtime();
    const t = await thread();
    const r = await cli(srt.dir, ["send", t.slice(0, 8), "-", "--json"], { stdin: "from stdin\n" });
    expect(r.code).toBe(0);
    const ev = events(r.stdout);
    expect(ev.map((e) => e.type).filter((t) => t !== "run.status" && t !== "message.delta")).toEqual(["user.message", "run.started", "message.final", "run.end"]);
    expect(new Set(ev.map((e) => e.run_id)).size).toBe(1);
    expect(ev[0]!.type === "user.message" && ev[0]!.payload.text).toBe("from stdin");
  });

  test("--detach returns at once with the run", async () => {
    srt = await runtime();
    const t = await thread();
    const r = await cli(srt.dir, ["send", t, "later", "--detach", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ disposition: "started_run" });
  });

  test("tool calls and results; a large output names its blob, which `blob` fetches", async () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    srt = await runtime({
      script: async (s) => {
        const i = (await s.nextInput())!;
        await s.tool({ toolCallId: "r1", tool: "Read", input: { file_path: "/etc/hosts" } }, async () => ({ ok: true, output: "a\nb\nc\nd\ne" }));
        await s.tool({ toolCallId: "r2", tool: "Read", input: { file_path: "/var/log/big" } }, async () => ({ ok: true, output: big }));
        s.emit({ type: "message", messageId: "m", text: "read them" });
        s.result([i.uuid]);
      },
    });
    const task = await (await srt.dev()).call("tasks.create", { spec: sessionSpec({ builtin: ["Read"] }) as never });
    const r = await cli(srt.dir, ["send", task.thread_id, "read"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("read them\n");
    expect(r.stderr).toContain("▸ Read /etc/hosts (read)");
    expect(r.stderr).toContain("… 2 more lines");
    const sha = /homerun blob ([0-9a-f]{64})/.exec(r.stderr)?.[1];
    expect(sha).toBeDefined();

    const out = join(srt.dir, "out.txt");
    const b = await cli(srt.dir, ["blob", sha!, "-o", out]);
    expect(b.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(big);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const missing = await cli(srt.dir, ["blob", "0".repeat(64)]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("unknown, or deleted by retention");
  });

  test("a failed run exits 1 with its error", async () => {
    srt = await runtime({
      script: async (s) => {
        const i = (await s.nextInput())!;
        s.result([i.uuid], { ok: false, subtype: "error_during_execution" });
      },
    });
    const t = await thread();
    const r = await cli(srt.dir, ["send", t, "boom"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("— failed");
  });

  test("a run that stops for input exits 75 and says where to answer", async () => {
    // A destructive call interrupted by the agent dying becomes "Did this happen?" (§5.4).
    srt = await runtime({
      env: { HOMERUN_DEV_AUTO_APPROVE: "1" },
      script: async (s) => {
        await s.nextInput();
        await s.opts.gate.preTool({ toolCallId: "t1", tool: "Bash", input: { command: "touch /tmp/x" } });
        return { code: null, signal: "SIGKILL" };
      },
    });
    const task = await (await srt.dev()).call("tasks.create", { spec: sessionSpec() as never });
    const r = await cli(srt.dir, ["send", task.thread_id, "go"]);
    expect(r.code).toBe(75);
    expect(r.stderr).toContain("? Needs your input");
    expect(r.stderr).toContain("Did this Bash call happen");
    expect(r.stderr).toContain("Answer it in the Homerun app");

    // The app and the development CLI may answer "Did this happen?" (INPUT_ANSWER_RIGHTS).
    expect(r.stderr).toContain("or here: homerun answer");
    const list = await cli(srt.dir, ["input", "list"]);
    expect(list.stdout).toMatch(/ app, cli +Did this Bash call happen/);
    expect(list.stderr).toContain("homerun answer REQUEST --completed | --not-run");
    const st = await cli(srt.dir, ["status"]);
    expect(st.stdout).toContain("1 waiting for input");

    // A message now is held for the answer.
    const held = await cli(srt.dir, ["send", task.thread_id, "still there?"]);
    expect(held.code).toBe(75);
    expect(held.stderr).toContain("delivered with the answer");

    // chat from a pipe does not wait forever for an answer that can't come.
    const piped = await cli(srt.dir, ["chat", task.thread_id], { stdin: "and now?\nnever sent\n", timeoutMs: 5_000 });
    expect(piped.code).toBe(75);
    expect(piped.stderr).toContain("delivered with the answer");

    // Stopped instead of answered: the held messages were never delivered, and nothing sends
    // them later; history shows them with a way to resend (§5.7).
    expect((await cli(srt.dir, ["stop", task.thread_id])).code).toBe(0);
    const shown = await cli(srt.dir, ["threads", "show", task.thread_id]);
    expect(shown.stdout).toContain("— cancelled");
    expect(shown.stdout).toContain("✗ not delivered: still there?");
    expect(shown.stdout).toContain("✗ not delivered: and now?");
    expect(shown.stdout).toContain(`resend it: homerun send ${task.thread_id.slice(0, 8)} 'still there?'`);
    const task2 = await (await srt.dev()).call("tasks.create", { spec: sessionSpec() as never });
    const asked = await cli(srt.dir, ["chat", task2.thread_id], { stdin: "go\nnever sent\n", timeoutMs: 5_000 });
    expect(asked.code).toBe(75);
    expect(asked.stderr).toContain("Did this Bash call happen");
  });
});

describe("answer", () => {
  test('"Did this happen?" answered from the development CLI resumes the run with the decision', async () => {
    srt = await runtime({
      env: { HOMERUN_DEV_AUTO_APPROVE: "1" },
      script: async (s) => {
        if (!s.opts.resume) {
          await s.nextInput();
          await s.opts.gate.preTool({ toolCallId: "t1", tool: "Bash", input: { command: "touch /tmp/x" } });
          return { code: null, signal: "SIGKILL" };
        }
        const inputs = [];
        for (let i = 0; i < s.opts.initialInputs.length; i++) inputs.push((await s.nextInput())!.uuid);
        s.emit({ type: "message", messageId: "m2", text: "ran it again" });
        s.result(inputs);
      },
    });
    const task = await (await srt.dev()).call("tasks.create", { spec: sessionSpec() as never });
    expect((await cli(srt.dir, ["send", task.thread_id, "go"])).code).toBe(75);
    const { requests } = await (await srt.dev()).call("input.list_pending", {});
    const id = requests[0]!.request_id;

    for (const flags of [[], ["--completed", "--not-run"]]) {
      const bad = await cli(srt.dir, ["answer", id.slice(0, 8), ...flags]);
      expect(bad.code).toBe(64);
      expect(bad.stderr).toContain("exactly one of --completed or --not-run");
    }
    const ok = await cli(srt.dir, ["answer", id.slice(0, 8), "--not-run"]);
    expect(ok.stderr).toContain("Recorded: the call did not run");
    expect(ok.code).toBe(0);
    await until(() => srt.engine.sessions.length === 2 && srt.rt.store.db.query("SELECT 1 FROM runs WHERE state = 'succeeded'").get() !== null, 5000, "resumed run");
    expect(srt.engine.sessions[1]!.opts.initialInputs[0]!.text).toContain("The user confirmed that it did not run");

    // Answered already: a prefix no longer matches a pending request; the full id says who answered.
    expect((await cli(srt.dir, ["answer", id.slice(0, 8), "--completed"])).code).toBe(1);
    const again = await cli(srt.dir, ["answer", id, "--completed", "--json"]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout)).toMatchObject({ status: "already_resolved", state: "answered" });
  });
});

/** A run that streams a word, then waits until it is stopped. */
const lingering: FakeScript = async (s) => {
  const i = (await s.nextInput())!;
  s.emit({ type: "delta", messageId: "m", text: "working" });
  while (!s.interrupted) await Bun.sleep(10);
  s.result([i.uuid], { ok: false, subtype: "error_during_execution" });
};

describe("interrupts and stop", () => {
  test("Ctrl-C detaches (130) and the run continues; stop THREAD cancels it", async () => {
    srt = await runtime({ script: lingering });
    const t = await thread();
    const p = spawnCli(srt.dir, ["send", t, "go"]);
    await until(() => p.stdout().includes("working"), 10_000, "streamed text");
    p.proc.kill("SIGINT");
    const r = await p.done;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("detached; the run continues");
    const dev = await srt.dev();
    expect((await dev.call("runs.list", { thread_id: t as never })).runs[0]!.state).toBe("running");

    const s = await cli(srt.dir, ["stop", t.slice(0, 8)]);
    expect(s.code).toBe(0);
    expect(s.stderr).toContain("stop requested");
    await until(() => srt.rt.store.db.query("SELECT 1 FROM runs WHERE state = 'cancelled'").get() !== null, 10_000, "cancelled");
    expect((await cli(srt.dir, ["stop", t])).code).toBe(1);
  });

  test("--stop-on-interrupt stops the run, then exits 130", async () => {
    srt = await runtime({ script: lingering });
    const t = await thread();
    const p = spawnCli(srt.dir, ["send", t, "go", "--stop-on-interrupt"]);
    await until(() => p.stdout().includes("working"), 10_000, "streamed text");
    p.proc.kill("SIGINT");
    const r = await p.done;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("stopping run");
    expect(r.stderr).toContain("— cancelled");
  });

  test("stop RUN by prefix; runs list and runs show", async () => {
    srt = await runtime({ script: lingering });
    const t = await thread();
    const dev = await srt.dev();
    const { run_id } = await dev.call("messages.send", { thread_id: t as never, client_msg_id: crypto.randomUUID() as never, text: "go" });
    const list = await cli(srt.dir, ["runs", "list", "--state", "active"]);
    expect(list.stdout).toContain(run_id.slice(0, 8));
    expect((await cli(srt.dir, ["stop", run_id.slice(0, 6)])).code).toBe(0);
    await until(() => srt.rt.store.db.query("SELECT 1 FROM runs WHERE state = 'cancelled'").get() !== null, 10_000, "cancelled");
    const show = await cli(srt.dir, ["runs", "show", run_id.slice(0, 5)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/state\s+cancelled/);
    expect(JSON.parse((await cli(srt.dir, ["runs", "show", run_id, "--json"])).stdout).run.state).toBe("cancelled");
  });

  test("watch shows recent history, follows live, and Ctrl-C exits 130", async () => {
    srt = await runtime();
    const t = await thread();
    expect((await cli(srt.dir, ["send", t, "first"])).code).toBe(0);
    const w = spawnCli(srt.dir, ["watch", t]);
    await until(() => w.stdout().includes("claude› echo: first"), 10_000, "history");
    expect((await cli(srt.dir, ["send", t, "second", "--detach"])).code).toBe(0);
    await until(() => w.stdout().includes("claude› echo: second"), 10_000, "live event");
    expect(w.stdout()).toContain("you› second");
    w.proc.kill("SIGINT");
    expect((await w.done).code).toBe(130);
  });
});

describe("chat", () => {
  test("from a pipe, each line is sent after the previous run ends", async () => {
    srt = await runtime();
    const r = await cli(srt.dir, ["chat"], { stdin: "one\ntwo\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("echo: one\necho: two\n");
    const dev = await srt.dev();
    const { threads } = await dev.call("threads.list", {});
    expect(threads.map((t) => t.title)).toEqual(["one"]);
    const { runs } = await dev.call("runs.list", {});
    expect(runs.map((r) => r.state)).toEqual(["succeeded", "succeeded"]);

    const again = await cli(srt.dir, ["chat", threads[0]!.thread_id.slice(0, 8)], { stdin: "three\n" });
    expect(again.stdout).toBe("echo: three\n");
  });
});

describe("tasks and ids", () => {
  test("tasks create checks the spec before sending; list and show", async () => {
    srt = await runtime();
    const bad = await cli(srt.dir, ["tasks", "create", "--spec", "-"], { stdin: JSON.stringify({ ...sessionSpec(), budget: {} }) });
    expect(bad.code).toBe(64);
    expect(bad.stderr).toContain("the task spec is not valid");
    const dev = await srt.dev();
    expect((await dev.call("tasks.list", {})).tasks).toHaveLength(0);

    const created = await cli(srt.dir, ["tasks", "create", "--spec", "-"], { stdin: JSON.stringify(sessionSpec({ name: "nightly" })) });
    expect(created.code).toBe(0);
    const taskId = created.stdout.trim();
    expect(created.stderr).toContain('created session task "nightly"');
    expect((await cli(srt.dir, ["tasks", "list"])).stdout).toContain("nightly");
    const show = await cli(srt.dir, ["tasks", "show", taskId.slice(0, 4)]);
    expect(show.stdout).toContain('"name": "nightly"');
    const threadPrefix = /its thread is ([0-9a-f]{8})/.exec(created.stderr)![1]!;
    const threads = await cli(srt.dir, ["threads", "list", "--task", taskId.slice(0, 8)]);
    expect(threads.code).toBe(0);
    expect(threads.stdout).toContain(threadPrefix);
  });

  test("prefixes: unknown is 1, too short or ambiguous is 64", async () => {
    srt = await runtime();
    await thread();
    expect((await cli(srt.dir, ["threads", "show", "ffffffff"])).stderr).toContain("no thread matches");
    expect((await cli(srt.dir, ["threads", "show", "ffffffff"])).code).toBe(1);
    const short = await cli(srt.dir, ["threads", "show", "ab"]);
    expect(short.code).toBe(64);
    expect(short.stderr).toContain("at least 4 characters");
    const full = await cli(srt.dir, ["threads", "show", crypto.randomUUID()]);
    expect(full.code).toBe(1);
  });
});
