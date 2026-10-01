import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { DeviceId, RequestId } from "@homerun/core";
import { startLocalRelay, type LocalRelay } from "@homerun/relay/local";
import { decodePairingUrl, encodePairingUrl, generateDeviceKeys, identityFromStored, newPairingCode, RELAY_PATHS, type SealedEnvelope } from "@homerun/protocol";
import { testAppAttestCA } from "@homerun/protocol/testing";
import { ApnsMock, fakeDeviceToken, OidcIssuer } from "@homerun/testkit";
import { Account, LinkDeclinedError, LiveClosedError, MemoryStore, RelayConnection, RemoteClient, RpcCallError, type ConnectionState } from "../src";
import { FakeDesktop } from "./fake-desktop";

let issuer: OidcIssuer;
let apns: ApnsMock;
let relay: LocalRelay;
/** Stands in for Apple: the fake desktop trusts it, and test iPhones attest with it. */
const appAttest = testAppAttestCA();
const cleanup: (() => void)[] = [];

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  apns = await ApnsMock.start();
  relay = await startLocalRelay({
    issuer: issuer.url,
    clientId: issuer.clientId,
    apns: { keyP8: apns.p8, keyId: apns.keyId, teamId: apns.teamId, topic: apns.topic, endpoint: apns.url },
    appAttest: appAttest.policy(),
  });
});
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});
afterAll(async () => {
  await relay.stop();
  await apns.stop();
  await issuer.stop();
});

/** A fresh account per test, so device counts and rate limits don't carry over. */
function newUser() {
  const sub = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  issuer.consent = { user: { sub, email: `${sub}@example.com` } };
  return sub;
}

async function signIn() {
  const account = await Account.create({
    issuer: issuer.url,
    clientId: issuer.clientId,
    allowInsecureLoopback: true,
    redirectUri: "http://127.0.0.1:53682/callback",
    browser: (url) => issuer.browse(url),
  });
  await account.signIn();
  return account;
}

async function phone(o: { kind?: "ios" | "web"; account?: Account; store?: MemoryStore; sent?: SealedEnvelope[]; attest?: boolean } = {}) {
  const account = o.account ?? (await signIn());
  const store = o.store ?? new MemoryStore();
  const sent = o.sent;
  const client = await RemoteClient.create({
    relayUrl: relay.url,
    account,
    store,
    kind: o.kind ?? "ios",
    name: o.kind === "web" ? "Chrome" : "Wenjing's iPhone",
    reconnect: { initialMs: 50, maxMs: 500 },
    ...(o.attest === false ? {} : { attest: async (id) => appAttest.attest(id).attestation }),
    // Records sealed POSTs, so a test can replay one.
    fetch: async (input, init) => {
      if (sent && String(input).endsWith(RELAY_PATHS.sealed) && init?.body) sent.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).envelope);
      return fetch(input, init);
    },
  });
  await client.register();
  await client.connect();
  cleanup.push(() => client.close());
  return { client, account, store };
}

async function desktop(sub: string) {
  const d = new FakeDesktop(relay.url, sub, () => issuer.mint({ sub }));
  d.attest = appAttest.policy();
  await d.start();
  cleanup.push(() => d.stop());
  return d;
}

async function paired(o: { kind?: "ios" | "web"; sent?: SealedEnvelope[] } = {}) {
  const sub = newUser();
  const d = await desktop(sub);
  const p = await phone(o);
  await p.client.pair(d.openPairing());
  return { sub, d, ...p };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await Bun.sleep(10);
  }
};

const stateIs = (c: RemoteClient, want: ConnectionState, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    if (c.connectionState === want) return resolve();
    const t = setTimeout(() => reject(new Error(`state stayed ${c.connectionState}, wanted ${want}`)), ms);
    const off = c.conn.onState((s) => s === want && (clearTimeout(t), off(), resolve()));
  });

