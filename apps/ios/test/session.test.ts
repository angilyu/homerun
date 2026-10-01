import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AppClient, ApprovalNotConfirmedError } from "@homerun/app-state";
import type { FakeScript } from "../../homerund/src/agent/fake-engine";
import { getInputRequest } from "../../homerund/src/store/rows";
import { sessionSpec, until } from "../../homerund/test/helpers";
import { appAttest, connected, desktop, newUser, startWorld, WORLD_START_MS, type World } from "../../homerund/test/remote/harness";
import { HistoryCache } from "../src/cache";
import type { IosConfig } from "../src/config";
import { IosSession, type OpenDesktop } from "../src/session";
import { FakeNative } from "./fake-native";
import { bunDriver } from "./sqlite";

/**
 * The iPhone app's session against the real runtime, the relay's Bun adapter and the local
 * issuer, with the Swift module faked (its Keychain outlives launches): sign in, pair by QR with
 * App Attest, approve a destructive call with Face ID, relaunch, renew the approval key after a
 * Face ID change, link by code, open a tapped notification, change person, unpair, delete the
 * account.
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

type Desk = Awaited<ReturnType<typeof desktop>>;
type Shown = { client: AppClient; opened: OpenDesktop };

const deletes: FakeScript = async (x) => {
  const i = (await x.nextInput())!;
  await x.tool({ toolCallId: "c1", tool: "Bash", input: { command: "rm -rf build" }, canDefer: true });
  x.result([i.uuid]);
};

async function signedInDesktop(o: Parameters<typeof desktop>[1] = {}) {
  const d = await desktop(w, { script: deletes, ...o, env: { HOMERUN_INPUT_GRACE_MS: "600000", ...o.env } });
  cleanup.push(() => d.srt.close());
  await connected(d.sh);
  return d;
}

/** One iPhone: its native half (Keychain, tokens, App Attest, Face ID) and its history database. */
function iphone() {
  const native = new FakeNative(w.issuer, appAttest);
  const sql = bunDriver();
  return { native, sql };
}
type Phone = ReturnType<typeof iphone>;

/** A launch of the app on `p`. */
function launch(p: Phone) {
  p.native.relaunch();
  const config: IosConfig = { relayUrl: w.relay.url, issuer: w.issuer.url, clientId: w.issuer.clientId, dev: true, version: "0.0.0" };
  const cache = new HistoryCache(p.sql, () => p.native.cacheKey(), false);
  const s = new IosSession<Shown>(
    { native: p.native, config, deviceName: "Ada's iPhone", cache, reconnect: { initialMs: 50, maxMs: 500 } },
    (opened) => ({
      opened,
      client: new AppClient(opened.transport, {
        role: opened.role,
        keepThreadMs: 0,
        cache: opened.cache,
        ...(opened.signApproval ? { signApproval: opened.signApproval } : {}),
      }),
    }),
  );
  cleanup.push(() => s.close());
  return s;
}

const phaseIs = (s: IosSession<Shown>, p: string, ms = 8000) => until(() => s.phase.get().s === p, ms, `phase ${p} (at ${s.phase.get().s})`);

function ready(s: IosSession<Shown>) {
  const p = s.phase.get();
  if (p.s !== "ready") throw new Error(`not ready: ${p.s}`);
  return p;
}

async function pairByQr(d: Desk, s: IosSession<Shown>) {
  await phaseIs(s, "link");
  const offer = await d.sh.c.call("devices.pairing.start", {});
  await s.pair(offer.qr_url);
  await phaseIs(s, "ready");
}

async function destructiveWaiting(d: Desk) {
  const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Bash"] }) as never });
  await d.sh.c.call("messages.send", { thread_id, client_msg_id: crypto.randomUUID() as never, text: "clean" });
  const deadline = Date.now() + 5000;
  for (;;) {
    const { requests } = await d.sh.c.call("input.list_pending", { thread_id });
    if (requests.length) return { thread_id, req: requests[0]! };
    if (Date.now() > deadline) throw new Error("timed out waiting for the approval");
    await Bun.sleep(10);
  }
}

