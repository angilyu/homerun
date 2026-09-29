import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ThreadEvent, isPersisted, parseThreadEventLenient } from "@homerun/core";
import { initialThreadState, reduceThread, type ThreadAction, type ThreadState } from "../src/threads/reducer";
import { threadView } from "../src/threads/timeline";
import { RUN, RUN2, THREAD, delta, ended, final, live, resumed, started, userMsg, ev } from "./helpers";

const run = (s: ThreadState, ...as: ThreadAction[]) => as.reduce(reduceThread, s);
const evt = (event: unknown): ThreadAction => ({ type: "event", event: event as never });
const loaded = (events: unknown[] = [], has_more = false) => run(initialThreadState(THREAD), { type: "latest", events: events as never, has_more });

describe("persisted events (§5.3, §6)", () => {
  test("appends in seq order, drops duplicates, flags a gap", () => {
    let s = loaded([userMsg(1, "hi"), started(2)]);
    expect(s.last_seq).toBe(2);
    s = run(s, evt(final(3, "m1", "hello")), evt(final(3, "m1", "hello")), evt(started(2)));
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.gap).toBe(false);
    s = run(s, evt(ended(5)));
    expect(s.last_seq).toBe(3);
    expect(s.gap).toBe(true);
    // The resubscription replays from 3: the gap closes.
    s = run(s, { type: "resynced" }, evt(ev(4, "run.cancelled", { by: null, reason: "user" })), evt(ended(5)));
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.gap).toBe(false);
  });

  test("the first page keeps only its contiguous tail and knows more exists", () => {
    const s = loaded([userMsg(3, "a"), started(5), final(6, "m", "x")]);
    expect(s.events.map((e) => e.seq)).toEqual([5, 6]);
    expect(s.has_earlier).toBe(true);
  });

  test("an earlier page extends the window only when it ends right before it", () => {
    let s = loaded([final(10, "m10", "x"), final(11, "m11", "y")], true);
    s = run(s, { type: "earlier", events: [final(7, "a", "a"), final(8, "b", "b")] as never, has_more: true });
    expect(s.events.map((e) => e.seq)).toEqual([10, 11]);
    s = run(s, { type: "earlier", events: [final(8, "b", "b"), final(9, "c", "c")] as never, has_more: false });
    expect(s.events.map((e) => e.seq)).toEqual([8, 9, 10, 11]);
    expect(s.has_earlier).toBe(false);
  });

  test("events of another thread are ignored", () => {
    const s = loaded();
    expect(run(s, evt({ ...started(1), thread_id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f09" }))).toBe(s);
  });

  test("an unknown event from a newer runtime keeps its seq so sync stays gap-free (§14)", () => {
    const raw = { thread_id: THREAD, seq: 1, run_id: null, ts: 1, type: "future.thing", payload: {} };
    const p = parseThreadEventLenient(raw);
    expect(p.ok).toBe(true);
    const s = run(loaded(), evt(p.ok && p.event), evt(started(2)));
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(threadView(s).items[0]).toMatchObject({ kind: "unknown", original_type: "future.thing" });
  });
});

describe("streaming (§9.8)", () => {
  test("deltas build a stream; the final replaces it", () => {
    let s = loaded([userMsg(1, "hi"), started(2)]);
    s = run(s, evt(delta(2, "m1", 0, "Hel")), evt(delta(2, "m1", 1, "lo")), evt(delta(2, "m1", 1, "lo")));
    expect(s.streams).toHaveLength(1);
    expect(s.streams[0]).toMatchObject({ text: "Hello", next: 2, gap: false });
    expect(threadView(s).items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
    s = run(s, evt(final(3, "m1", "Hello!")));
    expect(s.streams).toHaveLength(0);
    expect(threadView(s).items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello!", streaming: false });
    // A late delta for a finished message is ignored.
    expect(run(s, evt(delta(3, "m1", 2, "late"))).streams).toHaveLength(0);
  });

  test("a skipped delta marks the stream gapped", () => {
    const s = run(loaded([started(1)]), evt(delta(1, "m1", 0, "a")), evt(delta(1, "m1", 3, "d")));
    expect(s.streams[0]).toMatchObject({ text: "ad", gap: true, next: 4 });
    // Joining mid-stream (after a reconnect) is a gap too.
    expect(run(loaded([started(1)]), evt(delta(1, "m2", 5, "x"))).streams[0]!.gap).toBe(true);
  });

  test("a resumed or ended run drops its partial responses (§5.4)", () => {
    let s = run(loaded([started(1), started(2, RUN2)]), evt(delta(2, "a", 0, "x")), evt(delta(2, "b", 0, "y", RUN2)));
    s = run(s, evt(resumed(3, RUN, "runtime_restart")));
    expect(s.streams.map((x) => x.message_id)).toEqual(["b"]);
    s = run(s, evt(ended(4, RUN2)));
    expect(s.streams).toHaveLength(0);
  });

  test("run.status is kept per run until its run.end", () => {
    let s = run(loaded([started(1)]), evt(live(1, "run.status", { state: "pending", detail: "queued", queue_position: 2 })));
    expect(threadView(s).active).toMatchObject({ run_id: RUN, state: "pending", queue_position: 2 });
    s = run(s, evt(ended(2)));
    expect(s.status).toEqual({});
    expect(threadView(s).active).toBeNull();
  });
});

describe("outbox (§5.7)", () => {
  test("a message leaves the outbox when its user.message arrives", () => {
    const id = "7c8d9e0f-1a2b-4c3d-8e5f-6a7b8c9d0e01";
    let s = run(loaded(), { type: "outbox_add", item: { client_msg_id: id, text: "hi", created_at: 1, state: "sending" } });
    expect(threadView(s).items).toMatchObject([{ kind: "user", delivery: "sending", text: "hi" }]);
    s = run(s, { type: "outbox_update", client_msg_id: id, state: "failed", error: "nope" });
    expect(s.outbox[0]).toMatchObject({ state: "failed", error: "nope" });
    s = run(s, evt(userMsg(1, "hi", "started_run", RUN, id)));
    expect(s.outbox).toHaveLength(0);
    expect(threadView(s).items).toMatchObject([{ kind: "user", delivery: "delivered", seq: 1 }]);
  });
});

describe("every valid event vector reduces and renders (§14)", () => {
  const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../core/vectors/events.json"), "utf8")).cases as {
    schema: string;
    name: string;
    valid: boolean;
    value: any;
  }[];
  const valid = vectors.filter((v) => v.valid && ThreadEvent.safeParse(v.value).success);
  test("there are vectors", () => expect(valid.length).toBeGreaterThan(10));
  for (const v of valid)
    test(v.name, () => {
      const e = ThreadEvent.parse(v.value);
      const before = isPersisted(e) ? e.seq - 1 : e.after_seq;
      const base: ThreadState = { ...initialThreadState(e.thread_id), loaded: true, last_seq: before };
      const s = reduceThread(base, { type: "event", event: e });
      if (isPersisted(e)) expect(s.last_seq).toBe(e.seq);
      expect(() => threadView(s)).not.toThrow();
    });
});
