import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR, type PairedDevice } from "@homerun/core";
import { approvalRenewalClientDataHash, decodePairingUrl, toB64url } from "@homerun/protocol";
import { testApprovalKey, testAssertion } from "@homerun/protocol/testing";
import type { FakeScript } from "../../src/agent/fake-engine";
import { LinkDeclinedError, LiveClosedError, RpcCallError } from "@homerun/remote";
import { fakeDeviceToken } from "@homerun/testkit";
import { RpcCallError as LocalCallError } from "../../src/rpc/client";
import { sessionSpec, socketRuntime, until } from "../helpers";
import { appAttest, connected, desktop, envFor, pairByQr as pairWith, helloLive, linkByCode, newUser, phone, relayState, settled, shellFor, ON_WORKERD, startWorld, WORLD_START_MS, type World } from "./harness";
import { otherAppAttest } from "./harness";

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

async function signedInDesktop(o: Parameters<typeof desktop>[1] = {}) {
  const d = await desktop(w, o);
  cleanup.push(() => d.srt.close());
  await connected(d.sh);
  return d;
}

async function aPhone(o: Parameters<typeof phone>[1] = {}) {
  const p = await phone(w, o);
  cleanup.push(() => p.client.close());
  return p;
}

type Desk = Awaited<ReturnType<typeof signedInDesktop>>;

const pairByQr = (d: Desk, p: Awaited<ReturnType<typeof aPhone>>) => pairWith(d.sh, p.client);

const list = async (d: Desk): Promise<PairedDevice[]> => (await d.sh.c.call("devices.list", {})).devices;

