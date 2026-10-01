import { describe, expect, test } from "bun:test";
import type { ThreadSummary } from "@homerun/core";
import { AppClient } from "../src/client";
import { ApprovalNotConfirmedError } from "../src/errors";
import { cantAnswer } from "../src/input";
import { CACHE_WRITE_MS, CACHED_EVENTS, cacheableThread, type CachedThread, type ThreadCache } from "../src/threads/cache";
import { initialThreadState, reduceThread } from "../src/threads/reducer";
import { APPROVAL_PROOF_TTL_MS, type ApprovalToSign } from "../src/threads/sync";
import { FakeEnv, FakeTransport, T0, THREAD, approvalPrompt, flush, questionPrompt, started, userMsg, uuid } from "./helpers";

class MemoryCache implements ThreadCache {
  threads = new Map<string, CachedThread>();
  list: readonly ThreadSummary[] | null = null;
  writes = 0;
  failing = false;
  loadThread = async (id: string) => this.threads.get(id) ?? null;
  saveThread = (id: string, t: CachedThread) => {
    if (this.failing) throw new Error("locked");
    this.writes++;
    this.threads.set(id, structuredClone(t));
  };
  loadList = async () => this.list;
  saveList = (t: readonly ThreadSummary[]) => {
    this.list = structuredClone(t);
  };
}

const summary = (thread_id: string, last_seq: number) =>
  ({ thread_id, task_id: null, title: null, last_seq, updated_at: T0 + last_seq, last_message: null, unread_count: 0, input_pending: false, active_run: null }) as unknown as ThreadSummary;

function runtime(history: any[]) {
  const t = new FakeTransport();
  t.handlers = {
    "threads.list": () => ({ threads: [summary(THREAD, history.length)], has_more: false }),
    "tasks.list": () => ({ tasks: [] }),
    "schedules.list": () => ({ schedules: [] }),
    "input.list_pending": () => ({ requests: [] }),
    "threads.history": (p) => ({ events: history.slice(-p.limit), has_more: false }),
    "threads.subscribe": (p) => ({ subscription_id: uuid(), last_seq: p.after_seq ?? 0 }),
    "threads.unsubscribe": () => ({ ok: true }),
    "input.answer": () => ({ status: "applied" }),
  };
  return t;
}

describe("the thread cache (§9.8)", () => {
  test("shows the cached window offline, then subscribes from its last seq without a history page", async () => {
    const env = new FakeEnv();
    const cache = new MemoryCache();
    const later = T0 + 60_000;
    cache.threads.set(THREAD, {
      events: [userMsg(1, "hi"), started(2)],
      has_earlier: false,
      outbox: [
        { client_msg_id: uuid(), text: "still at the relay", created_at: T0, state: "relayed", expires_at: later },
        { client_msg_id: uuid(), text: "expired there", created_at: T0, state: "relayed", expires_at: T0 - 1 },
      ],
    });
    const t = runtime([userMsg(1, "hi"), started(2)]);
    const c = new AppClient(t, { env, cache });
    c.start();
    const { sync } = c.retainThread(THREAD);
    await flush();
    const s = sync.store.get();
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.outbox.map((o) => o.text)).toEqual(["still at the relay"]);
    expect(t.calls).toEqual([]);

    t.ready();
    await flush();
    await flush();
    expect(t.called("threads.history")).toEqual([]);
    expect(t.called("threads.subscribe").map((x) => x.params.after_seq)).toEqual([2]);
  });

  test("writes the newest events once they settle, a message in flight as queued, and survives a failing cache", async () => {
    const env = new FakeEnv();
    const cache = new MemoryCache();
    const history = Array.from({ length: CACHED_EVENTS + 20 }, (_, i) => userMsg(i + 1, `m${i}`));
    const t = runtime(history);
    t.handlers["threads.history"] = (p) => ({ events: history.slice(-p.limit), has_more: true });
    t.handlers["messages.send"] = () => new Promise(() => {});
    const c = new AppClient(t, { env, cache });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await flush();
    await flush();
    void sync.send("on its way");
    expect(cache.writes).toBe(0);
    env.advance(CACHE_WRITE_MS);
    const kept = cache.threads.get(THREAD)!;
    expect(kept.has_earlier).toBe(true);
    expect(kept.events.at(-1)?.seq).toBe(CACHED_EVENTS + 20);
    expect(kept.outbox.map((o) => [o.text, o.state])).toEqual([["on its way", "queued"]]);

    cache.failing = true;
    sync.store.set((s) => ({ ...s, has_earlier: false }));
    expect(() => env.advance(CACHE_WRITE_MS)).not.toThrow();
  });

  test("keeps the newest contiguous events, and nothing while a gap is open", () => {
    const events = Array.from({ length: CACHED_EVENTS + 20 }, (_, i) => userMsg(i + 1, `m${i}`));
    const s = reduceThread(initialThreadState(THREAD), { type: "latest", events, has_more: false });
    const kept = cacheableThread(s)!;
    expect([kept.events.length, kept.events[0]!.seq, kept.has_earlier]).toEqual([CACHED_EVENTS, 21, true]);
    expect(cacheableThread({ ...s, gap: true })).toBeNull();
    expect(cacheableThread(initialThreadState(THREAD))).toBeNull();
  });

  test("the thread list shows what was cached until the first page replaces it", async () => {
    const env = new FakeEnv();
    const cache = new MemoryCache();
    const gone = uuid();
    cache.list = [summary(gone, 3)];
    const t = runtime([userMsg(1, "hi")]);
    const c = new AppClient(t, { env, cache });
    c.start();
    await flush();
    expect(c.threads.store.get().threads.map((x) => x.thread_id as string)).toEqual([gone]);
    t.ready();
    await flush();
    expect(c.threads.store.get().threads.map((x) => x.thread_id as string)).toEqual([THREAD]);
    env.advance(CACHE_WRITE_MS);
    expect(cache.list?.map((x) => x.thread_id as string)).toEqual([THREAD]);
  });
});

