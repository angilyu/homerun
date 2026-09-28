import { describe, expect, test } from "bun:test";
import { HeldMessages, ThreadEvent, undeliveredMessages, type ThreadEvent as ThreadEventT } from "../src/index";
import * as F from "../scripts/vectors/fixtures";

let seq = 0;
let n = 0;
function ev(type: string, run_id: string | null, payload: unknown): ThreadEventT {
  return ThreadEvent.parse({ thread_id: F.THREAD, seq: ++seq, run_id, ts: 1_700_000_000_000 + seq, type, payload });
}
const origin = { device_id: F.DEVICE, surface: "desktop" };
const msg = (run: string, disposition: "started_run" | "steered" | "held", text: string) =>
  ev("user.message", run, { client_msg_id: `7c8d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e${String(++n).padStart(2, "0")}`, text, origin, disposition });
const end = (run: string, state: "succeeded" | "cancelled") =>
  ev("run.end", run, { state, outcome: null, error: null, authority: "full", cost_usd: null });
const resumed = (run: string) => ev("run.resumed", run, { reason: "ambiguity_resolved" });
const cancelled = (run: string) => ev("run.cancelled", run, { by: origin, reason: "user" });

describe("held messages (§5.7)", () => {
  test("a run stopped while it waited leaves its held messages undelivered", () => {
    const events = [msg(F.RUN, "started_run", "go"), msg(F.RUN, "held", "status?"), msg(F.RUN, "held", "and then?"), cancelled(F.RUN), end(F.RUN, "cancelled")];
    expect(undeliveredMessages(events).map((e) => e.payload.text)).toEqual(["status?", "and then?"]);
  });

  test("held messages are delivered when the run resumes after the answer", () => {
    expect(undeliveredMessages([msg(F.RUN, "started_run", "go"), msg(F.RUN, "held", "status?"), resumed(F.RUN), end(F.RUN, "succeeded")])).toEqual([]);
  });

  test("only messages held after the last resume count; steered messages and other runs are not affected", () => {
    const events = [
      msg(F.RUN, "started_run", "go"),
      msg(F.RUN, "held", "first"),
      resumed(F.RUN),
      msg(F.RUN, "steered", "steer"),
      msg(F.RUN, "held", "second"),
      msg(F.RUN2, "started_run", "other"),
      end(F.RUN2, "succeeded"),
      end(F.RUN, "cancelled"),
    ];
    expect(undeliveredMessages(events).map((e) => e.payload.text)).toEqual(["second"]);
  });

  test("the tracker reports them at the run's end, for streaming clients", () => {
    const t = new HeldMessages();
    expect(t.observe(msg(F.RUN, "held", "status?"))).toEqual([]);
    expect(t.observe(cancelled(F.RUN))).toEqual([]);
    expect(t.observe({ type: "unknown", original_type: "future.event", thread_id: F.THREAD, seq: 99, raw: {} })).toEqual([]);
    expect(t.observe(end(F.RUN, "cancelled")).map((e) => e.payload.text)).toEqual(["status?"]);
    expect(t.observe(end(F.RUN, "cancelled"))).toEqual([]);
  });
});