describe("the relay link (§9.2, §9.4)", () => {
  test("signing in creates the desktop's keys, registers it and connects; signing out stops the link", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const stored = JSON.parse(d.sh.keychain.get("device_static_key")!);
    expect(stored).toMatchObject({ v: 1, device_id: expect.any(String) });
    const s = await d.sh.status();
    expect(s.relay).toMatchObject({ state: "connected", error: null });
    expect(s.relay.since).toBeGreaterThan(0);
    // Only public halves leave the runtime; the secret halves are never logged.
    expect(d.srt.logs.join("\n")).not.toContain(stored.x25519);
    await d.sh.c.call("account.sign_out", {});
    await relayState(d.sh, "off");
    if (!ON_WORKERD) expect(w.relay.connections()).toBe(0);
  });

  test.skipIf(ON_WORKERD)("a dropped link reconnects with backoff, and a wake retries at once", async () => {
    newUser(w);
    const d = await signedInDesktop({ remote: { linkBackoff: { initialMs: 60_000, maxMs: 60_000 } } });
    w.relay.dropConnections();
    await relayState(d.sh, "offline");
    // The backoff is a minute; the wake doesn't wait for it.
    d.sh.c.write({ jsonrpc: "2.0", method: "power.did_wake", params: { at: Date.now(), slept_at: Date.now() - 1000 } });
    await relayState(d.sh, "connected");
  });

  test("after a restart the keys and token from the keychain reconnect as the same desktop", async () => {
    newUser(w);
    const dir = mkdtempSync(join(tmpdir(), "hr-remote-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keychain = new Map<string, string>();
    const d1 = await desktop(w, { dir, keychain });
    await connected(d1.sh);
    const id = JSON.parse(keychain.get("device_static_key")!).device_id;
    await d1.srt.close();
    const d2 = await signedInDesktop({ dir, keychain, signIn: false });
    expect((await d2.sh.status()).state).toBe("signed_in");
    expect(JSON.parse(keychain.get("device_static_key")!).device_id).toBe(id);
  });

  test("a crashed runtime comes back as the same desktop: the phone's live session ends, and a new one works", async () => {
    newUser(w);
    const dir = mkdtempSync(join(tmpdir(), "hr-remote-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keychain = new Map<string, string>();
    const d1 = await desktop(w, { dir, keychain });
    cleanup.push(() => d1.srt.close());
    await connected(d1.sh);
    const p = await aPhone();
    const { desk } = await pairByQr(d1, p);
    const live = await p.client.openLive(desk.device_id);
    await helloLive(live, p.client.deviceId);
    d1.srt.crash();
    await expect(live.request("threads.list", {})).rejects.toBeDefined();
    await live.closed;

    const d2 = await signedInDesktop({ dir, keychain, signIn: false });
    expect((await list(d2)).map((x) => x.device_id)).toEqual([p.client.deviceId]);
    const again = await p.client.openLive(desk.device_id);
    expect(await helloLive(again, p.client.deviceId)).toMatchObject({ role: "ios" });
    expect(await again.request("threads.list", {})).toMatchObject({ threads: [] });
  });

  test("keys arriving after the token are waited for; keys gone from the keychain start afresh", async () => {
    newUser(w);
    const dir = mkdtempSync(join(tmpdir(), "hr-remote-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const keychain = new Map<string, string>();
    const d1 = await desktop(w, { dir, keychain });
    await connected(d1.sh);
    const p = await aPhone();
    await pairByQr(d1, p);
    const id = JSON.parse(keychain.get("device_static_key")!).device_id;
    await d1.srt.close();

    // The token first, the keys a moment later: the same desktop, still paired.
    const srt = await socketRuntime({ env: envFor(w), dir, remote: { handoverMs: 2000, linkBackoff: { initialMs: 50, maxMs: 500 } } });
    cleanup.push(() => srt.close());
    const sh = await shellFor(srt, w.issuer, { keychain, hand: false });
    await sh.c.call("secrets.set", { name: "refresh_token", value: keychain.get("refresh_token")! });
    await Bun.sleep(100);
    expect((await sh.status()).relay.state).toBe("off");
    await sh.c.call("secrets.set", { name: "device_static_key", value: keychain.get("device_static_key")! });
    await connected(sh);
    expect(JSON.parse(keychain.get("device_static_key")!).device_id).toBe(id);
    expect((await sh.c.call("devices.list", {})).devices.length).toBe(1);
    await srt.close();

    // No keys at all: once the hand-over is over, new keys, and the old pairings can't work.
    keychain.delete("device_static_key");
    const srt2 = await socketRuntime({ env: envFor(w), dir, remote: { handoverMs: 200, linkBackoff: { initialMs: 50, maxMs: 500 } } });
    cleanup.push(() => srt2.close());
    const sh2 = await shellFor(srt2, w.issuer, { keychain });
    await connected(sh2);
    expect(JSON.parse(keychain.get("device_static_key")!).device_id).not.toBe(id);
    expect((await sh2.c.call("devices.list", {})).devices).toEqual([]);
  });
});

describe("QR pairing (§9.6)", () => {
  test("a phone scans the code, both sides pin keys, and the device is listed online", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { offer, desk } = await pairByQr(d, p);
    expect(decodePairingUrl(offer.qr_url)).not.toBeNull();
    expect(offer.expires_at).toBeGreaterThan(Date.now());
    const done = d.sh.notes.find((n) => n.method === "devices.pairing_completed")!.params as { offer_id: string; device: PairedDevice };
    expect(done.offer_id).toBe(offer.offer_id);
    expect(done.device).toMatchObject({ device_id: p.client.deviceId, name: "Ada's iPhone", platform: "ios", method: "qr", online: true });
    expect(desk.statement.account).toBe(d.rt.remote.account.subject!);
    expect((await list(d)).length).toBe(1);
    // The code works once.
    const again = await aPhone({ name: "Someone else" });
    expect(again.client.pair(offer.qr_url, 1000)).rejects.toThrow();
  });

  test("pairing needs the relay link, and a cancelled offer can't be used", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const offer = await d.sh.c.call("devices.pairing.start", {});
    await d.sh.c.call("devices.pairing.cancel", { offer_id: offer.offer_id });
    const p = await aPhone();
    await expect(p.client.pair(offer.qr_url, 1000)).rejects.toThrow();
    await d.sh.c.call("account.sign_out", {});
    await relayState(d.sh, "off");
    const e = (await d.sh.c.call("devices.pairing.start", {}).catch((x) => x)) as LocalCallError;
    expect(e.code).toBe(RPC_ERROR.UNAVAILABLE);
  });
});

describe("App Attest (§9.8): an iPhone Apple didn't vouch for is a browser", () => {
  test("paired by QR, it is listed as web; it says hello as web, and has no push", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone({ attest: false });
    const { desk } = await pairByQr(d, p);
    expect((await list(d)).map((x) => [x.platform, x.claimed_platform])).toEqual([["web", "ios"]]);
    expect(p.client.role(desk.device_id)).toBe("web");
    const live = await p.client.openLive(desk.device_id);
    await expect(helloLive(live, p.client.deviceId, "ios")).rejects.toBeInstanceOf(RpcCallError);
    const web = await p.client.openLive(desk.device_id);
    expect(((await helloLive(web, p.client.deviceId, "web")) as { role: string }).role).toBe("web");
    web.close();
    await expect(p.client.registerPushToken(fakeDeviceToken(), "sandbox")).rejects.toThrow();
  });

  test("linking by code: the prompt says what it claimed, and it links as web", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone({ attest: false });
    const linked = linkByCode(d.sh, p.client);
    await until(() => d.sh.prompts.length === 1, 5000, "link prompt");
    expect(d.sh.prompts[0]).toMatchObject({ platform: "web", claimed_platform: "ios" });
    await linked;
    expect((await list(d)).map((x) => [x.platform, x.claimed_platform, x.method])).toEqual([["web", "ios", "code"]]);
  });

  // The relay checked the phone's attestation against one root and this desktop against another
  // (as a production desktop would a test root, or a phone's App Attest failing for one desktop):
  // it pairs with a browser's role instead of being refused (§18 row 102).
  const unverifiedHere = { remote: { appAttest: otherAppAttest.policy() } };

  test("an iPhone the relay registered but this desktop can't verify pairs by QR as web", async () => {
    newUser(w);
    const d = await signedInDesktop(unverifiedHere);
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    expect((await list(d)).map((x) => [x.platform, x.claimed_platform])).toEqual([["web", "ios"]]);
    expect(p.client.role(desk.device_id)).toBe("web");
    const web = await p.client.openLive(desk.device_id);
    expect(((await helloLive(web, p.client.deviceId, "web")) as { role: string }).role).toBe("web");
    web.close();
  });

  test("and links by code as web", async () => {
    newUser(w);
    const d = await signedInDesktop(unverifiedHere);
    const p = await aPhone();
    const linked = linkByCode(d.sh, p.client);
    await until(() => d.sh.prompts.length === 1, 5000, "link prompt");
    expect(d.sh.prompts[0]).toMatchObject({ platform: "web", claimed_platform: "ios" });
    await linked;
    expect((await list(d)).map((x) => [x.platform, x.claimed_platform, x.method])).toEqual([["web", "ios", "code"]]);
  });

  test("an attested iPhone keeps its role", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    expect((await list(d)).map((x) => [x.platform, x.claimed_platform])).toEqual([["ios", "ios"]]);
    expect(p.client.role(desk.device_id)).toBe("ios");
  });
});