describe("sign-in and the relay link", () => {
  test("signs in with PKCE, registers and connects", async () => {
    const sub = newUser();
    const { client, account } = await phone();
    expect(account.subject).toBe(sub);
    expect(client.connectionState).toBe("ready");
    // The account's other devices: none yet.
    expect(await client.accountDevices()).toEqual([]);
  });

  test("doesn't offer permessage-deflate: Bun's client can't read workerd's compressed frames", async () => {
    let offered: string | null = "not asked";
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        offered = req.headers.get("sec-websocket-extensions");
        return srv.upgrade(req, { headers: { "sec-websocket-protocol": "homerun.v1" } }) ? undefined : new Response(null, { status: 400 });
      },
      websocket: { open: (ws) => ws.close(1000, "bye"), message() {} },
    });
    const conn = new RelayConnection({
      url: `http://127.0.0.1:${stub.port}`,
      identity: identityFromStored(crypto.randomUUID() as DeviceId, "ios", generateDeviceKeys()),
      token: async () => "t",
      freshToken: async () => "t",
      reconnect: false,
    });
    await conn.connect().catch(() => {});
    void stub.stop(true);
    expect(offered).toBeNull();
  });

  test("web clients authenticate with the subprotocol form", async () => {
    newUser();
    const { client } = await phone({ kind: "web" });
    expect(client.connectionState).toBe("ready");
  });

  test("reconnects after the relay drops every connection", async () => {
    const { client, d } = await paired();
    relay.dropConnections();
    await stateIs(client, "connecting");
    await stateIs(client, "ready");
    await until(() => d.conn.state === "ready");
    const r = await client.sendInstruction(d.deviceId, { text: "after the blip" });
    expect(r.status).toBe("queued");
    expect(await d.nextReceived()).toMatchObject({ ok: true, inner: { body: { text: "after the blip" } } });
  });

  test("re-authenticates on the socket before the token expires", async () => {
    const prev = issuer.accessTtlSec;
    issuer.accessTtlSec = 3;
    try {
      newUser();
      const { client } = await phone();
      const reauthed = await client.conn.waitFor("reauthed", () => true, 5000);
      expect(reauthed.token_expires_at).toBeGreaterThan(Date.now());
      expect(client.connectionState).toBe("ready");
    } finally {
      issuer.accessTtlSec = prev;
    }
  });

  test("a revoked session signs the account out on refresh", async () => {
    newUser();
    const account = await signIn();
    issuer.revokeUser(account.subject!);
    await expect(account.refresh()).rejects.toThrow("sign in again");
    expect(account.signedIn).toBe(false);
  });
});

describe("pairing and linking", () => {
  test("pairs by QR and pins the desktop", async () => {
    const { client, d, store } = await paired();
    const [view] = client.desktops();
    expect(view).toMatchObject({ device_id: d.deviceId, name: "Studio Mac", online: true });
    expect(view!.statement.method).toBe("qr");
    // The phone's App Attest attestation made it an iPhone on the desktop.
    expect(client.role(d.deviceId)).toBe("ios");
    expect(d.peers.has(client.deviceId)).toBe(true);
    expect(Object.keys((await store.load())!.desktops)).toEqual([d.deviceId]);
  });

  test("a QR code with the wrong pairing code is refused", async () => {
    const sub = newUser();
    const d = await desktop(sub);
    const qr = decodePairingUrl(d.openPairing())!;
    const { client } = await phone();
    await expect(client.pair(encodePairingUrl({ ...qr, pairing_code: newPairingCode() }))).rejects.toThrow(/pairing offer/);
    expect(client.desktops()).toEqual([]);
  });

  test("links by matching code, confirmed on the desktop", async () => {
    const sub = newUser();
    const d = await desktop(sub);
    let desktopCode = "";
    d.confirmCode = async (code, device) => {
      desktopCode = code;
      expect(device.platform).toBe("web");
      return true;
    };
    const { client } = await phone({ kind: "web" });
    const target = (await client.accountDevices()).find((x) => x.kind === "desktop")!;
    let phoneCode = "";
    const pinned = await client.linkByCode(target.device_id, (c) => (phoneCode = c));
    expect(phoneCode).toMatch(/^\d{6}$/);
    expect(phoneCode).toBe(desktopCode);
    expect(pinned.statement.method).toBe("code");
    expect(client.desktops().map((x) => x.device_id)).toEqual([d.deviceId]);
  });

  test("an iPhone links by code with its App Attest attestation", async () => {
    const sub = newUser();
    const d = await desktop(sub);
    const seen: string[] = [];
    d.confirmCode = async (_code, device) => (seen.push(device.platform), true);
    const { client } = await phone();
    const pinned = await client.linkByCode(d.deviceId, () => {});
    expect(seen).toEqual(["ios"]);
    expect(pinned.statement.platform).toBe("ios");
    expect(client.role(d.deviceId)).toBe("ios");
  });

  test("a declined code leaves nothing linked", async () => {
    const sub = newUser();
    const d = await desktop(sub);
    d.confirmCode = async () => false;
    const { client } = await phone();
    await expect(client.linkByCode(d.deviceId, () => {})).rejects.toBeInstanceOf(LinkDeclinedError);
    expect(client.desktops()).toEqual([]);
    expect(d.peers.size).toBe(0);
  });
});

