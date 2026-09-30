import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMsgId } from "@homerun/core";
import type { SealedEnvelope } from "@homerun/protocol";
import type { RemoteClient } from "@homerun/remote";
import type { FakeScript } from "../../src/agent/fake-engine";
import { getInputRequest } from "../../src/store/rows";
import { sessionSpec, until } from "../helpers";
import { connected, desktop, linkByCode, newUser, pairByQr, phone, startWorld, type World } from "./harness";

let w: World;
beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => {
  await w.stop();
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

type Desk = Awaited<ReturnType<typeof desktop>>;

async function signedInDesktop(o: Parameters<typeof desktop>[1] = {}) {
  const d = await desktop(w, { ...o, env: { HOMERUN_INPUT_GRACE_MS: "600000", ...o.env } });
  cleanup.push(() => d.srt.close());
  await connected(d.sh);
  return d;
}

async function aPhone(o: Parameters<typeof phone>[1] = {}) {
  const p = await phone(w, o);
  cleanup.push(() => p.client.close());
  return p;
}

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "hr-remote-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Each message is one tool call: "write <path>" writes a file outside the task's roots; anything else runs in Bash. */
const runsCommands: FakeScript = async (x) => {
  const i = (await x.nextInput())!;
  const call = i.text.startsWith("write ")
    ? { tool: "Write", input: { file_path: i.text.slice(6), content: "report" } }
    : { tool: "Bash", input: { command: i.text } };
  await x.tool({ toolCallId: `c${x.index}`, ...call, canDefer: true });
  x.result([i.uuid]);
};

async function history(d: Desk, threadId: string) {
  return (await d.sh.c.call("threads.history", { thread_id: threadId })).events;
}

async function userMessages(d: Desk) {
  const threads = (await d.sh.c.call("threads.list", {})).threads;
  const out: { thread_id: string; payload: any; ts: number }[] = [];
  for (const t of threads) for (const e of await history(d, t.thread_id)) if (e.type === "user.message") out.push({ thread_id: t.thread_id, payload: e.payload, ts: e.ts });
  return out;
}

async function eventually(fn: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const PUSH_TOKEN = "ab".repeat(32);

/** Seals an answer the phone's UI would never offer, to check the desktop refuses it anyway. */
async function forceAnswer(client: RemoteClient, desktopId: string, requestId: string, decision: "allow" | "deny") {
  const c = client as unknown as {
    sealTo(to: string, body: unknown, ms: number): SealedEnvelope;
    postSealed(env: SealedEnvelope): Promise<{ msg_id: string; status: string }>;
  };
  return c.postSealed(c.sealTo(desktopId, { type: "answer", request_id: requestId, response: { type: "approval", decision }, via: "notification" }, 60 * 60 * 1000));
}

describe("instructions while the desktop is away (§9.4)", () => {
  test("queued while it's off, delivered when it's back: dated when sent, from the phone, applied once", async () => {
    newUser(w);
    const dir = tempDir();
    const keychain = new Map<string, string>();
    const d1 = await signedInDesktop({ dir, keychain });
    const p = await aPhone();
    const { desk } = await pairByQr(d1.sh, p.client);
    await d1.srt.close();

    const cmid = crypto.randomUUID() as ClientMsgId;
    const sent = await p.client.sendInstruction(desk.device_id, { text: "What changed overnight?", client_msg_id: cmid });
    expect(sent.status).toBe("queued");
    // A retry from the phone (a new msg_id, the same client_msg_id) must not start a second chat.
    const again = await p.client.sendInstruction(desk.device_id, { text: "What changed overnight?", client_msg_id: cmid });
    const sentAt = Date.now();
    await Bun.sleep(30);

    const d2 = await signedInDesktop({ dir, keychain, signIn: false });
    await p.client.waitDelivered(again.msg_id, 10_000);
    await eventually(async () => (await userMessages(d2)).length === 1, 5000, "the instruction");
    const [m] = await userMessages(d2);
    expect(m!.payload).toMatchObject({ client_msg_id: cmid, text: "What changed overnight?", origin: { device_id: p.client.deviceId, surface: "ios" } });
    expect(m!.payload.sent_at).toBeLessThanOrEqual(sentAt);
    expect(m!.ts).toBeGreaterThan(m!.payload.sent_at);
    // The echo engine answered it: the run went through as any chat does.
    await eventually(async () => (await history(d2, m!.thread_id)).some((e) => e.type === "message.final"), 5000, "the reply");
    expect((await userMessages(d2)).length).toBe(1);
  }, 20_000);

  test("into an existing chat over a live link, as the paired browser", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone({ kind: "web" });
    const desk = await linkByCode(d.sh, p.client);

    const { thread } = await d.sh.c.call("threads.create", {});
    const r = await p.client.sendInstruction(desk.device_id, { thread_id: thread.thread_id as never, text: "Hello from the browser" });
    await p.client.waitDelivered(r.msg_id, 5000);
    await eventually(async () => (await userMessages(d)).length === 1, 5000, "the instruction");
    expect((await userMessages(d))[0]!.payload).toMatchObject({ text: "Hello from the browser", origin: { surface: "web" } });
  }, 20_000);
});

describe("pushes and lock-screen answers (§9.7)", () => {
  test("an approval reaches the phone sealed; Allow from the lock screen applies once", async () => {
    newUser(w);
    const d = await signedInDesktop({ script: runsCommands });
    const p = await aPhone();
    const { desk } = await pairByQr(d.sh, p.client);
    await p.client.registerPushToken(PUSH_TOKEN, "sandbox");

    const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Write"], name: "Nightly build" }) as never });
    const before = w.apns.deliveries.length;
    await d.sh.c.call("messages.send", { thread_id, client_msg_id: crypto.randomUUID() as ClientMsgId, text: "write /tmp/homerun-e2e/report.md" });
    await until(() => w.apns.deliveries.slice(before).some((x) => x.token === PUSH_TOKEN), 5000, "a push");
    const delivery = w.apns.deliveries.slice(before).find((x) => x.token === PUSH_TOKEN)!;
    // Apple sees the generic text; the words are inside the sealed envelope.
    expect(delivery.payload.aps).toMatchObject({ alert: { title: "Homerun", body: "You have a new update." }, "mutable-content": 1 });
    expect(delivery.body).not.toContain("report.md");
    expect(delivery.body).not.toContain("Nightly build");

    const opened = await p.client.openPush(delivery.body);
    if (!opened.sealed) throw new Error(`not sealed: ${opened.reason}`);
    const push = opened.push;
    expect(push.sender_device_id).toBe(desk.device_id);
    expect(push.body).toMatchObject({
      type: "push",
      category: "input_request",
      title: "Nightly build",
      body: "Approval needed: Write (write)",
      thread_id,
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    const requestId = push.body.request_id!;

    await p.client.answerFromLockScreen(push, "allow", { type: "approval", decision: "allow" });
    await until(() => getInputRequest(d.rt.store, requestId)?.state === "answered", 5000, "answered");
    const events = await history(d, thread_id);
    expect(events.find((e) => e.type === "input.resolved")!.payload).toMatchObject({ request_id: requestId, via: "notification", answered_by: p.client.deviceId, surface: "ios" });
    await eventually(async () => (await history(d, thread_id)).some((e) => e.type === "tool.result"), 5000, "the command ran");

    // A second tap (or a replay) changes nothing: the first answer stands.
    const r = await forceAnswer(p.client, desk.device_id, requestId, "deny");
    await p.client.waitDelivered(r.msg_id, 5000).catch(() => {});
    await Bun.sleep(100);
    expect((await history(d, thread_id)).filter((e) => e.type === "input.resolved")).toHaveLength(1);
  }, 20_000);

  test("a destructive approval is pushed without actions, and an answer from the lock screen is refused", async () => {
    newUser(w);
    const d = await signedInDesktop({ script: runsCommands });
    const p = await aPhone();
    const { desk } = await pairByQr(d.sh, p.client);
    await p.client.registerPushToken(PUSH_TOKEN, "sandbox");
    const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Bash"], name: "Cleanup" }) as never });
    const before = w.apns.deliveries.length;
    await d.sh.c.call("messages.send", { thread_id, client_msg_id: crypto.randomUUID() as ClientMsgId, text: "rm -rf build" });
    await until(() => w.apns.deliveries.slice(before).some((x) => x.token === PUSH_TOKEN), 5000, "a push");
    const opened = await p.client.openPush(w.apns.deliveries.slice(before).find((x) => x.token === PUSH_TOKEN)!.body);
    if (!opened.sealed) throw new Error("not sealed");
    const push = opened.push;
    expect(push.body.body).toBe("Approval needed: Bash (destructive)");
    expect(push.body.actions).toBeUndefined();
    await expect(p.client.answerFromLockScreen(push, "allow", { type: "approval", decision: "allow" })).rejects.toThrow();

    const r = await forceAnswer(p.client, desk.device_id, push.body.request_id!, "allow");
    await p.client.waitDelivered(r.msg_id, 5000);
    await Bun.sleep(100);
    expect(getInputRequest(d.rt.store, push.body.request_id!)?.state).toBe("pending");
    expect(d.srt.logs.join("\n")).toContain("sealed message refused");
  }, 20_000);

  test("a browser gets no pushes, and a phone without a push token misses them quietly", async () => {
    newUser(w);
    const d = await signedInDesktop({ script: runsCommands });
    const web = await aPhone({ kind: "web" });
    await linkByCode(d.sh, web.client);
    const ios = await aPhone();
    await pairByQr(d.sh, ios.client);

    const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Bash"] }) as never });
    const before = w.apns.deliveries.length;
    await d.sh.c.call("messages.send", { thread_id, client_msg_id: crypto.randomUUID() as ClientMsgId, text: "make test" });
    await until(() => d.srt.logs.some((l) => l.includes("push not sent")), 5000, "the push attempt");
    expect(w.apns.deliveries.length).toBe(before);
  }, 20_000);
});
