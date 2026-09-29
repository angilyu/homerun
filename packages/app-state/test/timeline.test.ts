import { describe, expect, test } from "bun:test";
import { initialThreadState, reduceThread, type ThreadState } from "../src/threads/reducer";
import { threadView, type InputItem, type ToolItem, type UserItem } from "../src/threads/timeline";
import {
  RUN,
  RUN2,
  THREAD,
  approvalPrompt,
  ended,
  ev,
  final,
  questionPrompt,
  requested,
  resolved,
  resumed,
  started,
  toolCall,
  toolResult,
  userMsg,
} from "./helpers";

const load = (events: unknown[]): ThreadState => reduceThread(initialThreadState(THREAD), { type: "latest", events: events as never, has_more: false });
const R1 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";
const R2 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c02";

describe("held messages (§5.7)", () => {
  const base = [userMsg(1, "go"), started(2), toolCall(3, "t1", "Bash", { command: "npm test -- --watch=false" }, "needs_approval"), requested(4, R1, approvalPrompt("t1"))];

  test("held while the run waits, delivered when it resumes", () => {
    const held = userMsg(5, "also check lint", "held");
    let v = threadView(load([...base, held]));
    expect(v.items.find((i): i is UserItem => i.kind === "user" && i.seq === 5)!.delivery).toBe("held");
    expect(v.active).toMatchObject({ run_id: RUN, state: "waiting_input" });
    v = threadView(load([...base, held, resolved(6, R1, { type: "approval", decision: "allow" }), resumed(7)]));
    expect(v.items.find((i): i is UserItem => i.kind === "user" && i.seq === 5)!.delivery).toBe("delivered");
  });

  test("not delivered when the run ends first", () => {
    const v = threadView(
      load([...base, userMsg(5, "also check lint", "held"), ev(6, "run.cancelled", { by: null, reason: "user" }), resolved(7, R1, null), ended(8, RUN, "cancelled")]),
    );
    expect(v.items.find((i): i is UserItem => i.kind === "user" && i.seq === 5)!.delivery).toBe("not_delivered");
    expect(v.active).toBeNull();
    expect(v.pending).toEqual([]);
  });
});

describe("tools and input cards (§5.4, §5.6)", () => {
  test("a tool call waits on its approval, then shows its result", () => {
    const evs = [started(1), toolCall(2, "t1", "Bash", { command: "npm test -- --watch=false" }, "needs_approval"), requested(3, R1, approvalPrompt("t1"))];
    let v = threadView(load(evs));
    expect(v.items.find((i): i is ToolItem => i.kind === "tool")!.state).toBe("waiting");
    expect(v.pending).toMatchObject([{ request_id: R1, prompt: { type: "approval" } }]);
    v = threadView(load([...evs, resolved(4, R1, { type: "approval", decision: "allow" }), toolResult(5, "t1")]));
    expect(v.items.find((i): i is ToolItem => i.kind === "tool")!.state).toBe("ok");
    expect(v.items.find((i): i is InputItem => i.kind === "input")!.resolution).toMatchObject({ state: "answered", answered_by: expect.any(String) });
    expect(v.pending).toEqual([]);
  });

  test("a question replaces its AskUserQuestion tool row", () => {
    const v = threadView(load([started(1), toolCall(2, "q1", "AskUserQuestion", { questions: [] }), requested(3, R1, questionPrompt("q1"))]));
    expect(v.items.map((i) => i.kind)).toEqual(["run", "input"]);
  });

  test("a call without a result after its run ended has no result", () => {
    const v = threadView(load([started(1), toolCall(2, "t1"), ended(3, RUN, "failed")]));
    expect(v.items.find((i): i is ToolItem => i.kind === "tool")!.state).toBe("no_result");
  });

  test("Did this happen? is pending until answered (§5.4)", () => {
    const prompt = { type: "ambiguous_tool_call", tool: "Bash", tool_call_id: "t1", class: "destructive", input: { kind: "inline", value: { command: "make deploy" } } };
    const evs = [started(1), toolCall(2, "t1", "Bash", { command: "make deploy" }), resumed(3, RUN, "runtime_restart"), requested(4, R1, prompt)];
    expect(threadView(load(evs)).pending).toMatchObject([{ prompt: { type: "ambiguous_tool_call" } }]);
    const after = threadView(load([...evs, resolved(5, R1, { type: "ambiguous_tool_call", outcome: "completed" }), toolResult(6, "t1", "resolved_completed")]));
    expect(after.pending).toEqual([]);
    expect(after.items.find((i): i is ToolItem => i.kind === "tool")!.state).toBe("resolved_completed");
  });

  test("requests from before the window are pending unless resolved in it", () => {
    const req = (request_id: string) => ({
      request_id,
      run_id: RUN,
      kind: "question",
      tool_call_id: null,
      prompt: questionPrompt(),
      state: "pending",
      requested_at: 1,
      expires_at: null,
      answered_at: null,
      response: null,
      answered_by: null,
    });
    let s = load([started(10)]);
    s = reduceThread(s, { type: "pending", requests: [req(R1), req(R2)] as never });
    expect(threadView(s).pending.map((p) => p.request_id)).toEqual([R1, R2]);
    s = reduceThread(s, { type: "event", event: resolved(11, R2, { type: "question", answers: [{ selected: ["main"] }, { selected: ["lint"] }] }) as never });
    expect(threadView(s).pending.map((p) => p.request_id)).toEqual([R1]);
    expect(threadView(s).active).toMatchObject({ state: "waiting_input" });
  });
});

describe("runs", () => {
  test("the latest unfinished run is active; a stop request marks it stopping", () => {
    let v = threadView(load([started(1), final(2, "m", "x"), ended(3), started(4, RUN2)]));
    expect(v.active).toMatchObject({ run_id: RUN2, state: "running", stopping: false });
    v = threadView(load([started(1, RUN2), ev(2, "run.cancelled", { by: null, reason: "user" }, RUN2)]));
    expect(v.active!.stopping).toBe(true);
  });

  test("a summary's active run is used when its run.started is before the window", () => {
    const v = threadView(load([final(9, "m", "x")]), { run_id: RUN, state: "pending" });
    expect(v.active).toMatchObject({ run_id: RUN, state: "pending" });
  });

  test("the persisted part is derived once per events array", () => {
    const s = load([started(1), final(2, "m", "x")]);
    expect(threadView(s).items[0]).toBe(threadView(s).items[0]);
  });
});
