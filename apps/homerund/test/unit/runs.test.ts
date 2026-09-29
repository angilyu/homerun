import { afterEach, describe, expect, test } from "bun:test";
import type { FakeScript } from "../../src/agent/fake-engine";
import { AGENT_EXITED_NOTE, RESUME_LIMIT } from "../../src/runs/recovery";
import { NO_RESULT, STOPPED_REASON } from "../../src/runs/driver";
import { UNKNOWN_TEXT } from "../../src/runs/resume";
import { findToolEvent } from "../../src/store/events";
import { getRunRow, pendingInputRequests } from "../../src/store/rows";
import { APPROVALS_UNAVAILABLE } from "../../src/agent/policy";
import { DESKTOP, persisted, sessionSpec, testRuntime, types, until, uuid, type TestRuntime } from "../helpers";

let rt: TestRuntime | null = null;
afterEach(() => {
  rt?.close();
  rt = null;
});

function setup(script?: FakeScript, o: Parameters<typeof testRuntime>[0] = {}) {
  rt = testRuntime({ ...o, ...(script ? { script } : {}) });
  const thread = rt.manager.createThread();
  const origin = DESKTOP(rt.ctx.device.device_id);
  const send = (text: string, threadId = thread.thread_id, id = uuid()) => rt!.manager.sendMessage({ thread_id: threadId, client_msg_id: id, text }, origin);
  const run = (id: string) => getRunRow(rt!.store, id)!;
  return { rt, thread, origin, send, run };
}

