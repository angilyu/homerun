import { beforeEach, describe, expect, test } from "bun:test";
import { AppClient } from "../src/client";
import { groupThreads, ThreadList } from "../src/threads/list";
import { Rpc } from "../src/rpc";
import { RpcCallError } from "../src/errors";
import { threadView } from "../src/threads/timeline";
import { FakeEnv, FakeTransport, OTHER_THREAD, RUN, THREAD, delta, final, flush, started, uuid, userMsg } from "./helpers";

const summary = (thread_id: string, last_seq: number, updated_at: number, over: Record<string, unknown> = {}) => ({
  thread_id,
  task_id: null,
  title: null,
  last_seq,
  updated_at,
  last_message: null,
  unread_count: 0,
  input_pending: false,
  active_run: null,
  ...over,
});

/** A runtime with one thread whose history the test controls. */
function runtime(history: any[] = []) {
  const t = new FakeTransport();
  const sent = new Map<string, number>();
  let seq = history.length;
  t.handlers = {
    "threads.list": () => ({ threads: [], has_more: false }),
    "tasks.list": () => ({ tasks: [] }),
    "schedules.list": () => ({ schedules: [] }),
    "input.list_pending": () => ({ requests: [] }),
    "threads.history": (p) => {
      const evs = history.filter((e) => (p.before_seq === undefined || e.seq < p.before_seq)).slice(-p.limit);
      return { events: evs, has_more: evs.length > 0 && evs[0].seq > 1 };
    },
    "threads.subscribe": (p) => ({ subscription_id: uuid(), last_seq: p.after_seq ?? 0 }),
    "threads.unsubscribe": () => ({ ok: true }),
    "threads.mark_read": () => ({ ok: true }),
    "runs.stop": () => ({ state: "running" }),
    "messages.send": (p) => {
      // Idempotent on client_msg_id (§5.7).
      if (!sent.has(p.client_msg_id)) sent.set(p.client_msg_id, ++seq);
      return { seq: sent.get(p.client_msg_id), run_id: RUN, disposition: "started_run" };
    },
  };
  return { t, sent };
}

let env: FakeEnv;
beforeEach(() => {
  env = new FakeEnv();
});

