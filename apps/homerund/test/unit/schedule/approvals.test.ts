import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { FakeScript } from "../../../src/agent/fake-engine";
import type { GateDecision } from "../../../src/agent/engine";
import { pendingInputRequests } from "../../../src/store/rows";
import { until } from "../../helpers";
import { HOUR, MIN, rig, type Rig } from "./rig";

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const T0 = Date.UTC(2026, 0, 5, 22, 1);
const hourly = { kind: "cron", cron: "0 * * * *", timezone: "UTC", catchup: "run_once", max_catchup: 3 };

describe("a monitor's act step that needs approval (§8.3, §5.6)", () => {
  test("defers, waits overnight with no process and no power assertion, and resumes on the answer", async () => {
    const decisions: GateDecision[] = [];
    const outside = join("/tmp", "hr-outside-roots", "report.txt");
    const call = { toolCallId: "w1", tool: "Write", input: { file_path: outside, content: "changed" }, canDefer: true };
    const script: FakeScript = async (s) => {
      if (s.index === 0) {
        const i = (await s.nextInput())!;
        // A write outside the roots asks (§5.5); the monitor's run can wait for hours.
        decisions.push(await s.tool(call));
        s.result([i.uuid], { deferred: { toolCallId: "w1", tool: "Write" } });
        return;
      }
      decisions.push(await s.tool(call));
      s.emit({ type: "message", messageId: "m-report", text: "wrote the report" });
      s.result([]);
    };
    r = await rig({ start: T0, script, env: { HOMERUN_INPUT_GRACE_MS: "0" } });
    const m = await r.fileMonitor(hourly, { builtin: ["Read", "Write"] });
    await r.step(59 * MIN); // baseline at 23:00
    const v1 = (r.state(m.taskId) as { version: number }).version;
    r.write("v2");
    await r.clock.advance(HOUR); // 00:00: changed → the act step asks
    const store = r.sr.rt.store;
    const waiting = () => r!.runs(m.taskId).find((x) => x.state === "waiting_input");
    await until(() => waiting() !== undefined && r!.sr.rt.scheduler.activeCount === 0, 5000, "the act step to defer");
    expect(decisions[0]).toMatchObject({ allow: false, defer: true });
    const act = waiting()!;
    const [req] = pendingInputRequests(store, { runId: act.run_id });
    expect(req!.prompt).toMatchObject({ type: "approval", tool: "Write" });

    // Overnight: no process, no slot, and the Mac may sleep; the state has not advanced.
    await r.step(7 * HOUR);
    expect(r.power.held).toBe(false);
    expect(r.sr.rt.scheduler.activeCount).toBe(0);
    expect(r.runs(m.taskId).find((x) => x.run_id === act.run_id)!.state).toBe("waiting_input");
    expect((r.state(m.taskId) as { version: number }).version).toBe(v1);

    // Morning: the answer resumes the same run from SQLite.
    await r.shell.call("input.answer", { request_id: req!.request_id, response: { type: "approval", decision: "allow" }, via: "app" } as never);
    await until(() => r!.runs(m.taskId).find((x) => x.run_id === act.run_id)!.state === "succeeded", 5000, "the act step to finish");
    expect(decisions[1]).toEqual({ allow: true });
    expect((r.state(m.taskId) as { version: number }).version).toBe(v1 + 1);
    expect(r.events(m.threadId, "run.resumed").map((e) => e.payload)).toEqual([{ reason: "input_answered" }]);
  });
});
