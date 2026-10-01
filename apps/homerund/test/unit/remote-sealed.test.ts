import { afterEach, describe, expect, test } from "bun:test";
import { CLOCK_SKEW_MS, type ClientMsgId, type DeviceId, type SealedBody, type SealedInner, SEALED_EXPIRY_DEFAULT_MS } from "@homerun/core";
import { type DeviceIdentity, generateDeviceKeys, identityFromStored, newMsgId, openSealed, publicOf, seal, type SealedEnvelope } from "@homerun/protocol";
import type { FakeScript } from "../../src/agent/fake-engine";
import { PairedDevices } from "../../src/remote/devices";
import { actionsFor, SealedMessages } from "../../src/remote/sealed";
import { getInputRequest, pendingInputRequests } from "../../src/store/rows";
import { DESKTOP, sessionSpec, testRuntime, until, uuid, type TestRuntime } from "../helpers";

/**
 * Sealed messages at the desktop (§9.4): every check the end-to-end suite can't reach cheaply.
 * The protocol vectors cover the cryptography; these cover what the desktop does with the result.
 */

let rt: TestRuntime | null = null;
afterEach(() => {
  rt?.close();
  rt = null;
});

const identity = (kind: "desktop" | "ios" | "web"): DeviceIdentity => identityFromStored(crypto.randomUUID() as DeviceId, kind, generateDeviceKeys());

function setup(script?: FakeScript) {
  rt = testRuntime({ ...(script ? { script } : {}), env: { HOMERUN_INPUT_GRACE_MS: "600000" } });
  const r = rt;
  const me = identity("desktop");
  const devices = new PairedDevices(r.store);
  const phone = identity("ios");
  const browser = identity("web");
  const stranger = identity("ios");
  const t0 = Date.now();
  for (const [id, platform] of [
    [phone, "ios"],
    [browser, "web"],
  ] as const) {
    const p = publicOf(id);
    devices.add({
      device_id: id.deviceId,
      name: platform,
      platform,
      claimed_platform: platform,
      method: "qr",
      static_public_key: p.static_public_key,
      signing_public_key: p.signing_public_key,
      paired_at: t0,
      last_seen_at: null,
      attest_key: null,
      attest_counter: null,
      approval_key: null,
    });
  }
  let now = t0;
  const acked: string[] = [];
  const touched: string[] = [];
  const posted: SealedEnvelope[] = [];
  const m = new SealedMessages({
    store: r.store,
    devices,
    me: () => me,
    now: () => now,
    ack: (id) => acked.push(id),
    post: async (env) => void posted.push(env),
    effects: {
      sendMessage: (p, origin) => r.manager.sendMessage(p, origin),
      createThread: (title, taskId) => r.manager.createThread(title, taskId),
      answer: (id, a) => (getInputRequest(r.store, id)?.prompt.type === "ambiguous_tool_call" ? r.manager.answerAmbiguous(id, a) : r.manager.answerInput(id, a)),
      touch: (id) => touched.push(id),
    },
  });
  const sealFrom = (from: DeviceIdentity, body: SealedBody, o: { createdAt?: number; lifetime?: number; to?: DeviceIdentity; msgId?: string } = {}) => {
    const created = o.createdAt ?? now;
    return seal({
      inner: { v: 1, msg_id: o.msgId ?? newMsgId(), sender_device_id: from.deviceId, created_at: created, expires_at: created + (o.lifetime ?? SEALED_EXPIRY_DEFAULT_MS[body.type]), body } as SealedInner,
      to: (o.to ?? me).deviceId,
      sender: from.noise,
      recipientStatic: publicKeyOf(o.to ?? me),
    });
  };
  let n = 0;
  const deliver = (env: SealedEnvelope) => m.receive(`q${++n}`, env);
  const userMessages = () => r.store.db.query<{ thread_id: string; payload: string }, []>("SELECT thread_id, payload FROM thread_events WHERE type = 'user.message'").all();
  return {
    r,
    m,
    me,
    phone,
    browser,
    stranger,
    devices,
    acked,
    touched,
    posted,
    sealFrom,
    deliver,
    userMessages,
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
  };
}

