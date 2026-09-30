import { afterEach, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { newPipeName } from "@homerun/client";
import { METHODS, NOTIFICATIONS, PROTOCOL_VERSION, RPC_ERROR, ThreadEvent, type MethodName, type ThreadId } from "@homerun/core";
import type { FakeScript } from "../../src/agent/fake-engine";
import { RpcCallError, RpcClient } from "../../src/rpc/client";
import { Authenticator } from "../../src/rpc/auth";
import { RpcServer } from "../../src/rpc/server";
import { AlreadyRunningLockError, startRuntime } from "../../src/runtime";
import { loadConfig } from "../../src/config";
import { toContent } from "../../src/store/content";
import { insertInputRequest } from "../../src/store/rows";
import { LAUNCH_TOKEN, sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

let srt: SocketRuntime | null = null;
afterEach(async () => {
  await srt?.close();
  srt = null;
});

async function rejects(p: Promise<unknown>): Promise<RpcCallError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RpcCallError) return e;
    throw e;
  }
  throw new Error("expected an RPC error");
}

const helloParams = (role: string, auth: unknown) => ({
  protocol: { min: 1, max: PROTOCOL_VERSION },
  role,
  auth,
  client: { name: "t", version: "0" },
  capabilities: [],
});

/** Collect `thread.event` notifications, validated against core. */
function collect(c: RpcClient) {
  const events: ThreadEvent[] = [];
  c.onNotification((method, params) => {
    if (method !== "thread.event") return;
    const p = NOTIFICATIONS["thread.event"].params.parse(params);
    events.push(p.event);
  });
  return events;
}

