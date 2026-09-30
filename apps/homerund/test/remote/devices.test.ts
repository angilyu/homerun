import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR, type PairedDevice } from "@homerun/core";
import { decodePairingUrl } from "@homerun/protocol";
import { LinkDeclinedError, LiveClosedError, RpcCallError } from "@homerun/remote";
import { RpcCallError as LocalCallError } from "../../src/rpc/client";
import { socketRuntime, until } from "../helpers";
import { connected, desktop, envFor, helloLive, newUser, phone, relayState, settled, shellFor, startWorld, type World } from "./harness";

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

async function pairByQr(d: Desk, p: Awaited<ReturnType<typeof aPhone>>) {
  const offer = await d.sh.c.call("devices.pairing.start", {});
  const desk = await p.client.pair(offer.qr_url);
  await until(() => d.sh.notes.some((n) => n.method === "devices.pairing_completed"), 5000, "pairing_completed");
  return { offer, desk };
}

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
    expect(w.relay.connections()).toBe(0);
  });

  test("a dropped link reconnects with backoff, and a wake retries at once", async () => {
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
    expect((await d.sh.status()).link_request).toEqual({ name: "Firefox", platform: "web" });
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
    newUser(w);
    const d = await signedInDesktop();
    const p = await aPhone();
    await pairByQr(d, p);
    const r = await d.sh.c.call("account.delete", {});
    expect(r.status).toMatchObject({ state: "signed_out", email: null, relay: { state: "off" } });
    expect(await list(d)).toEqual([]);
    expect(d.sh.keychain.has("refresh_token")).toBe(false);
    expect(d.sh.keychain.has("device_static_key")).toBe(false);
    await until(() => p.client.connectionState === "removed", 5000, "phone removed");
  });
});