/** The run makes one tool call and ends. */
const oneCall =
  (tool: string, input: Record<string, unknown>): FakeScript =>
  async (x) => {
    const i = (await x.nextInput())!;
    await x.tool({ toolCallId: "c1", tool, input, canDefer: true });
    x.result([i.uuid]);
  };

const publicKeyOf = (id: DeviceIdentity) => id.noise.publicKey;

const instruction = (text: string, o: { thread_id?: string | null; client_msg_id?: string } = {}): SealedBody =>
  ({ type: "instruction", thread_id: o.thread_id ?? null, client_msg_id: (o.client_msg_id ?? uuid()) as ClientMsgId, text }) as SealedBody;

describe("sealed instructions (§9.4)", () => {
  test("a new chat from the phone, dated when it was sent; every message is acknowledged", async () => {
    const s = setup();
    const sentAt = s.now;
    s.advance(3 * 60 * 60 * 1000);
    await s.deliver(await s.sealFrom(s.phone, instruction("hi"), { createdAt: sentAt }));
    const [m] = s.userMessages();
    expect(JSON.parse(m!.payload)).toMatchObject({ text: "hi", sent_at: sentAt, origin: { device_id: s.phone.deviceId, surface: "ios" } });
    expect(s.touched).toEqual([m!.thread_id]);
    expect(s.acked).toEqual(["q1"]);
  });

  test("replayed, retried with a new msg_id, expired, from the future, or too long-lived: applied once at most", async () => {
    const s = setup();
    const cmid = uuid();
    const env = await s.sealFrom(s.phone, instruction("once", { client_msg_id: cmid }));
    await s.deliver(env);
    await s.deliver(env); // the relay redelivers: the seen-set drops it
    await s.deliver(await s.sealFrom(s.phone, instruction("once", { client_msg_id: cmid }))); // the phone retries
    expect(s.userMessages()).toHaveLength(1);

    const old = await s.sealFrom(s.phone, instruction("stale"), { lifetime: 60_000 });
    s.advance(60_000 + CLOCK_SKEW_MS + 1);
    await s.deliver(old);
    await s.deliver(await s.sealFrom(s.phone, instruction("future"), { createdAt: s.now + CLOCK_SKEW_MS + 60_000 }));
    await s.deliver(await s.sealFrom(s.phone, instruction("forever"), { lifetime: 100 * 60 * 60 * 1000 }));
    expect(s.userMessages()).toHaveLength(1);
    expect(s.acked).toHaveLength(6);
    const logs = s.r.logs.join("\n");
    for (const reason of ["replayed", "expired", "from_future", "lifetime_too_long"]) expect(logs).toContain(`"reason":"${reason}"`);
  });

  test("from a device that isn't paired, for another desktop, tampered, or a push sent to a desktop: dropped", async () => {
    const s = setup();
    await s.deliver(await s.sealFrom(s.stranger, instruction("who am i")));
    await s.deliver(await s.sealFrom(s.phone, instruction("not for us"), { to: identity("desktop") }));
    const env = await s.sealFrom(s.phone, instruction("tampered"));
    const bytes = env.ciphertext.split("");
    bytes[bytes.length - 5] = bytes[bytes.length - 5] === "A" ? "B" : "A";
    await s.deliver({ ...env, ciphertext: bytes.join("") });
    await s.deliver(await s.sealFrom(s.phone, { type: "push", category: "run_failed", title: "x", body: "y" } as SealedBody));
    expect(s.userMessages()).toHaveLength(0);
    expect(s.acked).toHaveLength(4);
    const logs = s.r.logs.join("\n");
    for (const reason of ["unknown_sender", "wrong_recipient", "decrypt_failed"]) expect(logs).toContain(`"reason":"${reason}"`);
    expect(logs).toContain("a desktop doesn't take pushes");
  });

  test("a refused instruction (a deleted chat) is remembered, so a redelivery doesn't retry it", async () => {
    const s = setup();
    const env = await s.sealFrom(s.phone, instruction("to nowhere", { thread_id: uuid() }));
    await s.deliver(env);
    expect(s.r.store.db.query("SELECT 1 FROM sealed_seen WHERE msg_id = ?").get(env.header.msg_id)).not.toBeNull();
    await s.deliver(env);
    expect(s.r.logs.filter((l) => l.includes("sealed message refused"))).toHaveLength(1);
  });

  test("the seen-set forgets a message once it could no longer pass the expiry check", async () => {
    const s = setup();
    await s.deliver(await s.sealFrom(s.phone, instruction("a"), { lifetime: 60_000 }));
    expect(s.r.store.db.query("SELECT count(*) AS n FROM sealed_seen").get()).toEqual({ n: 1 });
    s.advance(60_000 + CLOCK_SKEW_MS + 1);
    await s.deliver(await s.sealFrom(s.phone, instruction("b")));
    expect(s.r.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sealed_seen").get()!.n).toBe(1);
  });
});

describe("lock-screen answers (§9.7)", () => {
  async function waiting(s: ReturnType<typeof setup>, tool: "Write" | "Bash") {
    const task = s.r.manager.createTask(sessionSpec({ builtin: [tool] }) as never);
    const run = s.r.manager.sendMessage({ thread_id: task.thread.thread_id, client_msg_id: uuid(), text: "go" }, DESKTOP(s.r.ctx.device.device_id));
    await until(() => pendingInputRequests(s.r.store, { runId: run.run_id }).length === 1);
    return pendingInputRequests(s.r.store, { runId: run.run_id })[0]!;
  }
  const answer = (request_id: string, decision: "allow" | "deny"): SealedBody => ({ type: "answer", request_id, response: { type: "approval", decision }, via: "notification" }) as SealedBody;

  test("a phone's answer to a write approval applies; a browser's never does", async () => {
    const input = { file_path: "/tmp/hr-report.md", content: "x" };
    const s = setup(oneCall("Write", input));
    const req = await waiting(s, "Write");
    expect(actionsFor(req.prompt)).toEqual({ actions: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] });
    await s.deliver(await s.sealFrom(s.browser, answer(req.request_id, "allow")));
    expect(getInputRequest(s.r.store, req.request_id)!.state).toBe("pending");
    await s.deliver(await s.sealFrom(s.phone, answer(req.request_id, "deny")));
    expect(getInputRequest(s.r.store, req.request_id)).toMatchObject({ state: "answered", answered_by: s.phone.deviceId, response: { decision: "deny" } });
  });

  test("a destructive approval is never answered from a notification, and its push offers no actions", async () => {
    const input = { command: "rm -rf build" };
    const s = setup(oneCall("Bash", input));
    const req = await waiting(s, "Bash");
    expect(actionsFor(req.prompt)).toEqual({});
    await s.deliver(await s.sealFrom(s.phone, answer(req.request_id, "allow")));
    expect(getInputRequest(s.r.store, req.request_id)!.state).toBe("pending");
    expect(s.r.logs.join("\n")).toContain("this request must be answered in the app");
  });

  test("a question offers its options as buttons only when every label fits on one", () => {
    const q = (labels: string[]) => ({ type: "question", questions: [{ question: "Which?", header: "Pick", options: labels.map((label) => ({ label })), multi_select: false, allow_freeform: false }] }) as never;
    expect(actionsFor(q(["Yes", "No"]))).toEqual({ actions: [{ id: "option:0", label: "Yes" }, { id: "option:1", label: "No" }] });
    expect(actionsFor(q(["Yes", "x".repeat(65)]))).toEqual({});
  });

  test("an answer older than an hour is expired", async () => {
    const input = { file_path: "/tmp/hr-report.md", content: "x" };
    const s = setup(oneCall("Write", input));
    const req = await waiting(s, "Write");
    const env = await s.sealFrom(s.phone, answer(req.request_id, "allow"));
    s.advance(SEALED_EXPIRY_DEFAULT_MS.answer + CLOCK_SKEW_MS + 1);
    await s.deliver(env);
    expect(getInputRequest(s.r.store, req.request_id)!.state).toBe("pending");
  });
});

