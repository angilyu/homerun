import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppClient, approvalResponse, cantAnswer, RpcCallError, type ClientRole } from "@homerun/app-state";
import type { ClientMsgId } from "@homerun/core";
import { RelayTransport, type RemoteClient } from "@homerun/remote";
import type { FakeScript } from "../../src/agent/fake-engine";
import { sessionSpec, until } from "../helpers";
import { connected, desktop, linkByCode, newUser, pairByQr, phone, startWorld, WORLD_START_MS, type World } from "./harness";

/**
 * The shared client state layer (`@homerun/app-state`) over the relay, against the real runtime:
 * what the web client and the iPhone app run (§9.8, §9.9). The views only read these stores.
 */

let w: World;
beforeAll(async () => {
  w = await startWorld();
}, WORLD_START_MS);
afterAll(async () => {
  await w.stop();
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

const runsCommands: FakeScript = async (x) => {
  for (;;) {
    const i = await x.nextInput();
    if (!i) return;
    await x.tool({ toolCallId: `c${x.index}`, tool: "Write", input: { file_path: i.text, content: "report" }, canDefer: true });
    x.result([i.uuid]);
  }
};

async function signedInDesktop(o: Parameters<typeof desktop>[1] = {}) {
  const d = await desktop(w, { script: runsCommands, ...o, env: { HOMERUN_INPUT_GRACE_MS: "600000", ...o.env } });
  cleanup.push(() => d.srt.close());
  await connected(d.sh);
  return d;
}

function appOver(client: RemoteClient, desktopId: string, role: ClientRole) {
  const transport = new RelayTransport({ client, desktopId, clientInfo: { name: "test", version: "0.0.0" }, retry: { initialMs: 50, maxMs: 500 } });
  const app = new AppClient(transport, { role, keepThreadMs: 0 });
  app.start();
  cleanup.push(() => {
    app.stop();
    transport.close();
  });
  return { app, transport };
}

const ready = (app: AppClient) => until(() => app.connected, 5000, "ready");

describe("the shared client over the relay (§9.8, §9.9)", () => {
  test("a browser chats, sees the approval, and is told to approve on a phone or Mac; the phone approves", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const browser = await phone(w, { kind: "web" });
    cleanup.push(() => browser.client.close());
    const desk = await linkByCode(d.sh, browser.client);
    const iphone = await phone(w);
    cleanup.push(() => iphone.client.close());
    await pairByQr(d.sh, iphone.client);

    const web = appOver(browser.client, desk.device_id, "web").app;
    await ready(web);
    expect(web.deviceId).toBe(browser.client.deviceId);

    const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Write"], name: "Reports" }) as never });
    // Loaded on connect, then kept up to date by the runtime's notifications.
    await until(() => web.threads.store.get().threads.some((t) => t.thread_id === thread_id), 5000, "the new thread in the list");

    const { sync, release } = web.retainThread(thread_id);
    cleanup.push(release);
    await until(() => sync.store.get().loaded, 5000, "history");
    await sync.send("/tmp/homerun-e2e/web.md");
    await until(() => sync.store.get().events.some((e) => e.type === "user.message" && (e.payload as { origin?: { surface?: string } }).origin?.surface === "web"), 5000, "the message, from the web");
    await until(() => sync.store.get().outbox.length === 0, 5000, "the outbox to empty");

    await until(() => sync.store.get().events.some((e) => e.type === "input.requested"), 5000, "the approval");
    await web.inbox.refresh();
    const entry = web.inbox.store.get().entries[0]!;
    // The views read this and show it instead of the buttons.
    expect(cantAnswer(entry.request.prompt, "web")).toBe("Approve on your phone or Mac");
    expect(approvalResponse(entry.request.prompt as never, "allow", undefined, "web").response).toBeNull();
    // A modified client is refused by the runtime anyway.
    const refused = await sync.answer(entry.request.request_id, { type: "approval", decision: "allow" }).catch((e) => e);
    expect(refused).toBeInstanceOf(RpcCallError);
    expect((refused as Error).message).toContain("approve on your phone or Mac");

    const ios = appOver(iphone.client, desk.device_id, "ios").app;
    await ready(ios);
    const onPhone = ios.retainThread(thread_id);
    cleanup.push(onPhone.release);
    await until(() => onPhone.sync.store.get().loaded, 5000, "history on the phone");
    expect(cantAnswer(entry.request.prompt, "ios")).toBeNull();
    const ok = await onPhone.sync.answer(entry.request.request_id, approvalResponse(entry.request.prompt as never, "allow", undefined, "ios").response!);
    expect(ok.status).toBe("applied");
    // The browser sees it resolved live, by the phone.
    await until(
      () => sync.store.get().events.some((e) => e.type === "input.resolved" && (e.payload as { answered_by?: string }).answered_by === iphone.client.deviceId),
      5000,
      "the resolution, live in the browser",
    );
  }, 30_000);

  test("the desktop away: offline with when it was last seen; a message seals at the relay and is applied once it's back", async () => {
    newUser(w);
    const dir = mkdtempSync(join(tmpdir(), "hr-remote-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keychain = new Map<string, string>();
    const d1 = await desktop(w, { dir, keychain, script: runsCommands });
    await connected(d1.sh);
    const iphone = await phone(w);
    cleanup.push(() => iphone.client.close());
    const { desk } = await pairByQr(d1.sh, iphone.client);
    const { thread } = await d1.sh.c.call("threads.create", {});

    const { app, transport } = appOver(iphone.client, desk.device_id, "ios");
    await ready(app);
    const { sync, release } = app.retainThread(thread.thread_id);
    cleanup.push(release);
    await until(() => sync.store.get().loaded, 5000, "history");

    await d1.srt.close();
    await until(() => transport.status().state === "offline", 5000, "offline");
    const s = transport.status();
    expect(s).toMatchObject({ state: "offline", reason: "desktop" });

    const before = Date.now();
    await sync.send("Summarise the build log");
    await until(() => sync.store.get().outbox[0]?.state === "relayed", 5000, "sealed at the relay");
    const item = sync.store.get().outbox[0]!;
    expect(item.expires_at! - before).toBeGreaterThan(11 * 60 * 60 * 1000);

    const d2 = await signedInDesktop({ dir, keychain, signIn: false });
    await ready(app);
    await until(() => sync.store.get().events.some((e) => e.type === "user.message"), 10_000, "the message, applied");
    await until(() => sync.store.get().outbox.length === 0, 5000, "the bubble to go");
    const msgs = (await d2.sh.c.call("threads.history", { thread_id: thread.thread_id })).events.filter((e) => e.type === "user.message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload).toMatchObject({ text: "Summarise the build log", client_msg_id: item.client_msg_id as ClientMsgId });
  }, 30_000);
});