describe("keys the keychain hasn't stored yet (§5.2)", () => {
  test("aren't used for pairing or linking until the shell confirms them", async () => {
    newUser(w);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const srt = await socketRuntime({ env: envFor(w), remote: { linkBackoff: { initialMs: 50, maxMs: 500 }, appAttest: appAttest.policy() } });
    cleanup.push(() => srt.close());
    const sh = await shellFor(srt, w.issuer, { hold });
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    await connected(sh);
    expect(srt.rt.shellSecrets.isPending("device_static_key")).toBe(true);
    const e = (await sh.c.call("devices.pairing.start", {}).catch((x) => x)) as LocalCallError;
    expect(e.code).toBe(RPC_ERROR.UNAVAILABLE);
    const p = await aPhone();
    const deskId = (await p.client.accountDevices()).find((x) => x.kind === "desktop")!.device_id;
    await expect(p.client.linkByCode(deskId, () => {}, 2000)).rejects.toThrow();
    expect(sh.prompts).toEqual([]);
    release();
    await until(() => !srt.rt.shellSecrets.isPending("device_static_key"), 5000, "keys stored");
    expect(sh.keychain.has("device_static_key")).toBe(true);
    await pairWith(sh, p.client);
    expect((await sh.c.call("devices.list", {})).devices.map((x: PairedDevice) => x.device_id)).toEqual([p.client.deviceId]);
  });
});

