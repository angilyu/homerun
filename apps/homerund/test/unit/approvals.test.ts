import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { AnswerVia, CallerRole, InputResponse, Origin } from "@homerun/core";
import type { FakeScript } from "../../src/agent/fake-engine";
import type { GateDecision } from "../../src/agent/engine";
import { AnswerRejected } from "../../src/runs/ambiguity";
import { STOPPED_REASON } from "../../src/runs/driver";
import { ENDED_UNANSWERED_TEXT } from "../../src/runs/finish";
import { APPROVED_NOT_RUN_TEXT, DENIED_TEXT, EXPIRED_TEXT, SIBLING_TEXT } from "../../src/runs/gate";
import { InputTimeouts } from "../../src/runs/input-timeouts";
import { systemClock } from "../../src/schedule/clock";
import { findToolEvent } from "../../src/store/events";
import { insertGrant, listGrants, revokeGrant } from "../../src/store/grants";
import { getGateRequest, getRunRow, pendingInputRequests } from "../../src/store/rows";
import { DESKTOP, persisted, sessionSpec, testRuntime, types, until, uuid, type TestRuntime } from "../helpers";

let rt: TestRuntime | null = null;
afterEach(() => {
  rt?.close();
  rt = null;
});

type Policy = Partial<ReturnType<typeof sessionSpec>["policy"]>;

function setup(script: FakeScript, o: { env?: Record<string, string>; builtin?: string[]; policy?: Policy } = {}) {
  rt = testRuntime({ script, env: { HOMERUN_INPUT_GRACE_MS: "600000", ...o.env } });
  const base = sessionSpec({ builtin: o.builtin ?? ["Bash", "Read", "AskUserQuestion"] });
  const task = rt.manager.createTask({ ...base, policy: { ...base.policy, ...o.policy } } as never);
  const threadId = task.thread.thread_id;
  const device = rt.ctx.device.device_id;
  const send = (text: string) => rt!.manager.sendMessage({ thread_id: threadId, client_msg_id: uuid(), text }, DESKTOP(device));
  const run = (id: string) => getRunRow(rt!.store, id)!;
  const pending = (runId: string) => pendingInputRequests(rt!.store, { runId });
  const answer = (requestId: string, response: InputResponse, role: CallerRole = "shell", via: AnswerVia = "app") => {
    const origin: Origin = { device_id: device as Origin["device_id"], surface: role === "web" ? "web" : role === "cli" || role === "cli_dev" ? "cli" : "desktop" };
    return rt!.manager.answerInput(requestId, { response, role, via, origin });
  };
  return { rt, task, threadId, send, run, pending, answer };
}

const allow: InputResponse = { type: "approval", decision: "allow" };
const deny: InputResponse = { type: "approval", decision: "deny" };
const rm = { command: "rm -rf build" };
/** A shell metacharacter: destructive, never "Always allow" (§5.5). */
const chained = { command: "rm -rf build && ls" };