describe("live sessions", () => {
  test("JSON-RPC both ways, fragmented responses, errors and notifications", async () => {
    const { client, d } = await paired();
    const live = await client.openLive(d.deviceId);
    expect(await live.request("echo", { hello: "desktop" })).toEqual({ hello: "desktop" });
    expect(((await live.request("big")) as string).length).toBe(200_000);
    const err = await live.request("tasks.delete", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RpcCallError);
    expect(err.code).toBe(-32601);
    const note = new Promise((resolve) => live.onMessage((m) => "method" in m && !("id" in m) && resolve(m)));
    d.notify("event", { kind: "run.updated" });
    expect(await note).toMatchObject({ method: "event", params: { kind: "run.updated" } });
    live.close();
    expect(await live.closed).toBe("closed");
  });

  test("an offline desktop refuses the session", async () => {
    const { client, d } = await paired();
    d.stop();
    await expect(client.openLive(d.deviceId, 2000)).rejects.toBeInstanceOf(LiveClosedError);
  });

  test("the session ends when the relay link drops", async () => {
    const { client, d } = await paired();
    const live = await client.openLive(d.deviceId);
    relay.dropConnections();
    expect(await live.closed).toMatch(/relay connection/);
    await expect(live.request("echo")).rejects.toBeInstanceOf(LiveClosedError);
  });
});