describe("linking by matching codes (§10.5)", () => {
  test("the shell's prompt shows the phone's code; approving links it", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone({ kind: "web", name: "Firefox" });
    const deskId = (await p.client.accountDevices()).find((x) => x.kind === "desktop")!.device_id;
    let shown = "";
    const linked = p.client.linkByCode(deskId, (code) => (shown = code));
    await until(() => d.sh.prompts.length === 1, 5000, "link prompt");
    const prompt = d.sh.prompts[0]!;
    expect(prompt).toMatchObject({ name: "Firefox", platform: "web" });
    await until(() => shown !== "");
    expect(prompt.code).toBe(shown);
    expect((await d.sh.status()).link_request).toEqual({ name: "Firefox", platform: "web", claimed_platform: "web" });
    await d.sh.c.call("devices.link.decide", { request_id: prompt.request_id, approve: true });
    const desk = await linked;
    expect(desk.device_id).toBe(deskId);
    expect((await list(d)).map((x) => [x.device_id, x.method, x.platform])).toEqual([[p.client.deviceId, "code", "web"]]);
    expect((await d.sh.status()).link_request).toBeNull();
  });

  test("declining, or letting the prompt expire, links nothing", async () => {
    newUser(w);
    const d = await signedInDesktop({ remote: { linkRequestTtlMs: 300 } });
    const p = await aPhone();
    const deskId = (await p.client.accountDevices()).find((x) => x.kind === "desktop")!.device_id;
    const first = p.client.linkByCode(deskId, () => {});
    await until(() => d.sh.prompts.length === 1);
    await d.sh.c.call("devices.link.decide", { request_id: d.sh.prompts[0]!.request_id, approve: false });
    await expect(first).rejects.toBeInstanceOf(LinkDeclinedError);
    const second = p.client.linkByCode(deskId, () => {});
    await until(() => d.sh.prompts.length === 2);
    await expect(second).rejects.toBeInstanceOf(LinkDeclinedError);
    expect(d.sh.withdrawn.at(-1)).toEqual({ request_id: d.sh.prompts[1]!.request_id, reason: "expired" });
    // Too late to approve.
    const e = (await d.sh.c.call("devices.link.decide", { request_id: d.sh.prompts[1]!.request_id, approve: true }).catch((x) => x)) as LocalCallError;
    expect(e.code).toBe(RPC_ERROR.NOT_FOUND);
    expect(await list(d)).toEqual([]);
  });
});

describe("live sessions (§9.3): a paired device gets its role's methods, nothing more", () => {
  test("hello as itself, then the ios role's calls; local-only methods are refused", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    const live = await p.client.openLive(desk.device_id);
    const hello = (await helloLive(live, p.client.deviceId)) as { role: string };
    expect(hello.role).toBe("ios");
    expect(await live.request("threads.list", {})).toMatchObject({ threads: [] });
    for (const m of ["devices.list", "account.status", "secrets.set", "cli.tokens.list"]) {
      const e = (await live.request(m, {}).catch((x) => x)) as RpcCallError;
      expect(e).toBeInstanceOf(RpcCallError);
      expect([RPC_ERROR.FORBIDDEN, RPC_ERROR.INVALID_PARAMS] as number[]).toContain(e.code);
    }
    live.close();
  });

  test("a device can't say hello as another device, or as another platform", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    const a = await p.client.openLive(desk.device_id);
    await expect(helloLive(a, p.client.deviceId, "ios", crypto.randomUUID())).rejects.toBeInstanceOf(RpcCallError);
    const b = await p.client.openLive(desk.device_id);
    await expect(helloLive(b, p.client.deviceId, "web")).rejects.toBeInstanceOf(RpcCallError);
  });

  test("an unpaired device's session is refused", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    const other = await aPhone({ name: "Not paired" });
    // It isn't linked, so the relay won't carry it; and the runtime wouldn't accept it anyway.
    await expect(other.client.openLive(desk.device_id, 1000)).rejects.toBeInstanceOf(LiveClosedError);
  });
});