describe("an approval (§5.6)", () => {
  test("a destructive call pauses the run; the answer from a short wait runs it, and held messages follow", async () => {
    let seen: GateDecision | null = null;
    const got: string[] = [];
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      seen = await x.tool({ toolCallId: "t1", tool: "Bash", input: chained, canDefer: true });
      const next = (await x.nextInput())!;
      got.push(next.text);
      x.result([i.uuid, next.uuid]);
    });
    const r = s.send("clean up");
    await until(() => s.run(r.run_id).state === "waiting_input");
    const [req] = s.pending(r.run_id);
    expect(req!.prompt).toMatchObject({ type: "approval", tool: "Bash", class: "destructive", reason: "destructive", offer_always: false });
    expect(findToolEvent(s.rt.store, s.threadId, "tool.call", "t1")!.payload).toMatchObject({ policy: "needs_approval", class: "destructive" });
    // The process is still alive: a message now is held until the answer (§5.7).
    expect(s.run(r.run_id).claude_pid).not.toBeNull();
    expect(s.send("also this")).toMatchObject({ disposition: "held" });

    expect(s.answer(req!.request_id, allow)).toEqual({ status: "applied" });
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: true });
    expect(got).toEqual(["also this"]);
    expect(s.run(r.run_id).state).toBe("succeeded");
    const t = types(s.rt.store, s.threadId);
    expect(t.slice(t.indexOf("tool.call"))).toEqual(["tool.call", "input.requested", "user.message", "input.resolved", "run.resumed", "tool.result", "run.end"]);
    expect(persisted(s.rt.store, s.threadId).find((e) => e.type === "run.resumed")!.payload).toEqual({ reason: "input_answered" });
    expect(getGateRequest(s.rt.store, req!.request_id)!.applied_at).not.toBeNull();
  });

  test("a denial gives the call a denied result and the run goes on", async () => {
    let seen: GateDecision | null = null;
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      seen = await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    s.answer(s.pending(r.run_id)[0]!.request_id, deny);
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: false, reason: DENIED_TEXT });
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "denied", error: DENIED_TEXT });
    expect(s.run(r.run_id).state).toBe("succeeded");
  });

  test("first answer wins; the second learns who answered", async () => {
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      await x.tool({ toolCallId: "t1", tool: "Bash", input: rm });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    const id = s.pending(r.run_id)[0]!.request_id;
    expect(s.answer(id, deny)).toEqual({ status: "applied" });
    expect(s.answer(id, allow)).toEqual({ status: "already_resolved", state: "answered", answered_by: s.rt.ctx.device.device_id });
    await s.rt.scheduler.idle();
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "denied" });
    expect(persisted(s.rt.store, s.threadId).filter((e) => e.type === "input.resolved")).toHaveLength(1);
  });

  test("the authority matrix: the release CLI answers questions only; the web client cannot approve a destructive call", async () => {
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      await x.tool({ toolCallId: "t1", tool: "Bash", input: rm });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    const id = s.pending(r.run_id)[0]!.request_id;
    const reject = (role: CallerRole, via: AnswerVia = "app") => {
      try {
        s.answer(id, allow, role, via);
      } catch (e) {
        return e;
      }
      return null;
    };
    for (const [role, via] of [["cli", "app"], ["web", "app"], ["ios", "notification"]] as const) {
      const e = reject(role, via);
      expect(e).toBeInstanceOf(AnswerRejected);
      expect((e as AnswerRejected).reason).toBe("authority");
    }
    expect(s.pending(r.run_id)).toHaveLength(1);
    expect(s.answer(id, allow, "cli_dev")).toEqual({ status: "applied" });
    await s.rt.scheduler.idle();
  });

  test("a run a web message started has reduced authority: anything beyond reading asks, on a full-authority device (§9.9)", async () => {
    let seen: GateDecision | null = null;
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      seen = await x.tool({ toolCallId: "t1", tool: "Bash", input: { command: "make test" } });
      x.result([i.uuid]);
    });
    const web: Origin = { device_id: s.rt.ctx.device.device_id as Origin["device_id"], surface: "web" };
    const r = s.rt.manager.sendMessage({ thread_id: s.threadId, client_msg_id: uuid(), text: "go" }, web);
    await until(() => s.pending(r.run_id).length === 1);
    expect(s.run(r.run_id).authority).toBe("web_read_only");
    const [req] = s.pending(r.run_id);
    expect(req!.prompt).toMatchObject({ reason: "web_read_only", offer_always: false });
    expect(() => s.answer(req!.request_id, allow, "web")).toThrow(AnswerRejected);
    s.answer(req!.request_id, allow);
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: true });
  });

  test("a gated sibling in the same batch is denied and re-issued after the answer (parallel-call rule)", async () => {
    const out: Record<string, GateDecision> = {};
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      const a = x.tool({ toolCallId: "t1", tool: "Bash", input: rm }).then((d) => (out.t1 = d));
      const b = x.tool({ toolCallId: "t2", tool: "Bash", input: { command: "rm -rf dist" } }).then((d) => (out.t2 = d));
      await Promise.all([a, b]);
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1 && out.t2 !== undefined);
    expect(out.t2).toEqual({ allow: false, reason: SIBLING_TEXT });
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t2")!.payload).toMatchObject({ status: "denied", error: SIBLING_TEXT });
    s.answer(s.pending(r.run_id)[0]!.request_id, allow);
    await s.rt.scheduler.idle();
    expect(out.t1).toEqual({ allow: true });
  });

  test("stopping a run that waits denies the call and cancels the request", async () => {
    let seen: GateDecision | null = null;
    const s = setup(async (x) => {
      await x.nextInput();
      seen = await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    s.rt.manager.stop(r.run_id, DESKTOP(s.rt.ctx.device.device_id));
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: false, reason: STOPPED_REASON });
    expect(s.run(r.run_id).state).toBe("cancelled");
    expect(s.pending(r.run_id)).toHaveLength(0);
    const resolved = persisted(s.rt.store, s.threadId).filter((e) => e.type === "input.resolved");
    expect(resolved.map((e) => (e.payload as { state: string }).state)).toEqual(["cancelled"]);
  });
});