describe("Face ID approvals (§9.8, §18 row 115)", () => {
  const destructive = { prompt: approvalPrompt("t1", { tool: "Write", class: "destructive", reason: "destructive" }) as any, expires_at: T0 + 60_000 };
  const SIG = "MEUCIQDexampleexampleexampleexample";

  async function phone(signer: (a: ApprovalToSign) => Promise<{ signature: string; expires_at: number } | null>) {
    const env = new FakeEnv();
    const t = runtime([]);
    const asked: ApprovalToSign[] = [];
    const c = new AppClient(t, { env, role: "ios", signApproval: async (a) => (asked.push(a), signer(a)) });
    t.ready();
    c.start();
    const { sync } = c.retainThread(THREAD);
    await flush();
    return { t, sync, asked };
  }

  test("allowing a destructive call carries a proof that expires with the request at the latest", async () => {
    const { t, sync, asked } = await phone(async (a) => ({ signature: SIG, expires_at: a.expires_at }));
    const request_id = uuid();
    await sync.answer(request_id, { type: "approval", decision: "allow" }, destructive);
    expect(asked).toEqual([{ request_id, decision: "allow", expires_at: T0 + 60_000 }]);
    expect(t.called("input.answer")[0]!.params.approval).toEqual({ signature: SIG, expires_at: T0 + 60_000 });

    await sync.answer(uuid(), { type: "approval", decision: "allow" }, { ...destructive, expires_at: null });
    expect(asked[1]!.expires_at).toBe(T0 + APPROVAL_PROOF_TTL_MS);
  });

  test("denying, a question or a safer call needs no Face ID; a cancelled Face ID sends nothing", async () => {
    const { t, sync, asked } = await phone(async () => null);
    await sync.answer(uuid(), { type: "approval", decision: "deny" }, destructive);
    await sync.answer(uuid(), { type: "approval", decision: "allow" }, { prompt: approvalPrompt("t2", { class: "write" }) as any, expires_at: null });
    await sync.answer(uuid(), { type: "question", answers: [{ selected: ["A"] }] } as any, { prompt: questionPrompt() as any, expires_at: null });
    expect(asked).toEqual([]);
    expect(t.called("input.answer").every((x) => x.params.approval === undefined)).toBe(true);
    const before = t.called("input.answer").length;
    await expect(sync.answer(uuid(), { type: "approval", decision: "allow" }, destructive)).rejects.toBeInstanceOf(ApprovalNotConfirmedError);
    expect(t.called("input.answer").length).toBe(before);
  });

  test("an iPhone without a Face ID key leaves destructive calls to the Mac", () => {
    expect(cantAnswer(destructive.prompt, "ios", false)).toBe("Approve on your Mac");
    expect(cantAnswer(destructive.prompt, "ios", true)).toBeNull();
    expect(cantAnswer(approvalPrompt("t3", { class: "write" }) as any, "ios", false)).toBeNull();
    expect(cantAnswer(questionPrompt() as any, "ios", false)).toBeNull();
  });
});