describe("unpairing (§9.6)", () => {
  test("from the desktop: the link goes at the relay, sessions close, the phone forgets the desktop", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    const live = await p.client.openLive(desk.device_id);
    await helloLive(live, p.client.deviceId);
    await d.sh.c.call("devices.unpair", { device_id: p.client.deviceId });
    expect(await live.closed).toBeString();
    expect(await list(d)).toEqual([]);
    await until(() => p.client.connectionState === "removed", 5000, "phone removed");
    const e = (await d.sh.c.call("devices.unpair", { device_id: p.client.deviceId }).catch((x) => x)) as LocalCallError;
    expect(e.code).toBe(RPC_ERROR.NOT_FOUND);
  });

  test("from the phone: the desktop forgets it too", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    await p.client.unpair(desk.device_id);
    await until(() => d.sh.devices.at(-1)?.length === 0, 5000, "desktop forgot the phone");
  });

  test("unpaired while offline, the relay link is removed when the desktop reconnects", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    await pairByQr(d, p);
    await d.sh.c.call("account.sign_out", {});
    await d.sh.c.call("devices.unpair", { device_id: p.client.deviceId });
    await d.sh.c.call("account.sign_in", {});
    await settled(d.sh, "signed_in");
    await until(() => p.client.connectionState === "removed", 5000, "phone removed");
  });
});

describe("the account (§10.4, §10.9)", () => {
  test("signing out keeps pairings; signing back in as the same person resumes them", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    const { desk } = await pairByQr(d, p);
    await d.sh.c.call("account.sign_out", {});
    expect((await list(d)).length).toBe(1);
    await d.sh.c.call("account.sign_in", {});
    await settled(d.sh, "signed_in");
    await connected(d.sh);
    const live = await p.client.openLive(desk.device_id);
    await helloLive(live, p.client.deviceId);
  });

  test("someone else signing in forgets the pairings and the desktop's keys", async () => {
    newUser(w, "ada");
    const d = await signedInDesktop();
    const p = await aPhone();
    await pairByQr(d, p);
    const before = JSON.parse(d.sh.keychain.get("device_static_key")!).device_id;
    await d.sh.c.call("account.sign_out", {});
    newUser(w, "bob");
    await d.sh.c.call("account.sign_in", {});
    await settled(d.sh, "signed_in");
    await connected(d.sh);
    expect(await list(d)).toEqual([]);
    expect(JSON.parse(d.sh.keychain.get("device_static_key")!).device_id).not.toBe(before);
  });

  test("deleting the account wipes the relay's data, unpairs everything and signs out", async () => {
    const sub = newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    await pairByQr(d, p);
    const r = await d.sh.c.call("account.delete", {});
    expect(r.status).toMatchObject({ state: "signed_out", email: null, relay: { state: "off" } });
    expect(r.provider).toBe("deleted");
    expect(w.issuer.deletedUsers.has(sub)).toBe(true);
    expect(await list(d)).toEqual([]);
    expect(d.sh.keychain.has("refresh_token")).toBe(false);
    expect(d.sh.keychain.has("device_static_key")).toBe(false);
    await until(() => p.client.connectionState === "removed", 5000, "phone removed");
  });
});