describe("socket and hello (§5.2)", () => {
  test.skipIf(process.platform === "win32")("the socket is 0600 in a 0700 directory", async () => {
    srt = await socketRuntime();
    const sock = srt.rt.config.socketPath;
    expect(statSync(sock).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(sock)).mode & 0o777).toBe(0o700);
    expect(statSync(`${srt.rt.config.runDir}/dev-token`).mode & 0o777).toBe(0o600);
  });

  test("the launch token authenticates the shell; a wrong one is refused and the connection closed", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    expect(await shell.call("ping", {})).toMatchObject({ pong: true, protocol: PROTOCOL_VERSION });

    const bad = await RpcClient.connect(srt.rt.config.socketPath);
    const e = await rejects(bad.raw("hello", helloParams("shell", { kind: "launch_token", token: "b".repeat(64) })));
    expect(e.code).toBe(RPC_ERROR.UNAUTHENTICATED);
    await bad.closed;
  });

  test("requests before hello get HANDSHAKE_REQUIRED; a second hello is forbidden", async () => {
    srt = await socketRuntime();
    const c = await RpcClient.connect(srt.rt.config.socketPath);
    expect((await rejects(c.raw("ping", {}))).code).toBe(RPC_ERROR.HANDSHAKE_REQUIRED);
    await c.call("hello", helloParams("shell", { kind: "launch_token", token: LAUNCH_TOKEN }) as never);
    expect((await rejects(c.raw("hello", helloParams("shell", { kind: "launch_token", token: LAUNCH_TOKEN })))).code).toBe(RPC_ERROR.FORBIDDEN);
    c.close();
  });

  test("a mismatched role and credential, or no common protocol, is refused", async () => {
    srt = await socketRuntime();
    const a = await RpcClient.connect(srt.rt.config.socketPath);
    expect((await rejects(a.raw("hello", helloParams("cli", { kind: "launch_token", token: LAUNCH_TOKEN })))).code).toBe(RPC_ERROR.INVALID_PARAMS);
    await a.closed;
    const b = await RpcClient.connect(srt.rt.config.socketPath);
    const e = await rejects(b.raw("hello", { ...helloParams("shell", { kind: "launch_token", token: LAUNCH_TOKEN }), protocol: { min: 7, max: 9 } }));
    expect(e.code).toBe(RPC_ERROR.INCOMPATIBLE_PROTOCOL);
    expect(e.data).toEqual({ supported: { min: 1, max: PROTOCOL_VERSION } });
    await b.closed;
  });

  test("cli_token and paired_device arrive later: UNAUTHENTICATED", async () => {
    srt = await socketRuntime();
    const a = await RpcClient.connect(srt.rt.config.socketPath);
    expect((await rejects(a.raw("hello", helloParams("cli", { kind: "cli_token", token: "x".repeat(43) })))).code).toBe(RPC_ERROR.UNAUTHENTICATED);
  });

  test("the dev token authenticates cli_dev, which may not handle secrets", async () => {
    srt = await socketRuntime();
    const dev = await srt.dev();
    expect((await rejects(dev.raw("secrets.set", { name: "anthropic_api_key", value: "x" }))).code).toBe(RPC_ERROR.FORBIDDEN);
    expect(await dev.call("threads.create", {})).toHaveProperty("thread.thread_id");
  });

  test("the dev token is refused in release builds", () => {
    const auth = new Authenticator("release", LAUNCH_TOKEN, "d".repeat(43));
    expect(auth.check(helloParams("cli_dev", { kind: "dev_token", token: "d".repeat(43) }) as never)).toMatchObject({ ok: false });
  });

  test("a connection that never says hello is closed", async () => {
    const dir = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/hr-hello-`);
    const path = process.platform === "win32" ? newPipeName() : `${dir}/s.sock`;
    const server = new RpcServer({ socketPath: path, runDir: dir, handlers: {}, helloTimeoutMs: 50 });
    await server.start();
    const c = await RpcClient.connect(path);
    await c.closed;
    server.stop();
  });
});

describe("framing and errors", () => {
  test("parse errors, invalid frames, unknown and unimplemented methods, bad params", async () => {
    srt = await socketRuntime();
    const c = await srt.shell();
    c.writeText("{nope\n");
    expect((await rejects(c.raw("ping", {}))).code).toBe(RPC_ERROR.PARSE_ERROR);
    c.writeText('{"jsonrpc":"2.0","id":7}\n');
    expect((await rejects(c.raw("ping", {}))).code).toBe(RPC_ERROR.INVALID_REQUEST);

    expect((await rejects(c.raw("no.such", {}))).code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
    const ni = await rejects(c.raw("runs.retry", { run_id: uuid() }));
    expect(ni.code).toBe(RPC_ERROR.METHOD_NOT_FOUND);
    expect(ni.data).toEqual({ not_implemented: true });
    expect((await rejects(c.raw("threads.history", { thread_id: "nope" }))).code).toBe(RPC_ERROR.INVALID_PARAMS);
    expect((await rejects(c.raw("threads.history", { thread_id: uuid() }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });

  test("a frame over 4 MiB closes the connection", async () => {
    srt = await socketRuntime();
    const c = await srt.shell();
    c.writeText("x".repeat(4 * 1024 * 1024 + 10));
    await c.closed;
  });

  test("every to_runtime method has a handler or answers not_implemented", async () => {
    srt = await socketRuntime();
    const c = await srt.shell();
    for (const m of Object.keys(METHODS) as MethodName[]) {
      if (METHODS[m].direction !== "to_runtime" || m === "hello" || m === "cli.request_access") continue;
      const e = await c.raw(m, {}).then(() => null, (x: RpcCallError) => x);
      if (e && e.code === RPC_ERROR.METHOD_NOT_FOUND) expect(e.data).toEqual({ not_implemented: true });
    }
  });
});

describe("threads over the socket", () => {
  const script: FakeScript = async (s) => {
    for (let i = await s.nextInput(); i; i = await s.nextInput()) {
      s.emit({ type: "delta", messageId: `m-${i.uuid}`, text: "ec" });
      s.emit({ type: "delta", messageId: `m-${i.uuid}`, text: "ho" });
      s.emit({ type: "message", messageId: `m-${i.uuid}`, text: "echo" });
      s.result([i.uuid]);
    }
  };

  test("send, subscribe, stream: live deltas then persisted events, and history", async () => {
    srt = await socketRuntime({ script });
    const shell = await srt.shell();
    const got = collect(shell);
    // No key yet: the run waits.
    const { thread } = await shell.call("threads.create", { title: "t" });
    const sub = await shell.call("threads.subscribe", { thread_id: thread.thread_id, after_seq: 0 });
    expect(sub.last_seq).toBe(0);
    const sent = await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "hi" });
    expect(sent.disposition).toBe("started_run");
    await until(() => got.some((e) => e.type === "run.status"), 2000, "queued status");
    await shell.call("secrets.set", { name: "anthropic_api_key", value: "sk-ant-mock-not-a-real-key" });
    await until(() => got.some((e) => e.type === "run.end"), 2000, "run.end");

    const persistedTypes = got.filter((e) => "seq" in e).map((e) => e.type);
    expect(persistedTypes).toEqual(["user.message", "run.started", "message.final", "run.end"]);
    const seqs = got.filter((e) => "seq" in e).map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(got.filter((e) => e.type === "message.delta").length).toBeGreaterThan(0);
    const iDelta = got.findIndex((e) => e.type === "message.delta");
    const iFinal = got.findIndex((e) => e.type === "message.final");
    expect(iDelta).toBeLessThan(iFinal);

    const h = await shell.call("threads.history", { thread_id: thread.thread_id });
    expect(h.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(h.has_more).toBe(false);
    const page = await shell.call("threads.history", { thread_id: thread.thread_id, before_seq: 4, limit: 2 });
    expect(page.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(page.has_more).toBe(true);

    const runs = await shell.call("runs.list", { thread_id: thread.thread_id });
    expect(runs.runs).toHaveLength(1);
    expect((await shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("succeeded");
  });

  test("subscribe from a seq replays the backlog gap-free, then continues live", async () => {
    srt = await socketRuntime({ script });
    const shell = await srt.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: "sk-ant-mock-not-a-real-key" });
    const { thread } = await shell.call("threads.create", {});
    await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "one" });
    await srt.rt.scheduler.idle();

    const other = await srt.dev();
    const got = collect(other);
    const sub = await other.call("threads.subscribe", { thread_id: thread.thread_id, after_seq: 2 });
    expect(sub.last_seq).toBe(4);
    await until(() => got.length >= 2, 2000, "backlog");
    expect(got.map((e) => (e as { seq: number }).seq)).toEqual([3, 4]);

    await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "two" });
    await until(() => got.some((e) => e.type === "run.end" && (e as { seq: number }).seq > 4), 2000, "second run");
    const seqs = got.filter((e) => "seq" in e).map((e) => (e as { seq: number }).seq);
    expect(seqs).toEqual([3, 4, 5, 6, 7, 8]);

    await other.call("threads.unsubscribe", { subscription_id: sub.subscription_id });
    const n = got.length;
    await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "three" });
    await srt.rt.scheduler.idle();
    await Bun.sleep(20);
    expect(got.length).toBe(n);
  });

  test("concurrent sends from two clients start exactly one run; the rest steer it (§5.7)", async () => {
    srt = await socketRuntime({ script });
    const a = await srt.shell();
    const b = await srt.dev();
    const { thread } = await a.call("threads.create", {});
    const sends = Array.from({ length: 8 }, (_, i) => (i % 2 ? b : a).call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: `m${i}` }));
    const out = await Promise.all(sends);
    expect(out.filter((o) => o.disposition === "started_run")).toHaveLength(1);
    expect(out.filter((o) => o.disposition === "steered")).toHaveLength(7);
    expect(new Set(out.map((o) => o.run_id)).size).toBe(1);
    expect(new Set(out.map((o) => o.seq)).size).toBe(8);
  });

  test("runs.stop cancels a queued run", async () => {
    srt = await socketRuntime({ script });
    const shell = await srt.shell();
    const { thread } = await shell.call("threads.create", {});
    const sent = await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "hi" });
    expect(await shell.call("runs.stop", { run_id: sent.run_id })).toEqual({ state: "cancelled" });
    expect((await shell.call("runs.get", { run_id: sent.run_id })).run.state).toBe("cancelled");
    expect(await shell.call("input.list_pending", {})).toEqual({ requests: [] });
    expect((await rejects(shell.raw("runs.stop", { run_id: uuid() }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });

  test("tasks.create makes a session task with its thread", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const created = await shell.call("tasks.create", { spec: sessionSpec({ builtin: ["Read"] }) as never });
    expect(created.thread_id).toBeString();
    const r = created;
    expect((await shell.call("tasks.get", { task_id: r.task.task_id })).task.task_id).toBe(r.task.task_id);
    expect((await shell.call("tasks.list", {})).tasks).toHaveLength(1);
  });
});

describe("threads.list and blobs.get", () => {
  const echo: FakeScript = async (s) => {
    for (let i = await s.nextInput(); i; i = await s.nextInput()) {
      s.emit({ type: "message", messageId: `m-${i.uuid}`, text: `echo: ${i.text}` });
      s.result([i.uuid]);
    }
  };

  test("summaries, newest first, with the last message, pending input and the active run; paging", async () => {
    srt = await socketRuntime({ script: echo });
    const shell = await srt.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: "sk-ant-mock-not-a-real-key" });
    const a = (await shell.call("threads.create", { title: "a" })).thread;
    await Bun.sleep(2);
    const b = (await shell.call("threads.create", {})).thread;
    await Bun.sleep(2);
    const task = await shell.call("tasks.create", { spec: sessionSpec({ name: "task one" }) as never });

    expect((await shell.call("threads.list", {})).threads.map((x) => x.thread_id)).toEqual([task.thread_id, b.thread_id, a.thread_id]);

    await shell.call("messages.send", { thread_id: a.thread_id, client_msg_id: uuid(), text: "hello there" });
    await srt.rt.scheduler.idle();
    const list = await shell.call("threads.list", {});
    expect(list.has_more).toBe(false);
    const first = list.threads[0]!;
    expect(first).toMatchObject({ thread_id: a.thread_id, title: "a", unread_count: 1, input_pending: false, active_run: null, last_seq: 4 });
    expect(first.last_message).toMatchObject({ role: "assistant", preview: "echo: hello there", seq: 3 });
    expect(list.threads.find((x) => x.thread_id === b.thread_id)!.last_message).toBeNull();
    expect(list.threads.find((x) => x.thread_id === task.thread_id)).toMatchObject({ task_id: task.task.task_id, title: "task one" });

    // A queued run with a pending request: no key, so it stays pending.
    await shell.call("secrets.clear", { name: "anthropic_api_key" });
    const sent = await shell.call("messages.send", { thread_id: b.thread_id, client_msg_id: uuid(), text: "wait" });
    const questionId = uuid();
    insertInputRequest(srt.rt.store, {
      request_id: questionId,
      run_id: sent.run_id,
      kind: "question",
      tool_call_id: null,
      prompt: { type: "question", questions: [{ question: "Which?", options: [{ label: "x" }, { label: "y" }], multi_select: false, allow_freeform: false }] },
      state: "pending",
      requested_at: Date.now(),
      expires_at: null,
      answered_at: null,
      response: null,
      answered_by: null,
    } as never);
    const pb = (await shell.call("threads.list", {})).threads.find((x) => x.thread_id === b.thread_id)!;
    expect(pb).toMatchObject({ input_pending: true, active_run: { run_id: sent.run_id, state: "pending" } });
    expect(pb.last_message).toMatchObject({ role: "user", preview: "wait" });
    // First answer wins (§5.6); a second learns who answered.
    const answer = { request_id: questionId, response: { type: "question" as const, answers: [{ selected: ["x"] }] }, via: "app" as const };
    expect(await shell.call("input.answer", answer)).toEqual({ status: "applied" });
    expect(await shell.call("input.answer", answer)).toMatchObject({ status: "already_resolved", state: "answered" });

    const page1 = await shell.call("threads.list", { limit: 2 });
    expect(page1.threads).toHaveLength(2);
    expect(page1.has_more).toBe(true);
    const page2 = await shell.call("threads.list", { limit: 2, updated_before: page1.threads.at(-1)!.updated_at });
    expect(page2.threads.map((x) => x.thread_id)).toEqual([a.thread_id, b.thread_id, task.thread_id].filter((id) => !page1.threads.some((x) => x.thread_id === id)));
    expect(page2.has_more).toBe(false);
    expect((await shell.call("threads.list", { task_id: task.task.task_id })).threads.map((x) => x.thread_id)).toEqual([task.thread_id]);
  });

  test("paging never splits threads with the same updated_at across pages", async () => {
    srt = await socketRuntime();
    const dev = await srt.dev();
    const ids: ThreadId[] = [];
    for (const at of [300, 200, 200, 200, 100]) {
      const t = (await dev.call("threads.create", {})).thread;
      srt.rt.store.db.query("UPDATE threads SET updated_at = ? WHERE thread_id = ?").run(at, t.thread_id);
      ids.push(t.thread_id);
    }
    const tied = ids.slice(1, 4).sort().reverse();
    const p1 = await dev.call("threads.list", { limit: 2 });
    expect(p1).toMatchObject({ has_more: true });
    expect(p1.threads.map((t) => t.thread_id)).toEqual([ids[0]!]);
    const p2 = await dev.call("threads.list", { limit: 2, updated_before: 300 });
    expect(p2).toMatchObject({ has_more: true });
    expect(p2.threads.map((t) => t.thread_id)).toEqual(tied);
    const p3 = await dev.call("threads.list", { limit: 2, updated_before: 200 });
    expect(p3).toMatchObject({ has_more: false });
    expect(p3.threads.map((t) => t.thread_id)).toEqual([ids[4]!]);
    const p4 = await dev.call("threads.list", { limit: 4 });
    expect(p4.threads.map((t) => t.thread_id)).toEqual([ids[0]!, ...tied]);
    expect(p4.has_more).toBe(true);
  });

  test("blobs.get pages a stored blob; unknown or expired blobs are NOT_FOUND", async () => {
    srt = await socketRuntime();
    const dev = await srt.dev();
    const text = "x".repeat(5000) + "end";
    const c = toContent(srt.rt.store, text);
    expect(c.kind).toBe("blob");
    if (c.kind !== "blob") return;
    const p1 = await dev.call("blobs.get", { sha256: c.sha256, offset: 0, length: 4096 });
    expect(p1).toMatchObject({ sha256: c.sha256, size: 5003, offset: 0, eof: false });
    const p2 = await dev.call("blobs.get", { sha256: c.sha256, offset: 4096, length: 4096 });
    expect(p2.eof).toBe(true);
    expect(Buffer.from(p1.data, "base64").toString() + Buffer.from(p2.data, "base64").toString()).toBe(text);
    expect(await dev.call("blobs.get", { sha256: c.sha256, offset: 5003, length: 10 })).toMatchObject({ data: "", eof: true });
    expect((await rejects(dev.raw("blobs.get", { sha256: c.sha256, offset: 6000, length: 10 }))).code).toBe(RPC_ERROR.VALIDATION_FAILED);
    expect((await rejects(dev.raw("blobs.get", { sha256: "0".repeat(64), offset: 0, length: 10 }))).code).toBe(RPC_ERROR.NOT_FOUND);
    srt.rt.store.db.query("UPDATE blobs SET expires_at = 1 WHERE sha256 = ?").run(c.sha256);
    expect((await rejects(dev.raw("blobs.get", { sha256: c.sha256, offset: 0, length: 10 }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });
});

describe("grants (§5.6)", () => {
  test("create from settings (Trust this tool), list, and revoke", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const dev = await srt.dev();
    const task = await shell.call("tasks.create", { spec: sessionSpec({ name: "g" }) as never });
    const proposal = { tool: "mcp__github__create_issue", pattern: null, class: "write" as const };
    const { grant } = await shell.call("grants.create", { task_id: task.task.task_id, grant: proposal });
    expect(grant).toMatchObject({ ...proposal, task_id: task.task.task_id, revoked_at: null });
    expect((await dev.call("grants.list", { task_id: task.task.task_id })).grants).toEqual([grant]);
    const { revoked_at } = await dev.call("grants.revoke", { grant_id: grant.grant_id });
    expect((await shell.call("grants.list", { task_id: task.task.task_id })).grants).toEqual([]);
    expect((await shell.call("grants.list", { task_id: task.task.task_id, include_revoked: true })).grants).toEqual([{ ...grant, revoked_at }]);
    expect((await rejects(shell.raw("grants.revoke", { grant_id: uuid() }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });
});

describe("single instance", () => {
  test("a second runtime on the same data dir refuses to start", async () => {
    srt = await socketRuntime();
    const config = loadConfig({ env: { HOMERUN_DATA_DIR: srt.dir, HOMERUN_CLAUDE_PATH: "/usr/bin/false", HOME: srt.dir } });
    // Same process: the lock is taken over, but the socket still answers.
    await expect(startRuntime({ config, launchToken: null, setTmpdir: false })).rejects.toThrow(/another homerund/);
  });

  test("a live pid in the lock refuses", async () => {
    srt = await socketRuntime();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    await Bun.write(`${srt.rt.config.runDir}/homerund.lock`, String(child.pid));
    const config = loadConfig({ env: { HOMERUN_DATA_DIR: srt.dir, HOMERUN_CLAUDE_PATH: "/usr/bin/false", HOME: srt.dir } });
    await expect(startRuntime({ config, launchToken: null, setTmpdir: false })).rejects.toBeInstanceOf(AlreadyRunningLockError);
    child.kill();
    await Bun.write(`${srt.rt.config.runDir}/homerund.lock`, String(process.pid));
  });
});