describe("defer and resume (§5.6)", () => {
  test("a long wait defers the call, the process exits, and the answer resumes the run from SQLite", async () => {
    const decisions: GateDecision[] = [];
    const inputs: string[] = [];
    const s = setup(
      async (x) => {
        if (x.index === 0) {
          const i = (await x.nextInput())!;
          const d = await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
          decisions.push(d);
          x.result([i.uuid], { deferred: { toolCallId: "t1", tool: "Bash" } });
          return;
        }
        // Resumed on an empty input stream: claude asks about the deferred call again.
        decisions.push(await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true }));
        const i = (await x.nextInput())!;
        inputs.push(i.text);
        x.result([i.uuid]);
      },
      { env: { HOMERUN_INPUT_GRACE_MS: "20" } },
    );
    const r = s.send("go");
    await until(() => s.rt.scheduler.activeCount === 0 && s.run(r.run_id).state === "waiting_input");
    expect(decisions[0]).toMatchObject({ allow: false, defer: true });
    const [req] = s.pending(r.run_id);
    expect(getGateRequest(s.rt.store, req!.request_id)!.deferred_at).not.toBeNull();
    // No process, no slot: overnight costs nothing.
    expect(s.run(r.run_id)).toMatchObject({ claude_pid: null, reap_pgid: null });
    expect(s.send("and then this")).toMatchObject({ disposition: "held" });

    s.answer(req!.request_id, allow);
    await until(() => s.run(r.run_id).state === "succeeded");
    expect(s.rt.engine.sessions).toHaveLength(2);
    expect(s.rt.engine.sessions[1]!.opts.resume).toBe(s.run(r.run_id).sdk_session_id);
    expect(s.rt.engine.sessions[1]!.opts.initialInputs).toEqual([]);
    expect(decisions[1]).toEqual({ allow: true });
    expect(inputs).toEqual(["and then this"]);
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "ok" });
    expect(persisted(s.rt.store, s.threadId).filter((e) => e.type === "run.resumed").map((e) => e.payload)).toEqual([{ reason: "input_answered" }]);
  });

  test("a denied deferred call gets its denial on resume", async () => {
    const decisions: GateDecision[] = [];
    const s = setup(
      async (x) => {
        if (x.index === 0) {
          const i = (await x.nextInput())!;
          decisions.push(await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true }));
          x.result([i.uuid], { deferred: { toolCallId: "t1", tool: "Bash" } });
          return;
        }
        decisions.push(await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true }));
        x.result([]);
      },
      { env: { HOMERUN_INPUT_GRACE_MS: "20" } },
    );
    const r = s.send("go");
    await until(() => s.rt.scheduler.activeCount === 0 && s.run(r.run_id).state === "waiting_input");
    s.answer(s.pending(r.run_id)[0]!.request_id, deny);
    await until(() => s.run(r.run_id).state === "succeeded");
    expect(decisions[1]).toEqual({ allow: false, reason: DENIED_TEXT });
  });

  test("an answer while the turn is still ending requeues the run once the deferral is recorded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(
      async (x) => {
        if (x.index === 0) {
          const i = (await x.nextInput())!;
          await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
          await gate;
          x.result([i.uuid], { deferred: { toolCallId: "t1", tool: "Bash" } });
          return;
        }
        await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
        x.result([]);
      },
      { env: { HOMERUN_INPUT_GRACE_MS: "20" } },
    );
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    await Bun.sleep(40);
    s.answer(s.pending(r.run_id)[0]!.request_id, allow);
    expect(s.run(r.run_id).state).toBe("waiting_input");
    release();
    await until(() => s.run(r.run_id).state === "succeeded");
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "ok" });
  });

  test("a process that dies while waiting: the run parks, and an approval becomes a one-shot for the re-issued call", async () => {
    const decisions: GateDecision[] = [];
    const s = setup(async (x) => {
      if (x.index === 0) {
        await x.nextInput();
        void x.tool({ toolCallId: "t1", tool: "Bash", input: rm });
        await Bun.sleep(20);
        return { code: 1, signal: null };
      }
      const i = await x.nextInput();
      decisions.push(await x.tool({ toolCallId: "t2", tool: "Bash", input: { ...rm } }));
      x.result(i ? [i.uuid] : []);
    });
    const r = s.send("go");
    await until(() => s.rt.scheduler.activeCount === 0 && s.run(r.run_id).state === "waiting_input");
    // Not a "Did this happen?": the gate held the call, so it never ran.
    const [req] = s.pending(r.run_id);
    expect(req!.prompt.type).toBe("approval");
    s.answer(req!.request_id, allow);
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "interrupted_retryable", error: APPROVED_NOT_RUN_TEXT });
    await until(() => s.run(r.run_id).state === "succeeded");
    expect(decisions).toEqual([{ allow: true }]);
    expect(findToolEvent(s.rt.store, s.threadId, "tool.call", "t2")!.payload).toMatchObject({ policy: "needs_approval" });
    expect(getGateRequest(s.rt.store, req!.request_id)!.applied_at).not.toBeNull();
    expect(pendingInputRequests(s.rt.store, { runId: r.run_id })).toHaveLength(0);
  });
});