/** Allows a pending destructive call from the phone's app, as the approval card does. */
async function allowFromPhone(s: IosSession<Shown>, threadId: string, req: { request_id: string; prompt: unknown; expires_at: number | null }) {
  const { sync, release } = ready(s).app.client.retainThread(threadId);
  try {
    await until(() => ready(s).app.client.runtime.get().state === "ready", 5000, "the desktop's runtime");
    return await sync.answer(req.request_id, { type: "approval", decision: "allow" }, { prompt: req.prompt as never, expires_at: req.expires_at });
  } finally {
    release();
  }
}

describe("the iPhone app's session (§9.8)", () => {
  test("signs in, pairs by QR with App Attest, gets pushes, allows a destructive call with Face ID, and relaunches into the desktop", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = iphone();
    const s = launch(p);
    await s.start();
    expect(s.phase.get()).toEqual({ s: "signed_out", notice: null, tone: "info" });
    await s.signIn();
    await pairByQr(d, s);
    const { desktopId, app } = ready(s);
    expect(app.opened.role).toBe("ios");
    expect(app.opened.signApproval).toBeDefined();
    const devices = (await d.sh.c.call("devices.list", {})).devices;
    expect(devices.map((x) => [x.name, x.platform, x.method, x.biometric_approvals])).toEqual([["Ada's iPhone", "ios", "qr", true]]);

    // The push token reached the relay: the destructive request's push comes to this phone.
    await until(() => p.native.calls.includes("pushRegister"), 5000, "push registration");
    await Bun.sleep(100);
    const before = w.apns.deliveries.length;
    const { thread_id, req } = await destructiveWaiting(d);
    await until(() => w.apns.deliveries.slice(before).some((x) => x.token === p.native.pushToken!.token), 5000, "a push");

    // Face ID cancelled: nothing is sent.
    p.native.cancelFaceId = true;
    await expect(allowFromPhone(s, thread_id, req)).rejects.toBeInstanceOf(ApprovalNotConfirmedError);
    expect(getInputRequest(d.rt.store, req.request_id)?.state).toBe("pending");
    p.native.cancelFaceId = false;
    expect(await allowFromPhone(s, thread_id, req)).toEqual({ status: "applied" });

    // Relaunch: straight into the same desktop, no sign-in, same device.
    const deviceId = s.deviceId;
    s.close();
    const again = launch(p);
    await again.start();
    await phaseIs(again, "ready");
    expect(ready(again).desktopId).toBe(desktopId);
    expect(again.deviceId).toBe(deviceId);
    // One attestation: made for registration, reused for the first pairing and the relaunch.
    expect(p.native.calls.filter((c) => c === "attest").length).toBe(1);
  }, 30_000);

  test("after a Face ID change, the phone renews its approval key with the desktop by an App Attest assertion, then approves", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = iphone();
    const s = launch(p);
    await s.start();
    await s.signIn();
    await pairByQr(d, s);
    const { thread_id, req } = await destructiveWaiting(d);

    p.native.changeFaceId();
    await expect(allowFromPhone(s, thread_id, req)).rejects.toBeInstanceOf(ApprovalNotConfirmedError);
    expect(s.attester.notice.get()).toContain("Your Mac accepted it");
    expect(p.native.calls).toContain("assertRenewal");
    await until(() => d.sh.notes.some((n) => n.method === "notification.requested" && (n.params as { kind: string }).kind === "device"), 5000, "the Mac's notice");
    expect(await allowFromPhone(s, thread_id, req)).toEqual({ status: "applied" });
  }, 30_000);

  test("without App Attest the phone pairs as a browser: no Face ID approvals, the desktop's prompt says so", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = iphone();
    p.native.appAttestSupported = false;
    const s = launch(p);
    await s.start();
    await s.signIn();
    await pairByQr(d, s);
    expect(ready(s).app.opened.role).toBe("web");
    expect(ready(s).app.opened.signApproval).toBeUndefined();
    expect((await d.sh.c.call("devices.list", {})).devices.map((x) => [x.platform, x.claimed_platform])).toEqual([["web", "ios"]]);
  }, 30_000);

  test("links a second desktop by code, switches, and a tapped notification opens its desktop and thread", async () => {
    newUser(w);
    const a = await signedInDesktop();
    const b = await signedInDesktop();
    const p = iphone();
    const s = launch(p);
    await s.start();
    await s.signIn();
    await pairByQr(a, s);
    const aId = ready(s).desktopId;

    await s.linkAnother();
    await until(() => {
      const ph = s.phase.get();
      return ph.s === "link" && ph.desktops !== null && ph.desktops.length === 1;
    }, 5000, "the other desktop");
    const ph = s.phase.get();
    if (ph.s !== "link") throw new Error("not linking");
    const other = ph.desktops![0]!;
    const before = b.sh.prompts.length;
    const linking = s.link(other);
    await until(() => b.sh.prompts.length > before, 5000, "the Mac's prompt");
    const shown = s.phase.get();
    expect(shown.s === "link" && shown.step.k === "linking" && /^\d{6}$/.test(shown.step.code ?? "")).toBe(true);
    await b.sh.c.call("devices.link.decide", { request_id: b.sh.prompts.at(-1)!.request_id, approve: true });
    await linking;
    await phaseIs(s, "ready");
    expect(ready(s).desktopId).toBe(other.device_id);
    expect(ready(s).app.opened.role).toBe("ios");
    expect(s.desktops.get().length).toBe(2);

    p.native.tapNotification({ desktop: aId, thread: "thr_tapped", request: "req_1" });
    await until(() => s.focus.get() !== null, 5000, "the tap");
    expect(ready(s).desktopId).toBe(aId);
    expect(s.focus.get()).toEqual({ desktopId: aId, threadId: "thr_tapped", requestId: "req_1" });
  }, 30_000);

  test("unpairing the last desktop starts afresh as a new device; a different person signing in does too", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = iphone();
    const s = launch(p);
    await s.start();
    await s.signIn();
    await pairByQr(d, s);
    const first = s.deviceId;
    const desktopId = ready(s).desktopId;
    expect(await s.attester.pinned(desktopId)).not.toBeNull();

    await s.unlink(desktopId);
    await phaseIs(s, "link");
    expect(s.phase.get()).toMatchObject({ notice: "This iPhone was unpaired." });
    expect(await s.attester.pinned(desktopId)).toBeNull();
    expect(s.deviceId).not.toBe(first);

    s.close();
    newUser(w, "grace");
    await p.native.authSignOut();
    const next = launch(p);
    await next.start();
    await next.signIn();
    await phaseIs(next, "link");
    expect(p.native.calls).toContain("resetDevice");
    expect(next.email).toBe("grace@example.com");
  }, 30_000);

  test("deletes the account from the phone: the relay and the provider forget it, and the phone forgets everything", async () => {
    const sub = newUser(w);
    const d = await signedInDesktop();
    const p = iphone();
    const s = launch(p);
    await s.start();
    await s.signIn();
    await pairByQr(d, s);
    await s.deleteAccount();
    expect(s.phase.get()).toMatchObject({ s: "signed_out", tone: "info" });
    expect(w.issuer.deletedUsers.has(sub)).toBe(true);
    expect(p.native.calls).toContain("wipe");
    expect(p.native.keychain.size).toBe(0);
    // The relay dropped the desktop too: it forgets this phone's pairing.
    for (const end = Date.now() + 5000; (await d.sh.c.call("devices.list", {})).devices.length; await Bun.sleep(20)) {
      if (Date.now() > end) throw new Error("timed out waiting for the desktop to forget the phone");
    }
  }, 30_000);
});