describe("ThreadSync (§5.2)", () => {
  test("loads the latest page, then subscribes from its last seq", async () => {
    const { t } = runtime([userMsg(1, "hi"), started(2), final(3, "m", "hello")]);
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    expect(t.called("threads.subscribe").at(-1)!.params).toEqual({ thread_id: THREAD, after_seq: 3 });
    expect(threadView(sync.store.get()).items.map((i) => i.kind)).toEqual(["user", "run", "assistant"]);
  });

  test("a seq gap resubscribes from the last seq held", async () => {
    const { t } = runtime([started(1)]);
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    const before = t.called("threads.subscribe").length;
    t.notify("thread.event", { subscription_id: uuid(), event: final(3, "m", "x") });
    await flush();
    expect(t.called("threads.subscribe").length).toBe(before + 1);
    expect(t.called("threads.subscribe").at(-1)!.params.after_seq).toBe(1);
    expect(t.called("threads.unsubscribe").length).toBeGreaterThan(0);
  });

  test("events go to the sync of their thread; deltas stream", async () => {
    const { t } = runtime([started(1)]);
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    t.notify("thread.event", { subscription_id: uuid(), event: delta(1, "m", 0, "Hi") });
    t.notify("thread.event", { subscription_id: uuid(), event: { ...started(1), thread_id: OTHER_THREAD } });
    expect(sync.store.get().streams[0]!.text).toBe("Hi");
    let bad: string | null = null;
    const c2 = new AppClient(t, { env, onProtocolError: (w) => (bad = w) });
    c2.start();
    t.notify("thread.event", { event: { nope: true } });
    expect(bad!).toBe("thread.event");
  });

  test("a message sent while offline queues, then goes out once with its original time (§9.4)", async () => {
    const { t, sent } = runtime();
    const c = new AppClient(t, { env });
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.send("hello");
    expect(sync.store.get().outbox[0]).toMatchObject({ state: "queued", created_at: env.t });
    const created = env.t;
    env.advance(5000);
    t.ready();
    await flush();
    await flush();
    const sends = t.called("messages.send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.params).toMatchObject({ text: "hello", sent_at: created });
    expect(sent.size).toBe(1);
    // A second reconnect before the user.message arrives retries with the same id: still one message.
    t.ready();
    await flush();
    await flush();
    expect(t.called("messages.send")).toHaveLength(2);
    expect(sent.size).toBe(1);
  });

  test("a remote client seals a message at the relay while its desktop is offline (§9.4)", async () => {
    const { t, sent } = runtime();
    const queued: any[] = [];
    (t as any).queueInstruction = async (i: any) => {
      queued.push(i);
      return { expires_at: env.t + 12 * 3600_000 };
    };
    t.setStatus({ state: "offline", reason: "desktop", last_seen_at: env.t - 60_000 });
    const c = new AppClient(t, { env, role: "web" });
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.send("hello");
    expect(queued).toEqual([{ thread_id: THREAD, client_msg_id: expect.any(String), text: "hello" }]);
    const item = sync.store.get().outbox[0]!;
    expect(item).toMatchObject({ state: "relayed", expires_at: env.t + 12 * 3600_000 });
    expect(threadView(sync.store.get()).items.at(-1)).toMatchObject({ kind: "user", delivery: "relayed", expires_at: item.expires_at });
    // Back online: the desktop applies the sealed copy itself, so this client doesn't send it again.
    t.ready();
    await flush();
    await flush();
    expect(t.called("messages.send")).toHaveLength(0);
    expect(sent.size).toBe(0);
  });

  test("if the relay refuses too, the message stays queued and goes out on reconnect", async () => {
    const { t, sent } = runtime();
    (t as any).queueInstruction = async () => {
      throw new Error("relay unreachable");
    };
    const c = new AppClient(t, { env, role: "ios" });
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.send("hello");
    expect(sync.store.get().outbox[0]).toMatchObject({ state: "queued" });
    t.ready();
    await flush();
    await flush();
    expect(sent.size).toBe(1);
  });

  test("a rejected send is failed with its reason and can be resent", async () => {
    const { t } = runtime();
    t.handlers["messages.send"] = () => {
      throw new RpcCallError(-32010, "Thread is archived");
    };
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    await sync.send("x");
    const o = sync.store.get().outbox[0]!;
    expect(o).toMatchObject({ state: "failed", error: "Thread is archived" });
    await sync.resend("x", o.client_msg_id);
    expect(sync.store.get().outbox).toHaveLength(1);
    expect(sync.store.get().outbox[0]!.client_msg_id).not.toBe(o.client_msg_id);
  });

  test("markRead moves the marker forward only", async () => {
    const { t } = runtime([started(1), final(2, "m", "x")]);
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    await sync.markRead();
    await sync.markRead();
    expect(t.called("threads.mark_read").map((x) => x.params)).toEqual([{ thread_id: THREAD, seq: 2 }]);
  });

  test("a released thread lingers, then unsubscribes", async () => {
    const { t } = runtime();
    const c = new AppClient(t, { env, keepThreadMs: 1000 });
    t.ready();
    c.start();
    const a = c.retainThread(THREAD);
    await a.sync.open();
    a.release();
    const b = c.retainThread(THREAD);
    expect(b.sync).toBe(a.sync);
    b.release();
    env.advance(999);
    expect(t.called("threads.unsubscribe")).toHaveLength(0);
    env.advance(1);
    expect(t.called("threads.unsubscribe")).toHaveLength(1);
    expect(c.retainThread(THREAD).sync).not.toBe(a.sync);
  });

  test("loadEarlier prepends the page before the window", async () => {
    const hist = Array.from({ length: 60 }, (_, i) => final(i + 1, `m${i}`, `t${i}`));
    const { t } = runtime(hist);
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await sync.open();
    expect(sync.store.get().events).toHaveLength(50);
    expect(sync.store.get().has_earlier).toBe(true);
    await sync.loadEarlier();
    expect(sync.store.get().events).toHaveLength(60);
    expect(sync.store.get().has_earlier).toBe(false);
  });
});

describe("thread list (§9.8)", () => {
  test("threads.changed patches the list; stale summaries lose", async () => {
    const { t } = runtime();
    t.handlers["threads.list"] = () => ({ threads: [summary(THREAD, 5, 100), summary(OTHER_THREAD, 2, 200)], has_more: false });
    const c = new AppClient(t, { env });
    t.ready();
    c.start();
    await flush();
    expect(c.threads.store.get().threads.map((x) => x.thread_id as string)).toEqual([OTHER_THREAD, THREAD]);
    t.notify("threads.changed", { summary: summary(THREAD, 6, 300, { input_pending: true }) });
    expect(c.threads.store.get().threads.map((x) => x.thread_id as string)).toEqual([THREAD, OTHER_THREAD]);
    t.notify("threads.changed", { summary: summary(THREAD, 5, 400) });
    expect(c.threads.get(THREAD)!.last_seq).toBe(6);
    // The inbox refreshes once per burst.
    const before = t.called("input.list_pending").length;
    t.notify("threads.changed", { summary: summary(OTHER_THREAD, 3, 500, { input_pending: true }) });
    env.advance(150);
    expect(t.called("input.list_pending").length).toBe(before + 1);
  });

  test("groups: needs you, running, recent", () => {
    const g = groupThreads([
      summary("a", 1, 3, { input_pending: true, active_run: { run_id: RUN, state: "waiting_input" } }),
      summary("b", 1, 2, { active_run: { run_id: RUN, state: "running" } }),
      summary("c", 1, 1),
    ] as never);
    expect([g.needs_you, g.running, g.recent].map((x) => x.map((t) => t.thread_id as string))).toEqual([["a"], ["b"], ["c"]]);
  });

  test("loadMore pages by updated_before", async () => {
    const { t } = runtime();
    t.handlers["threads.list"] = (p) =>
      p.updated_before ? { threads: [summary(OTHER_THREAD, 1, 50)], has_more: false } : { threads: [summary(THREAD, 1, 100)], has_more: true };
    t.ready();
    const list = new ThreadList(new Rpc(t));
    await list.load();
    await list.loadMore();
    expect(t.called("threads.list").at(-1)!.params).toEqual({ limit: 100, updated_before: 100 });
    expect(list.store.get().threads).toHaveLength(2);
  });
});

describe("runtime status", () => {
  test("results that don't match the protocol are refused", async () => {
    const { t } = runtime();
    t.handlers["threads.list"] = () => ({ threads: "nope" });
    t.ready();
    const list = new ThreadList(new Rpc(t));
    await list.load();
    expect(list.store.get().error).toContain("didn't understand");
  });

  test("the digest notification is kept until read", () => {
    const { t } = runtime();
    const c = new AppClient(t, { env });
    c.start();
    t.notify("health.digest_ready", { digest: { nope: 1 } });
    expect(c.digest.get()).toBeNull();
  });
});