describe("sealed messages", () => {
  test("an instruction reaches an online desktop and is receipted", async () => {
    const { client, d } = await paired();
    const r = await client.sendInstruction(d.deviceId, { text: "run the tests" });
    const delivered = client.waitDelivered(r.msg_id);
    const got = await d.nextReceived();
    expect(got).toMatchObject({ ok: true, inner: { sender_device_id: client.deviceId, body: { type: "instruction", text: "run the tests" } } });
    await delivered;
    // Asked again after the receipt came: it was delivered, so no wait.
    await client.waitDelivered(r.msg_id, 1);
  });

  test("an instruction waits for an offline desktop, with when it was sent", async () => {
    const { client, d } = await paired();
    d.stop();
    client.close();
    const sentAt = Date.now();
    const r = await client.sendInstruction(d.deviceId, { text: "when my Mac wakes" });
    expect(r.status).toBe("queued");
    const got = d.nextReceived();
    await d.conn.connect();
    const g = await got;
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.inner.created_at).toBeGreaterThanOrEqual(sentAt);
      expect(g.inner.expires_at - g.inner.created_at).toBe(12 * 3600_000);
    }
  });

  test("push to the lock screen, answered once by HTTPS POST", async () => {
    const sent: SealedEnvelope[] = [];
    const { client, d } = await paired({ sent });
    const token = fakeDeviceToken();
    await client.registerPushToken(token, "sandbox");
    const request_id = crypto.randomUUID() as RequestId;
    const receipt = await d.push(client.deviceId, {
      type: "push",
      category: "input_request",
      title: "Approve a shell command",
      body: "bun test in ~/code/homerun",
      request_id,
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(receipt).toMatchObject({ type: "receipt", status: "pushed" });
    const delivery = await apns.waitFor((x) => x.token === token);
    expect(delivery.payload.aps).toMatchObject({ alert: { title: "Homerun" }, "mutable-content": 1 });

    const opened = await client.openPush(delivery.body);
    if (!opened.sealed) throw new Error(`push didn't open: ${opened.reason}`);
    expect(opened.push.body).toMatchObject({ title: "Approve a shell command", request_id });
    // The extension and the app share the seen-set: the same push opens once.
    expect(await client.openPush(delivery.body)).toEqual({ sealed: false, reason: "replayed" });

    // The phone answers without a socket, as a notification action does.
    client.close();
    const a = await client.answerFromLockScreen(opened.push, "allow", { type: "approval", decision: "allow" });
    expect(a.status).toBe("queued");
    expect(await d.nextReceived()).toMatchObject({ ok: true, inner: { body: { type: "answer", request_id, via: "notification" } } });

    // Replaying the captured POST is refused by the desktop's seen-set.
    await client.conn.call("POST", RELAY_PATHS.sealed, { envelope: sent.at(-1) });
    expect(await d.nextReceived()).toEqual({ ok: false, reason: "replayed" });
  });

  test("a push without actions can't be answered from the lock screen", async () => {
    const { client, d } = await paired();
    const token = fakeDeviceToken();
    await client.registerPushToken(token, "sandbox");
    await d.push(client.deviceId, { type: "push", category: "run_finished", title: "Run finished", body: "All green" });
    const opened = await client.openPush((await apns.waitFor((x) => x.token === token)).body);
    if (!opened.sealed) throw new Error("expected a sealed push");
    await expect(client.answerFromLockScreen(opened.push, "allow", { type: "approval", decision: "allow" })).rejects.toThrow(/lock screen/);
  });

  test("a push too big for APNs shows generic text and arrives through the queue", async () => {
    const { client, d } = await paired();
    const token = fakeDeviceToken();
    await client.registerPushToken(token, "sandbox");
    const queued = new Promise((resolve) => client.onSealed(resolve));
    await d.push(client.deviceId, { type: "push", category: "run_failed", title: "Run failed", body: "€".repeat(1000) });
    const delivery = await apns.waitFor((x) => x.token === token);
    expect(await client.openPush(delivery.body)).toEqual({ sealed: false, reason: "generic" });
    expect(await queued).toMatchObject({ ok: true, inner: { body: { type: "push", title: "Run failed" } } });
  });

  test("a web client can't be pushed to or answer from a lock screen", async () => {
    const { client, d } = await paired({ kind: "web" });
    const r = await d.push(client.deviceId, { type: "push", category: "run_finished", title: "Done", body: "" });
    expect(r).toMatchObject({ type: "error", code: "forbidden" });
  });
});

describe("unpairing and account deletion", () => {
  test("unpairing the last desktop removes the device and its keys", async () => {
    const { client, d, store } = await paired();
    await client.unpair(d.deviceId);
    expect(client.connectionState).toBe("removed");
    expect(await store.load()).toBeNull();
  });

  test("a desktop that unpairs the phone ends its relay access", async () => {
    const { client, d, store } = await paired();
    d.unpair(client.deviceId);
    await stateIs(client, "removed");
    await until(() => client.desktops().length === 0);
    expect(await store.load()).toBeNull();
  });

  test("with two desktops, unpairing one keeps the other", async () => {
    const { client, d, sub } = await paired();
    const d2 = new FakeDesktop(relay.url, sub, () => issuer.mint({ sub }), "Laptop");
    d2.attest = appAttest.policy();
    await d2.start();
    cleanup.push(() => d2.stop());
    await client.pair(d2.openPairing());
    await client.unpair(d.deviceId);
    expect(client.connectionState).toBe("ready");
    expect(client.desktops().map((x) => x.device_id)).toEqual([d2.deviceId]);
    expect((await client.sendInstruction(d2.deviceId, { text: "still here" })).status).toBe("queued");
  });

  test("deleting the account removes every device and signs out", async () => {
    const { client, d, account, store } = await paired();
    await client.deleteAccount();
    expect(account.signedIn).toBe(false);
    expect(await store.load()).toBeNull();
    await until(() => d.conn.state === "removed" || d.conn.state === "closed");
  });
});