describe("AskUserQuestion (§5.6)", () => {
  const ask = {
    questions: [
      { question: "Which branch?", header: "Branch", options: [{ label: "main", description: "" }, { label: "dev", description: "" }], multiSelect: false },
    ],
  };

  test("pauses for an answer, which reaches the tool as updatedInput.answers", async () => {
    let seen: GateDecision | null = null;
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      seen = await x.tool({ toolCallId: "q1", tool: "AskUserQuestion", input: ask, canDefer: true });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    const [req] = s.pending(r.run_id);
    expect(req).toMatchObject({ kind: "question", tool_call_id: "q1" });
    expect(req!.prompt).toMatchObject({ type: "question", questions: [{ question: "Which branch?", options: [{ label: "main" }, { label: "dev" }], multi_select: false }] });
    // The release CLI may answer a question (§5.2).
    expect(s.answer(req!.request_id, { type: "question", answers: [{ selected: ["dev"] }] }, "cli")).toEqual({ status: "applied" });
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: true, updatedInput: { ...ask, answers: { "Which branch?": "dev" } } });
  });

  test("a malformed question is denied, not asked", async () => {
    let seen: GateDecision | null = null;
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      seen = await x.tool({ toolCallId: "q1", tool: "AskUserQuestion", input: { questions: [] } });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await s.rt.scheduler.idle();
    expect(seen!).toMatchObject({ allow: false });
    expect(s.pending(r.run_id)).toHaveLength(0);
  });
});