describe("pushes (§9.7)", () => {
  test("to each paired iPhone only, sealed to its key, with the notifier's text", async () => {
    const input = { file_path: "/tmp/hr-report.md", content: "x" };
    const s = setup(oneCall("Write", input));
    const task = s.r.manager.createTask(sessionSpec({ builtin: ["Write"], name: "Reports" }) as never);
    const run = s.r.manager.sendMessage({ thread_id: task.thread.thread_id, client_msg_id: uuid(), text: "go" }, DESKTOP(s.r.ctx.device.device_id));
    await until(() => pendingInputRequests(s.r.store, { runId: run.run_id }).length === 1);
    const req = pendingInputRequests(s.r.store, { runId: run.run_id })[0]!;
    s.m.push({ key: `input:${req.request_id}`, kind: "approval", target: { screen: "thread", thread_id: task.thread.thread_id }, thread_id: task.thread.thread_id, title: "Reports", body: "Approval needed: Write (write)", created_at: s.now } as never);
    s.m.push({ key: "digest:1", kind: "digest", target: { screen: "health" }, thread_id: null, title: "Daily monitor summary", body: "x", created_at: s.now } as never);
    await until(() => s.posted.length > 0);
    await Bun.sleep(5);
    expect(s.posted.map((e) => [e.header.to_device_id, e.header.kind])).toEqual([[s.phone.deviceId, "push"]]);
    expect(s.posted[0]!.header.expires_at - s.now).toBe(SEALED_EXPIRY_DEFAULT_MS.push);
    expect(JSON.stringify(s.posted)).not.toContain("Reports");
  });

  test("a withdrawal replaces only a request this runtime pushed, under the same collapse id", async () => {
    const input = { file_path: "/tmp/hr-report.md", content: "x" };
    const s = setup(oneCall("Write", input));
    const task = s.r.manager.createTask(sessionSpec({ builtin: ["Write"] }) as never);
    const run = s.r.manager.sendMessage({ thread_id: task.thread.thread_id, client_msg_id: uuid(), text: "go" }, DESKTOP(s.r.ctx.device.device_id));
    await until(() => pendingInputRequests(s.r.store, { runId: run.run_id }).length === 1);
    const req = pendingInputRequests(s.r.store, { runId: run.run_id })[0]!;
    s.m.withdraw(`input:${req.request_id}`); // never pushed: nothing to withdraw
    s.m.push({ key: `input:${req.request_id}`, kind: "approval", target: { screen: "thread", thread_id: task.thread.thread_id }, thread_id: task.thread.thread_id, title: "Homerun", body: "Approval needed: Write (write)", created_at: s.now } as never);
    s.m.push({ key: "missed:1", kind: "missed_checks", target: { screen: "health" }, thread_id: null, title: "Monitors missed checks", body: "x", created_at: s.now } as never);
    await until(() => s.posted.length === 2);
    s.m.withdraw(`input:${req.request_id}`);
    s.m.withdraw(`input:${req.request_id}`); // once only
    s.m.withdraw("missed:1");
    await until(() => s.posted.length === 3);
    await Bun.sleep(5);
    expect(s.posted).toHaveLength(3);
    const [original, other, withdrawal] = s.posted;
    expect(original!.header.collapse_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(other!.header.collapse_id).toBeUndefined();
    expect(withdrawal!.header.collapse_id).toBe(original!.header.collapse_id);
    const opened = await openSealed(withdrawal, { me: s.phone, senderStatic: () => s.me.noise.publicKey, now: s.now, seen: () => false });
    expect(opened.ok && opened.inner.body).toEqual({ type: "push", category: "input_request", title: "Answered", body: "", request_id: req.request_id, withdrawn: true } as never);
  });
});
