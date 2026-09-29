import { afterEach, describe, expect, test } from "bun:test";
import type { FakeScript, FakeSession } from "../../../src/agent/fake-engine";
import { getRunRow } from "../../../src/store/rows";
import { monitorSpec } from "../../helpers";
import { HOUR, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const T0 = Date.UTC(2026, 0, 5, 0, 1);
const hourly = { kind: "cron", cron: "0 * * * *", timezone: "UTC", catchup: "run_once", max_catchup: 1 };

type Judge = (s: FakeSession, prompt: string) => Promise<void>;

/** Check sessions (they ask for structured output) go to `judge`; act sessions echo. */
function script(judge: Judge): { script: FakeScript; checks: FakeSession[]; acts: FakeSession[] } {
  const checks: FakeSession[] = [];
  const acts: FakeSession[] = [];
  return {
    checks,
    acts,
    script: async (s) => {
      if (s.opts.outputSchema) {
        checks.push(s);
        const i = (await s.nextInput())!;
        await judge(s, i.text);
        return;
      }
      acts.push(s);
      for (let i = await s.nextInput(); i; i = await s.nextInput()) {
        s.emit({ type: "message", messageId: `m-${i.uuid}`, text: "done" });
        s.result([i.uuid], { cost: 0.02 });
      }
    },
  };
}

async function modelMonitor(rr: Rig, o: { source?: boolean; max_run_usd?: number } = {}) {
  const spec = monitorSpec({
    schedule: hourly,
    roots: [rr.sr.dir],
    max_run_usd: o.max_run_usd ?? 1,
    check: {
      kind: "model",
      model: "haiku",
      instructions: "Report when the file mentions a release.",
      ...(o.source === false ? {} : { source: { type: "file_hash", path: rr.file } }),
    },
  });
  const { task, thread_id } = (await rr.shell.call("tasks.create", { spec } as never)) as { task: { task_id: string }; thread_id: string };
  return { taskId: task.task_id, threadId: thread_id };
}

describe("model checks (§8.3)", () => {
  test("with a source: one tool-less judgement; no change is quiet and saves the model's state", async () => {
    const s = script(async (f) => f.result(null, { cost: 0.003, structured: { changed: false, evidence: "No release mentioned.", new_state: { seen: 1 } } }));
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r);
    await r.step(59 * MIN);
    expect(s.checks.length).toBe(1);
    const o = s.checks[0]!.opts;
    expect(o).toMatchObject({ builtinTools: [], mcpServers: {}, maxTurns: 3, resume: null, model: "haiku" });
    expect(o.systemPrompt).toBeString();
    expect(o.outputSchema).toMatchObject({ type: "object" });
    expect(o.initialInputs[0]!.text).toContain("Report when the file mentions a release.");
    const run = r.runs(m.taskId)[0]!;
    expect(run).toMatchObject({ state: "succeeded", outcome: "no_change" });
    expect(getRunRow(r.sr.rt.store, run.run_id)!.cost_usd).toBeCloseTo(0.003);
    expect(r.state(m.taskId)).toMatchObject({ version: 1, state: { seen: 1 } });
    expect(r.events(m.threadId)).toEqual([]);
    const got = (await r.shell.call("runs.get", { run_id: run.run_id } as never)) as { run: { check_result: unknown } };
    expect(got.run.check_result).toMatchObject({ changed: false, evidence: "No release mentioned." });
  });

  test("a change starts the act step with the evidence, on the budget the check left", async () => {
    const s = script(async (f) => f.result(null, { cost: 0.25, structured: { changed: true, evidence: "v2 is out.", new_state: { v: 2 } } }));
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r);
    await r.step(59 * MIN);
    expect(s.acts.length).toBe(1);
    expect(s.acts[0]!.opts.maxBudgetUsd).toBeCloseTo(0.75);
    expect(s.acts[0]!.opts.initialInputs[0]!.text).toContain("v2 is out.");
    expect(s.acts[0]!.opts.resume).toBe(null);
    const run = r.runs(m.taskId)[0]!;
    expect(run).toMatchObject({ state: "succeeded", outcome: "changed" });
    expect(getRunRow(r.sr.rt.store, run.run_id)!.cost_usd).toBeCloseTo(0.27);
    expect(r.state(m.taskId)).toMatchObject({ version: 1, state: { v: 2 } });
  });

  test("the result may come as JSON text when structured output is missing", async () => {
    const s = script(async (f) => f.result(null, { text: 'Here: ```json\n{"changed": false, "evidence": "ok", "new_state": null}\n```' }));
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r);
    await r.step(59 * MIN);
    expect(r.runs(m.taskId)[0]).toMatchObject({ state: "succeeded", outcome: "no_change" });
  });

  test("an invalid result fails the run, retries, and never touches the state", async () => {
    const s = script(async (f) => f.result(null, { structured: { changed: "maybe" } }));
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r);
    await r.step(59 * MIN);
    await r.step(10 * MIN);
    expect(r.runs(m.taskId).map((x) => x.state)).toEqual(["failed", "failed", "failed"]);
    expect(r.state(m.taskId)).toBe(null);
    const row = getRunRow(r.sr.rt.store, r.runs(m.taskId)[0]!.run_id)!;
    expect(JSON.parse(row.error!)).toMatchObject({ code: "invalid_check_result" });
  });

  test("without a source the check uses the task's tools, but only calls the policy allows outright", async () => {
    const decisions: Array<boolean> = [];
    const s = script(async (f) => {
      decisions.push((await f.tool({ toolCallId: "t1", tool: "Read", input: { file_path: r!.file } })).allow);
      decisions.push((await f.tool({ toolCallId: "t2", tool: "Write", input: { file_path: r!.file, content: "x" } })).allow);
      f.result(null, { structured: { changed: false, evidence: "looked", new_state: null } });
    });
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r, { source: false });
    await r.step(59 * MIN);
    expect(s.checks[0]!.opts).toMatchObject({ builtinTools: ["Read"], maxTurns: 12 });
    expect(decisions).toEqual([true, false]);
    expect(r.runs(m.taskId)[0]).toMatchObject({ state: "succeeded" });
    // Nothing the check did is in the thread.
    expect(r.events(m.threadId)).toEqual([]);
  });

  test("a check that has used the whole run budget cannot act", async () => {
    const s = script(async (f) => f.result(null, { cost: 1, structured: { changed: true, evidence: "x", new_state: null } }));
    r = await rig({ start: T0, script: s.script });
    const m = await modelMonitor(r, { max_run_usd: 1 });
    await r.step(59 * MIN);
    expect(s.acts.length).toBe(0);
    const row = getRunRow(r.sr.rt.store, r.runs(m.taskId)[0]!.run_id)!;
    expect(row.state).toBe("failed");
    expect(JSON.parse(row.error!)).toMatchObject({ code: "error_max_budget_usd" });
    void HOUR;
  });
});