describe("a text-only turn", () => {
  test("persists the run lifecycle, gap-free, with no stored deltas", async () => {
    const { rt, thread, send, run } = setup(async (s) => {
      const i = (await s.nextInput())!;
      s.emit({ type: "delta", messageId: "m1", text: "hel" });
      s.emit({ type: "delta", messageId: "m1", text: "lo" });
      s.emit({ type: "message", messageId: "m1", text: "hello", model: "claude-test" });
      s.result([i.uuid], { cost: 0.01 });
    });
    const r = send("hi");
    expect(r.disposition).toBe("started_run");
    await rt.scheduler.idle();
    expect(types(rt.store, thread.thread_id)).toEqual(["user.message", "run.started", "message.final", "run.end"]);
    const ev = persisted(rt.store, thread.thread_id);
    expect(ev.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(ev[3]!.payload).toMatchObject({ state: "succeeded", cost_usd: 0.01 });
    expect(run(r.run_id)).toMatchObject({ state: "succeeded", claude_pid: null, reap_pgid: null, cost_usd: 0.01 });
    const deltas = rt.live.filter((e) => e.type === "message.delta");
    expect(deltas.map((d) => (d.payload as { text: string }).text).join("")).toBe("hello");
    expect(deltas.map((d) => (d.payload as { index: number }).index)).toEqual([0]);
    expect(rt.store.db.query("SELECT count(*) AS n FROM thread_events WHERE type = 'message.delta'").get()).toEqual({ n: 0 });
  });

  test("messages.send is idempotent on client_msg_id", async () => {
    const { rt, thread, send } = setup();
    const id = uuid();
    const a = send("hi", thread.thread_id, id);
    const b = send("hi", thread.thread_id, id);
    expect(b).toEqual(a);
    await rt.scheduler.idle();
    expect(send("hi", thread.thread_id, id)).toEqual(a);
    expect(types(rt.store, thread.thread_id).filter((t) => t === "user.message")).toHaveLength(1);
  });

  test("a follow-up on an idle thread is a new run resuming the thread's session", async () => {
    const { rt, send, run } = setup();
    const a = send("one");
    await rt.scheduler.idle();
    const b = send("two");
    await rt.scheduler.idle();
    expect(b.run_id).not.toBe(a.run_id);
    expect(rt.engine.sessions[1]!.opts.resume).toBe(run(a.run_id).sdk_session_id);
    expect(run(b.run_id).state).toBe("succeeded");
  });

  test("an error result fails the run with the subtype as the code", async () => {
    const { rt, send, run } = setup(async (s) => {
      const i = (await s.nextInput())!;
      s.result([i.uuid], { ok: false, subtype: "error_max_budget_usd" });
    });
    const r = send("hi");
    await rt.scheduler.idle();
    expect(run(r.run_id).state).toBe("failed");
    expect(JSON.parse(run(r.run_id).error!)).toMatchObject({ code: "error_max_budget_usd" });
  });
});

describe("steering (§5.7)", () => {
  test("a second message steers the running run instead of starting another", async () => {
    let gate!: () => void;
    const opened = new Promise<void>((r) => (gate = r));
    const { rt, thread, send, run } = setup(async (s) => {
      const first = (await s.nextInput())!;
      await opened;
      s.emit({ type: "message", messageId: "a", text: "working" });
      // The steer arrived before the turn ended: this result only consumes the first.
      s.result([first.uuid]);
      const second = (await s.nextInput())!;
      s.emit({ type: "message", messageId: "b", text: `saw ${second.text}` });
      s.result([second.uuid]);
    });
    const a = send("do it");
    await until(() => rt.engine.sessions.length === 1 && run(a.run_id).state === "running");
    const b = send("also this");
    expect(b).toMatchObject({ run_id: a.run_id, disposition: "steered" });
    gate();
    await rt.scheduler.idle();
    expect(run(a.run_id).state).toBe("succeeded");
    expect(types(rt.store, thread.thread_id)).toEqual(["user.message", "run.started", "user.message", "message.final", "message.final", "run.end"]);
    expect(rt.store.db.query("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 1 });
  });

  test("a message to a queued run joins its first turn", async () => {
    const { rt, send, run } = setup(undefined, { key: false });
    const a = send("one");
    const b = send("two");
    expect(b).toMatchObject({ run_id: a.run_id, disposition: "steered" });
    rt.ctx.secrets.set("anthropic_api_key", "sk-ant-mock-not-a-real-key");
    await until(() => rt.engine.sessions.length === 1);
    expect(rt.engine.sessions[0]!.opts.initialInputs.map((i) => i.text)).toEqual(["one", "two"]);
    await rt.scheduler.idle();
    expect(run(a.run_id).state).toBe("succeeded");
  });
});

describe("tool calls (§5.4)", () => {
  test("an allowed call gets tool.call before dispatch and a result after", async () => {
    let callSeen = false;
    const { rt, thread, send } = setup(async (s) => {
      const i = (await s.nextInput())!;
      await s.tool({ toolCallId: "t1", tool: "Read", input: { file_path: "/etc/hosts" } }, async () => {
        callSeen = types(rt!.store, thread.thread_id).includes("tool.call");
        return { ok: true, output: "127.0.0.1 localhost", durationMs: 3 };
      });
      s.result([i.uuid]);
    });
    send("read it");
    await rt.scheduler.idle();
    expect(callSeen).toBe(true);
    const ev = persisted(rt.store, thread.thread_id);
    expect(ev.find((e) => e.type === "tool.call")!.payload).toMatchObject({ tool_call_id: "t1", tool: "Read", class: "read", policy: "allowed" });
    expect(ev.find((e) => e.type === "tool.result")!.payload).toMatchObject({ tool_call_id: "t1", status: "ok", duration_ms: 3 });
  });

  test("PreToolUse and canUseTool for the same id share one decision and one tool.call", async () => {
    const { rt, thread, send } = setup(async (s) => {
      const i = (await s.nextInput())!;
      const [a, b] = await Promise.all([
        s.opts.gate.preTool({ toolCallId: "t1", tool: "Read", input: {} }),
        s.opts.gate.preTool({ toolCallId: "t1", tool: "Read", input: {} }),
      ]);
      expect(a).toEqual(b);
      s.opts.gate.postTool({ toolCallId: "t1", ok: true, output: "x" });
      s.result([i.uuid]);
    });
    send("go");
    await rt.scheduler.idle();
    expect(types(rt.store, thread.thread_id).filter((t) => t.startsWith("tool."))).toEqual(["tool.call", "tool.result"]);
  });

  test("tools outside the spec and calls needing approval are denied, with a result", async () => {
    const { rt, thread, send } = setup(async (s) => {
      const i = (await s.nextInput())!;
      expect(await s.tool({ toolCallId: "t1", tool: "Bash", input: { command: "rm -rf /" } })).toMatchObject({ allow: false });
      expect(await s.tool({ toolCallId: "t2", tool: "WebFetch", input: { url: "https://example.com" } })).toEqual({ allow: false, reason: APPROVALS_UNAVAILABLE });
      expect(await s.tool({ toolCallId: "t3", tool: "not a tool", input: {} })).toMatchObject({ allow: false });
      s.result([i.uuid]);
    });
    send("go");
    await rt.scheduler.idle();
    const ev = persisted(rt.store, thread.thread_id);
    const calls = ev.filter((e) => e.type === "tool.call").map((e) => e.payload as { tool_call_id: string; policy: string });
    expect(calls).toEqual([expect.objectContaining({ tool_call_id: "t1", policy: "denied" }), expect.objectContaining({ tool_call_id: "t2", policy: "needs_approval" })]);
    const results = ev.filter((e) => e.type === "tool.result").map((e) => e.payload as { status: string });
    expect(results.map((r) => r.status)).toEqual(["denied", "denied"]);
  });

  test("--dev-auto-approve allows a needs_approval call and keeps the honest policy", async () => {
    const { rt, thread, send } = setup(
      async (s) => {
        const i = (await s.nextInput())!;
        expect(await s.tool({ toolCallId: "t1", tool: "WebFetch", input: { url: "https://example.com" } })).toEqual({ allow: true });
        s.result([i.uuid]);
      },
      { env: { HOMERUN_DEV_AUTO_APPROVE: "1" } },
    );
    send("go");
    await rt.scheduler.idle();
    expect(persisted(rt.store, thread.thread_id).find((e) => e.type === "tool.call")!.payload).toMatchObject({ policy: "needs_approval" });
    expect(rt.logs.some((l) => l.includes("--dev-auto-approve"))).toBe(true);
  });

  test("a tool_result seen in the stream stands in for a missed Post hook; the rest get 'no result reported'", async () => {
    const { rt, thread, send } = setup(async (s) => {
      const i = (await s.nextInput())!;
      await s.opts.gate.preTool({ toolCallId: "t1", tool: "Read", input: {} });
      await s.opts.gate.preTool({ toolCallId: "t2", tool: "Read", input: {} });
      s.emit({ type: "tool_result_seen", toolCallId: "t1", isError: true, content: [{ type: "text", text: "boom" }] });
      s.result([i.uuid]);
    });
    send("go");
    await rt.scheduler.idle();
    const results = persisted(rt.store, thread.thread_id)
      .filter((e) => e.type === "tool.result")
      .map((e) => e.payload);
    expect(results).toEqual([
      expect.objectContaining({ tool_call_id: "t1", status: "error", error: "boom" }),
      expect.objectContaining({ tool_call_id: "t2", status: "error", error: NO_RESULT }),
    ]);
  });

  test("outputs over 4 KB go to blobs", async () => {
    const big = "x".repeat(10_000);
    const { rt, thread, send } = setup(async (s) => {
      const i = (await s.nextInput())!;
      await s.tool({ toolCallId: "t1", tool: "Read", input: {} }, async () => ({ ok: true, output: big }));
      s.result([i.uuid]);
    });
    send("go");
    await rt.scheduler.idle();
    const out = (persisted(rt.store, thread.thread_id).find((e) => e.type === "tool.result")!.payload as { output: { kind: string; size: number; preview: string } }).output;
    expect(out).toMatchObject({ kind: "blob", size: 10_000 });
    expect(out.preview).toHaveLength(500);
    expect(rt.store.db.query("SELECT size FROM blobs").all()).toEqual([{ size: 10_000 }]);
  });
});

describe("stop (§5.7)", () => {
  test("a running run stops after its in-flight call, never mid-call", async () => {
    let finishTool!: () => void;
    const toolDone = new Promise<void>((r) => (finishTool = r));
    const { rt, thread, send, run, origin } = setup(async (s) => {
      await s.nextInput();
      await s.tool({ toolCallId: "t1", tool: "Read", input: {} }, async () => {
        await toolDone;
        return { ok: true, output: "done" };
      });
      // After the stop, new calls are denied.
      expect(await s.tool({ toolCallId: "t2", tool: "Read", input: {} })).toEqual({ allow: false, reason: STOPPED_REASON });
      expect(await s.nextInput()).toBeNull();
    });
    const r = send("go");
    await until(() => types(rt.store, thread.thread_id).includes("tool.call"));
    expect(rt.manager.stop(r.run_id, origin)).toBe("running");
    await Bun.sleep(20);
    expect(run(r.run_id).state).toBe("running");
    expect(rt.engine.sessions[0]!.interrupted).toBe(false);
    finishTool();
    await rt.scheduler.idle();
    expect(rt.engine.sessions[0]!.interrupted).toBe(true);
    expect(run(r.run_id).state).toBe("cancelled");
    expect(types(rt.store, thread.thread_id)).toEqual(["user.message", "run.started", "tool.call", "run.cancelled", "tool.result", "tool.call", "tool.result", "run.end"]);
    expect(rt.live.some((e) => e.type === "run.status" && (e.payload as { detail: string }).detail === "stopping")).toBe(true);
  });

  test("a queued run is cancelled at once", () => {
    const { rt, thread, send, run, origin } = setup(undefined, { key: false });
    const r = send("go");
    expect(rt.manager.stop(r.run_id, origin)).toBe("cancelled");
    expect(run(r.run_id).state).toBe("cancelled");
    expect(types(rt.store, thread.thread_id)).toEqual(["user.message", "run.cancelled", "run.end"]);
  });
});

describe("concurrency (§5.3)", () => {
  test("three sessions run at once; the fourth is queued with its position", async () => {
    const gates: Array<() => void> = [];
    const { rt, run } = setup(async (s) => {
      const i = (await s.nextInput())!;
      await new Promise<void>((r) => gates.push(r));
      s.result([i.uuid]);
    });
    const threads = [0, 1, 2, 3].map(() => rt.manager.createThread());
    const origin = DESKTOP(rt.ctx.device.device_id);
    const runs = threads.map((t) => rt.manager.sendMessage({ thread_id: t.thread_id, client_msg_id: uuid(), text: "go" }, origin));
    await until(() => gates.length === 3);
    await Bun.sleep(20);
    expect(gates).toHaveLength(3);
    expect(run(runs[3]!.run_id).state).toBe("pending");
    const queued = rt.live.find((e) => e.type === "run.status" && e.run_id === runs[3]!.run_id);
    expect(queued?.payload).toMatchObject({ detail: "queued", queue_position: 1 });
    gates[0]!();
    await until(() => gates.length === 4);
    for (const g of gates.slice(1)) g();
    await rt.scheduler.idle();
    expect(runs.map((r) => run(r.run_id).state)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  test("nothing starts before the shell hands over the API key", async () => {
    const { rt, send, run } = setup(undefined, { key: false });
    const r = send("go");
    await Bun.sleep(20);
    expect(run(r.run_id).state).toBe("pending");
    rt.ctx.secrets.set("anthropic_api_key", "sk-ant-mock-not-a-real-key");
    await until(() => run(r.run_id).state === "succeeded");
  });
});

describe("the agent dies while the runtime keeps running (§5.1)", () => {
  test("a clean interruption resumes the same run from the stored session", async () => {
    const { rt, thread, send, run } = setup(async (s) => {
      const first = (await s.nextInput())!;
      if (s.index === 0) return { code: null, signal: "SIGKILL" };
      s.emit({ type: "message", messageId: "m", text: `resumed with: ${first.text}` });
      s.result([first.uuid]);
    });
    const r = send("go");
    await until(() => run(r.run_id).state === "succeeded");
    expect(rt.engine.sessions).toHaveLength(2);
    expect(rt.engine.sessions[1]!.opts.resume).toBe(run(r.run_id).sdk_session_id);
    // The unconsumed message is in the stored session already; the resumed agent gets the note.
    expect(rt.engine.sessions[1]!.opts.initialInputs.map((i) => i.text)).toEqual([AGENT_EXITED_NOTE]);
    const ev = persisted(rt.store, thread.thread_id);
    expect(ev.map((e) => e.type)).toEqual(["user.message", "run.started", "run.resumed", "message.final", "run.end"]);
    expect(ev[2]!.payload).toEqual({ reason: "agent_exited" });
    expect(run(r.run_id)).toMatchObject({ resume_count: 0, resume_note: null });
  });

  test("an interrupted destructive call parks the run in waiting_input with 'Did this happen?'", async () => {
    const { rt, send, run } = setup(
      async (s) => {
        await s.nextInput();
        await s.opts.gate.preTool({ toolCallId: "t1", tool: "Bash", input: { command: "touch /tmp/x" } });
        return { code: null, signal: "SIGKILL" };
      },
      { env: { HOMERUN_DEV_AUTO_APPROVE: "1" } },
    );
    // A task with Bash, so the call is in the spec.
    const task = rt.manager.createTask(sessionSpec() as never);
    const r = send("go", task.thread.thread_id);
    await until(() => run(r.run_id).state === "waiting_input");
    await rt.scheduler.idle();
    const reqs = pendingInputRequests(rt.store, { runId: r.run_id });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.prompt).toMatchObject({ type: "ambiguous_tool_call", tool_call_id: "t1", class: "destructive" });
    expect(types(rt.store, task.thread.thread_id)).toEqual(["user.message", "run.started", "tool.call", "input.requested"]);
    expect(run(r.run_id).claude_pid).toBeNull();
    // A message now is held, not steered.
    expect(send("hello?", task.thread.thread_id)).toMatchObject({ run_id: r.run_id, disposition: "held" });
    // Stopping cancels the request.
    rt.manager.stop(r.run_id, DESKTOP(rt.ctx.device.device_id));
    // The call gets a result, so the transcript can be settled if the thread goes on.
    expect(types(rt.store, task.thread.thread_id).slice(-4)).toEqual(["run.cancelled", "tool.result", "input.resolved", "run.end"]);
    expect(findToolEvent(rt.store, task.thread.thread_id, "tool.result", "t1")!.payload).toMatchObject({ status: "error", error: UNKNOWN_TEXT });
  });

  test(`a run that keeps dying is abandoned after ${RESUME_LIMIT} resumes`, async () => {
    const { rt, send, run } = setup(async (s) => {
      await s.nextInput();
      return { code: 1, signal: null };
    });
    const r = send("go");
    await until(() => run(r.run_id).state === "abandoned");
    expect(rt.engine.sessions).toHaveLength(RESUME_LIMIT + 1);
    expect(JSON.parse(run(r.run_id).error!)).toMatchObject({ code: "resume_loop" });
  });
});

describe("isolation (§5.3)", () => {
  test("a Skill tool or a foreign MCP server in system/init fails the run", async () => {
    const { rt, send, run } = setup(async (s) => {
      await s.nextInput();
      s.emit({ type: "session", sessionId: "x", tools: ["Read", "Skill"], mcpServers: [], skills: [], plugins: [], model: "m" });
      await s.killed;
    });
    const r = send("go");
    await rt.scheduler.idle();
    expect(run(r.run_id).state).toBe("failed");
    expect(JSON.parse(run(r.run_id).error!)).toMatchObject({ code: "isolation_violation" });
  });
});