describe("Face ID approvals (§9.8, §18 rows 115–116)", () => {
  const deletes: FakeScript = async (x) => {
    const i = (await x.nextInput())!;
    await x.tool({ toolCallId: "c1", tool: "Bash", input: { command: "rm -rf build" }, canDefer: true });
    x.result([i.uuid]);
  };

  async function destructiveWaiting(d: Desk) {
    const { thread_id } = await d.sh.c.call("tasks.create", { spec: sessionSpec({ builtin: ["Bash"] }) as never });
    await d.sh.c.call("messages.send", { thread_id, client_msg_id: crypto.randomUUID() as never, text: "clean" });
    const deadline = Date.now() + 5000;
    for (;;) {
      const { requests } = await d.sh.c.call("input.list_pending", { thread_id });
      if (requests.length) return requests[0]!;
      if (Date.now() > deadline) throw new Error("timed out waiting for the approval");
      await Bun.sleep(10);
    }
  }

  test("allowing a destructive call from an iPhone needs a Face ID proof from the key it attested; without a key, only the Mac allows", async () => {
    newUser(w);
    const d = await signedInDesktop({ script: deletes, env: { HOMERUN_INPUT_GRACE_MS: "600000" } });
    const p = await aPhone({ faceId: true });
    const { desk } = await pairByQr(d, p);
    const plain = await aPhone({ name: "No Face ID" });
    await pairByQr(d, plain);
    expect(Object.fromEntries((await list(d)).map((x) => [x.name, x.biometric_approvals]))).toEqual({ "Ada's iPhone": true, "No Face ID": false });

    const req = await destructiveWaiting(d);
    const allow = { type: "approval", decision: "allow" } as const;
    const fields = { device_id: p.client.deviceId, desktop_id: desk.device_id, request_id: req.request_id, decision: "allow" };
    const expiresAt = Date.now() + 60_000;
    const answer = async (who: typeof p, approval?: { signature: string; expires_at: number }) => {
      const live = await who.client.openLive(desk.device_id);
      await helloLive(live, who.client.deviceId);
      try {
        return await live.request("input.answer", { request_id: req.request_id, response: allow, via: "app", ...(approval ? { approval } : {}) });
      } catch (e) {
        return e as RpcCallError;
      } finally {
        live.close();
      }
    };
    const refused = async (r: unknown, text: string) => {
      expect(r).toBeInstanceOf(RpcCallError);
      expect((r as RpcCallError).code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
      expect((r as Error).message).toContain(text);
    };

    await refused(await answer(plain), "Approve on your Mac");
    await refused(await answer(p), "Confirm with Face ID");
    // Signed by another key, or for another decision: refused.
    await refused(await answer(p, { signature: testApprovalKey().sign({ ...fields, expires_at: expiresAt }), expires_at: expiresAt }), "didn't verify");
    await refused(await answer(p, { signature: p.approval!.sign({ ...fields, decision: "allow_always", expires_at: expiresAt }), expires_at: expiresAt }), "didn't verify");
    expect(await answer(p, { signature: p.approval!.sign({ ...fields, expires_at: expiresAt }), expires_at: expiresAt })).toEqual({ status: "applied" });
  }, 20_000);

  test("a new approval key is pinned only with an App Attest assertion over it, and the Mac says so", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone({ faceId: true });
    const { desk } = await pairByQr(d, p);
    const live = await p.client.openLive(desk.device_id);
    await helloLive(live, p.client.deviceId);
    const next = testApprovalKey();
    const assertion = (key: string, counter: number) => toB64url(testAssertion(p.credential!.credentialSecretKey, approvalRenewalClientDataHash(p.client.deviceId, key), counter));
    const renew = (approval_key: string, a: string) => live.request("devices.renew_approval_key", { approval_key, assertion: a }).catch((e) => e as RpcCallError);

    // Vouching for another key, or signed by another credential: refused.
    expect(await renew(next.publicKey, assertion(testApprovalKey().publicKey, 1))).toBeInstanceOf(RpcCallError);
    const stranger = toB64url(testAssertion(crypto.getRandomValues(new Uint8Array(32)).fill(7), approvalRenewalClientDataHash(p.client.deviceId, next.publicKey), 1));
    expect(await renew(next.publicKey, stranger)).toBeInstanceOf(RpcCallError);
    expect(d.sh.notes.some((n) => n.method === "notification.requested" && (n.params as { kind: string }).kind === "device")).toBe(false);

    expect(await renew(next.publicKey, assertion(next.publicKey, 1))).toEqual({ ok: true });
    await until(() => d.sh.notes.some((n) => n.method === "notification.requested" && (n.params as { kind: string }).kind === "device"), 5000, "the Mac's notification");
    const note = d.sh.notes.find((n) => n.method === "notification.requested" && (n.params as { kind: string }).kind === "device")!.params;
    expect(note).toMatchObject({ target: { screen: "settings" }, thread_id: null, title: "Face ID approvals changed" });
    // The same assertion again: the counter must go up.
    const r = await renew(testApprovalKey().publicKey, assertion(next.publicKey, 1));
    expect((r as RpcCallError).code).toBe(RPC_ERROR.AUTHORITY_INSUFFICIENT);
    live.close();
  }, 20_000);
});