describe("the hard denylist (§5.5, §13)", () => {
  test("--dev-auto-approve can't reach it: a denylisted call is denied outright, with nothing to answer", async () => {
    const seen: GateDecision[] = [];
    const s = setup(
      async (x) => {
        const i = (await x.nextInput())!;
        seen.push(await x.tool({ toolCallId: "d1", tool: "Read", input: { file_path: ".env" }, canDefer: true }));
        seen.push(await x.tool({ toolCallId: "d2", tool: "Write", input: { file_path: "~/.ssh/authorized_keys", content: "k" }, canDefer: true }));
        seen.push(await x.tool({ toolCallId: "d3", tool: "Read", input: { file_path: join(s.rt.dir, "homerun.db") }, canDefer: true }));
        seen.push(await x.tool({ toolCallId: "ok", tool: "Bash", input: rm, canDefer: true }));
        x.result([i.uuid]);
      },
      { env: { HOMERUN_DEV_AUTO_APPROVE: "1" }, builtin: ["Bash", "Read", "Write"] },
    );
    const r = s.send("look around");
    await s.rt.scheduler.idle();
    expect(seen.slice(0, 3)).toEqual([
      { allow: false, reason: "Homerun never lets the agent read .env files. This call was not run." },
      { allow: false, reason: "Homerun never lets the agent change SSH keys. This call was not run." },
      { allow: false, reason: "Homerun never lets the agent read Homerun's own data. This call was not run." },
    ]);
    // The same run's destructive call is still auto-approved: only the denylist is absolute.
    expect(seen[3]).toEqual({ allow: true });
    expect(pendingInputRequests(s.rt.store, {})).toHaveLength(0);
    expect(types(s.rt.store, s.threadId)).not.toContain("input.requested");
    for (const id of ["d1", "d2", "d3"]) {
      expect(findToolEvent(s.rt.store, s.threadId, "tool.call", id)!.payload).toMatchObject({ policy: "denied" });
      expect(findToolEvent(s.rt.store, s.threadId, "tool.result", id)!.payload).toMatchObject({ status: "denied" });
    }
    expect(s.run(r.run_id).state).toBe("succeeded");
  });
});

