import { afterEach, describe, expect, test } from "bun:test";
import { NOTIFICATIONS, RPC_ERROR, type ThreadSummary } from "@homerun/core";
import { RpcCallError, RpcClient } from "../../src/rpc/client";
import { verifyAnthropicKey } from "../../src/secrets/verify";
import { LAUNCH_TOKEN, MOCK_KEY, monitorSpec, sessionSpec, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

/** What the desktop app (M7) needs from the runtime: threads.changed, unread counts, new chats on a task, key checks. */

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

function changes(c: RpcClient): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  c.onNotification((method, params) => {
    if (method === "threads.changed") out.push(NOTIFICATIONS["threads.changed"].params.parse(params).summary);
  });
  return out;
}

const webview = (s: SocketRuntime) => RpcClient.open(s.rt.config.socketPath, "webview", { kind: "launch_token", token: LAUNCH_TOKEN });

describe("threads.changed and unread counts (§9.8)", () => {
  test("a new thread, a run and its reply each update the summary on every connection", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const ui = await webview(srt);
    const seen = changes(ui);
    await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
    const { thread } = await ui.call("threads.create", { title: "Plan" });
    await until(() => seen.some((s) => s.thread_id === thread.thread_id), 2000, "created");
    await ui.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "hi" });
    await until(() => seen.some((s) => s.last_message?.role === "assistant" && s.active_run === null), 3000, "reply");
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ thread_id: thread.thread_id, title: "Plan", unread_count: 1, input_pending: false });
    expect(last.last_message?.preview).toBe("echo: hi");
    // Deltas never produce a summary; bursts coalesce.
    expect(seen.length).toBeLessThan(8);
    ui.close();
  });

  test("mark_read clears the count, only moves forward, and clamps to the last event", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
    const { thread } = await shell.call("threads.create", {});
    for (const text of ["one", "two"]) {
      await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text });
      await srt.rt.scheduler.idle();
    }
    const unread = async () => (await shell.call("threads.list", {})).threads.find((t) => t.thread_id === thread.thread_id)!.unread_count;
    expect(await unread()).toBe(2);
    await shell.call("threads.mark_read", { thread_id: thread.thread_id, seq: 4 });
    expect(await unread()).toBe(1);
    await shell.call("threads.mark_read", { thread_id: thread.thread_id, seq: 1 });
    expect(await unread()).toBe(1);
    await shell.call("threads.mark_read", { thread_id: thread.thread_id, seq: 999 });
    expect(await unread()).toBe(0);
    const err = await rejects(shell.call("threads.mark_read", { thread_id: uuid(), seq: 1 }));
    expect(err.code).toBe(RPC_ERROR.NOT_FOUND);
  });
});

describe("threads.create on a task (§2.1)", () => {
  test("a new chat on a session task runs under the task", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
    const { task } = await shell.call("tasks.create", { spec: sessionSpec({ name: "Inbox helper", builtin: ["Read"] }) as never });
    const { thread } = await shell.call("threads.create", { task_id: task.task_id });
    expect(thread).toMatchObject({ task_id: task.task_id, title: "Inbox helper" });
    const sent = await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "go" });
    await srt.rt.scheduler.idle();
    expect((await shell.call("runs.get", { run_id: sent.run_id })).run).toMatchObject({ task_id: task.task_id, task_version: 1, state: "succeeded" });
    const listed = await shell.call("threads.list", { task_id: task.task_id });
    expect(listed.threads).toHaveLength(2);
  });

  test("a monitor, an archived task and an unknown task are refused", async () => {
    srt = await socketRuntime();
    const shell = await srt.shell();
    const mon = await shell.call("tasks.create", { spec: monitorSpec({ check: { kind: "model", model: "haiku", instructions: "look" } }) as never });
    expect((await rejects(shell.call("threads.create", { task_id: mon.task.task_id }))).code).toBe(RPC_ERROR.VALIDATION_FAILED);
    const s = await shell.call("tasks.create", { spec: sessionSpec() as never });
    await shell.call("tasks.archive", { task_id: s.task.task_id });
    expect((await rejects(shell.call("threads.create", { task_id: s.task.task_id }))).code).toBe(RPC_ERROR.VALIDATION_FAILED);
    expect((await rejects(shell.call("threads.create", { task_id: uuid() }))).code).toBe(RPC_ERROR.NOT_FOUND);
  });
});

describe("secrets.verify (§7.2)", () => {
  test("the shell may ask; the webview may not", async () => {
    const asked: string[] = [];
    srt = await socketRuntime({
      verifyKey: async (k) => {
        asked.push(k);
        return k === "sk-ant-good" ? { outcome: "valid" } : { outcome: "invalid", detail: "authentication_error" };
      },
    });
    const shell = await srt.shell();
    expect(await shell.call("secrets.verify", { name: "anthropic_api_key", value: "sk-ant-good" })).toEqual({ outcome: "valid" });
    expect(await shell.call("secrets.verify", { name: "anthropic_api_key", value: "sk-ant-bad" })).toEqual({ outcome: "invalid", detail: "authentication_error" });
    const ui = await webview(srt);
    expect((await rejects(ui.call("secrets.verify", { name: "anthropic_api_key", value: "sk-ant-good" }))).code).toBe(RPC_ERROR.FORBIDDEN);
    ui.close();
    expect(asked).toEqual(["sk-ant-good", "sk-ant-bad"]);
    // The candidate is not kept: nothing was set.
    expect(srt.rt.secrets.get("anthropic_api_key") ?? null).toBeNull();
  });

  test("the provider's answer maps to valid, invalid or unreachable", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const reply = (status: number, body: unknown = {}) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    expect(await verifyAnthropicKey("k1", null, reply(200))).toEqual({ outcome: "valid" });
    expect(seen[0]).toEqual({ url: "https://api.anthropic.com/v1/models?limit=1", key: "k1" });
    expect(await verifyAnthropicKey("k", "http://127.0.0.1:9/", reply(429))).toEqual({ outcome: "valid" });
    expect(seen[1]!.url).toBe("http://127.0.0.1:9/v1/models?limit=1");
    expect(await verifyAnthropicKey("k", null, reply(401, { error: { type: "authentication_error" } }))).toEqual({ outcome: "invalid", detail: "authentication_error" });
    expect(await verifyAnthropicKey("k", null, reply(403, "nope"))).toEqual({ outcome: "invalid", detail: "HTTP 403" });
    expect(await verifyAnthropicKey("k", null, reply(529))).toEqual({ outcome: "unreachable", detail: "HTTP 529" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await verifyAnthropicKey("k", null, offline)).toEqual({ outcome: "unreachable", detail: "no connection" });
  });
});