describe("always allow and grants (§5.6)", () => {
  test("an 'Always allow' answer creates a grant in the same transaction; later calls use it until revoked", async () => {
    const decisions: GateDecision[] = [];
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      decisions.push(await x.tool({ toolCallId: `c${x.index}`, tool: "Bash", input: { command: "make test" } }));
      x.result([i.uuid]);
    });
    const r1 = s.send("one");
    await until(() => s.pending(r1.run_id).length === 1);
    const [req] = s.pending(r1.run_id);
    expect(req!.prompt).toMatchObject({ reason: "not_allowlisted", offer_always: true, suggested_grant: { tool: "Bash", pattern: "make test", class: "write" } });
    const out = s.rt.manager.answerInput(req!.request_id, {
      response: { type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "make *", class: "write" } },
      role: "shell",
      via: "app",
      origin: DESKTOP(s.rt.ctx.device.device_id),
    });
    expect(out.status).toBe("applied");
    await s.rt.scheduler.idle();
    const [g] = listGrants(s.rt.store, s.task.task.task_id);
    expect(g).toMatchObject({ tool: "Bash", pattern: "make *", class: "write" });
    expect(persisted(s.rt.store, s.threadId).find((e) => e.type === "input.resolved")!.payload).toMatchObject({ grant_id: g!.grant_id });

    const r2 = s.send("two");
    await s.rt.scheduler.idle();
    expect(s.pending(r2.run_id)).toHaveLength(0);
    expect(findToolEvent(s.rt.store, s.threadId, "tool.call", "c1")!.payload).toMatchObject({ policy: "granted", grant_id: g!.grant_id, class: "write" });

    revokeGrant(s.rt.store, g!.grant_id, Date.now());
    const r3 = s.send("three");
    await until(() => s.pending(r3.run_id).length === 1);
    s.answer(s.pending(r3.run_id)[0]!.request_id, deny);
    await s.rt.scheduler.idle();
  });

  test("'Allow all web fetches for this task': a tainted fetch offers it; its grant covers every host until revoked", async () => {
    const s = setup(
      async (x) => {
        const i = (await x.nextInput())!;
        // The first fetch taints the run; the second leaves the (empty) egress allowlist.
        await x.tool({ toolCallId: `a${x.index}`, tool: "WebFetch", input: { url: "https://one.example/", prompt: "p" } });
        await x.tool({ toolCallId: `b${x.index}`, tool: "WebFetch", input: { url: `https://host${x.index}.example/?q=secret`, prompt: "p" } });
        x.result([i.uuid]);
      },
      { builtin: ["WebFetch"] },
    );
    const all = { tool: "WebFetch", pattern: "*", class: "network" } as const;
    const r1 = s.send("one");
    await until(() => s.pending(r1.run_id).length === 1);
    const [req] = s.pending(r1.run_id);
    expect(req!.prompt).toMatchObject({
      reason: "tainted_egress",
      offer_always: true,
      suggested_grant: { tool: "WebFetch", pattern: "host0.example", class: "network" },
      suggested_grant_all: all,
    });
    // Not from a notification or the web (§5.6, §9.9).
    expect(() => s.answer(req!.request_id, { type: "approval", decision: "allow_always", grant: all }, "ios", "notification")).toThrow(AnswerRejected);
    expect(() => s.answer(req!.request_id, { type: "approval", decision: "allow_always", grant: all }, "web")).toThrow(AnswerRejected);
    expect(s.answer(req!.request_id, { type: "approval", decision: "allow_always", grant: all }).status).toBe("applied");
    await s.rt.scheduler.idle();
    const [g] = listGrants(s.rt.store, s.task.task.task_id);
    expect(g).toMatchObject(all);

    const r2 = s.send("two");
    await s.rt.scheduler.idle();
    expect(s.pending(r2.run_id)).toHaveLength(0);
    expect(findToolEvent(s.rt.store, s.threadId, "tool.call", "b1")!.payload).toMatchObject({ policy: "granted", grant_id: g!.grant_id, class: "network" });

    revokeGrant(s.rt.store, g!.grant_id, Date.now());
    const r3 = s.send("three");
    await until(() => s.pending(r3.run_id).length === 1);
    expect(s.pending(r3.run_id)[0]!.prompt).toMatchObject({ reason: "tainted_egress", suggested_grant_all: all });
    // The thread is still tainted, so each fetch asks again.
    s.answer(s.pending(r3.run_id)[0]!.request_id, deny);
    await until(() => s.pending(r3.run_id).length === 1);
    expect(s.pending(r3.run_id)[0]!.prompt).toMatchObject({ suggested_grant: { pattern: "host2.example" }, suggested_grant_all: all });
    s.answer(s.pending(r3.run_id)[0]!.request_id, deny);
    await s.rt.scheduler.idle();
  });

  test("a grant that does not cover the call is refused", async () => {
    const s = setup(async (x) => {
      const i = (await x.nextInput())!;
      await x.tool({ toolCallId: "c", tool: "Bash", input: { command: "make test" } });
      x.result([i.uuid]);
    });
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    const id = s.pending(r.run_id)[0]!.request_id;
    expect(() =>
      s.rt!.manager.answerInput(id, {
        response: { type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "npm *", class: "write" } },
        role: "shell",
        via: "app",
        origin: DESKTOP(s.rt!.ctx.device.device_id),
      }),
    ).toThrow(AnswerRejected);
    expect(listGrants(s.rt.store, s.task.task.task_id)).toHaveLength(0);
    s.answer(id, deny);
    await s.rt.scheduler.idle();
  });
});

describe("Windows with no Git Bash where homerund looks (§5.5, §18 row 57)", () => {
  test("claude may still find a bash of its own: every Bash call asks as destructive, with no pattern, grant or 'Always allow'", async () => {
    const decisions: GateDecision[] = [];
    const s = setup(
      async (x) => {
        const i = (await x.nextInput())!;
        decisions.push(await x.tool({ toolCallId: "t1", tool: "Bash", input: { command: "git status" } }));
        decisions.push(await x.tool({ toolCallId: "t2", tool: "Bash", input: { command: "npm install left-pad" } }));
        x.result([i.uuid]);
      },
      { policy: { bash_patterns: [{ pattern: "git status*", class: "read" }] } as Policy },
    );
    // homerund found no Git Bash at a fixed location; claude reports a Bash tool anyway.
    s.rt.config.claudeShell = { dialect: "unknown", gitBash: null };
    const g = insertGrant(s.rt.store, s.task.task.task_id, { tool: "Bash", pattern: "npm install *", class: "write" }, s.rt.ctx.device.device_id, Date.now());

    const r = s.send("go");
    for (const id of ["t1", "t2"]) {
      await until(() => s.pending(r.run_id).length === 1);
      const [req] = s.pending(r.run_id);
      expect(req!.prompt).toMatchObject({ type: "approval", tool: "Bash", class: "destructive", reason: "destructive", offer_always: false });
      expect((req!.prompt as { suggested_grant?: unknown }).suggested_grant).toBeUndefined();
      expect(findToolEvent(s.rt.store, s.threadId, "tool.call", id)!.payload).toMatchObject({ policy: "needs_approval", class: "destructive" });
      expect(findToolEvent(s.rt.store, s.threadId, "tool.call", id)!.payload).not.toHaveProperty("grant_id");
      // Nor can an answer make a grant for it.
      expect(() => s.answer(req!.request_id, { type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "git status*", class: "read" } })).toThrow(AnswerRejected);
      s.answer(req!.request_id, deny);
      await until(() => decisions.length === (id === "t1" ? 1 : 2));
    }
    await s.rt.scheduler.idle();
    expect(decisions).toEqual([{ allow: false, reason: DENIED_TEXT }, { allow: false, reason: DENIED_TEXT }]);
    expect(listGrants(s.rt.store, s.task.task.task_id).map((x) => x.grant_id)).toEqual([g.grant_id]);
  });
});

describe("input timeouts (§5.6)", () => {
  test("deny: an unanswered approval expires, the call is told it timed out, and the run goes on", async () => {
    let seen: GateDecision | null = null;
    const s = setup(
      async (x) => {
        const i = (await x.nextInput())!;
        seen = await x.tool({ toolCallId: "t1", tool: "Bash", input: rm });
        x.result([i.uuid]);
      },
      { policy: { input_timeout: { action: "deny", after_ms: 60_000 } } as unknown as Policy },
    );
    const r = s.send("go");
    await until(() => s.pending(r.run_id).length === 1);
    const req = s.pending(r.run_id)[0]!;
    const sweep = new InputTimeouts(s.rt.ctx, systemClock, s.rt.manager.gateResolver, s.rt.scheduler);
    expect(sweep.sweep(req.expires_at! - 1)).toEqual([]);
    expect(sweep.sweep(req.expires_at!)).toEqual([req.request_id]);
    await s.rt.scheduler.idle();
    expect(seen!).toEqual({ allow: false, reason: EXPIRED_TEXT });
    expect(s.run(r.run_id).state).toBe("succeeded");
    expect(getGateRequest(s.rt.store, req.request_id)!.req.state).toBe("expired");
  });

  test("cancel_run: a deferred approval that expires overnight cancels the run", async () => {
    const s = setup(
      async (x) => {
        const i = (await x.nextInput())!;
        await x.tool({ toolCallId: "t1", tool: "Bash", input: rm, canDefer: true });
        x.result([i.uuid], { deferred: { toolCallId: "t1", tool: "Bash" } });
      },
      { env: { HOMERUN_INPUT_GRACE_MS: "20" }, policy: { input_timeout: { action: "cancel_run", after_ms: 3_600_000 } } as unknown as Policy },
    );
    const r = s.send("go");
    await until(() => s.rt.scheduler.activeCount === 0 && s.run(r.run_id).state === "waiting_input");
    const req = s.pending(r.run_id)[0]!;
    new InputTimeouts(s.rt.ctx, systemClock, s.rt.manager.gateResolver, s.rt.scheduler).sweep(req.expires_at!);
    expect(s.run(r.run_id).state).toBe("cancelled");
    const ev = persisted(s.rt.store, s.threadId);
    expect(ev.find((e) => e.type === "run.cancelled")!.payload).toEqual({ by: null, reason: "input_timeout" });
    expect(findToolEvent(s.rt.store, s.threadId, "tool.result", "t1")!.payload).toMatchObject({ status: "denied", error: ENDED_UNANSWERED_TEXT });
  });
});
