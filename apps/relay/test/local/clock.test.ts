import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPairingCode, offerTag, RELAY_PATHS } from "@homerun/protocol";
import { ApnsMock, OidcIssuer } from "@homerun/testkit";
import type { RelayLimits } from "../../src/config";
import { type LocalRelay, type LocalRelayOptions, startLocalRelay } from "../../src/local";
import { instruction, sessionId, statement, TestDevice } from "../helpers";
import { account, type Ctx, linkedPair } from "../scenarios";

/** What needs a clock or small limits: expiry, token lifetimes, rate limits, queue bounds, restarts. */

const HOUR = 60 * 60 * 1000;
const SKEW = 5 * 60 * 1000;

let issuer: OidcIssuer;
let apns: ApnsMock;
let relay: LocalRelay | null = null;
let clock = Date.now();

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  apns = await ApnsMock.start();
});
afterEach(async () => {
  await relay?.stop();
  relay = null;
});
afterAll(async () => {
  await apns.stop();
  await issuer.stop();
});

async function start(limits: Partial<RelayLimits> = {}, extra: Partial<LocalRelayOptions> = {}): Promise<Ctx> {
  clock = Date.now();
  relay = await startLocalRelay({ issuer: issuer.url, clientId: issuer.clientId, now: () => clock, limits, ...extra });
  return { t: { url: relay.url, wsUrl: relay.wsUrl, now: () => clock }, issuer, apns };
}
async function advance(ms: number) {
  clock += ms;
  await relay!.tick();
}

describe("expiry", () => {
  test("an instruction nobody picks up expires, and the sender hears so", async () => {
    const c = await start();
    const p = await linkedPair(c);
    p.dc.close();
    await p.pc.next("presence", (f) => !f.online);
    const env = p.phone.seal(p.desktop, instruction(), { now: clock, ttl: 12 * HOUR });
    p.pc.send({ type: "sealed", envelope: env });
    await p.pc.next("receipt", (f) => f.status === "queued");
    // Keep the phone's connection alive across the jump.
    p.pc.send({ type: "reauth", token: await issuer.mint({ sub: p.sub, ttlSec: 14 * 3600 }) });
    await p.pc.next("reauthed");
    await advance(12 * HOUR + SKEW - 1000);
    expect(await p.pc.quiet("receipt")).toBe(true);
    await advance(2000);
    const r = await p.pc.next("receipt", (f) => f.status === "expired");
    expect(r.msg_id).toBe(env.header.msg_id);
    const tok = await issuer.mint({ sub: p.sub, skewSec: 13 * 3600 });
    const dc = await p.desktop.connect(c.t, tok);
    expect(await dc.quiet("sealed")).toBe(true);
  });

  test("a connection whose token lapses without reauth is closed with 4401", async () => {
    const c = await start();
    const { tok } = await account(c);
    const d = new TestDevice("desktop");
    await d.register(c.t, tok);
    const conn = await d.connect(c.t, tok);
    await advance(HOUR + 61_000);
    expect((await conn.closed).code).toBe(4401);
  });

  test("a connection that never answers the challenge is closed", async () => {
    const c = await start();
    const { tok } = await account(c);
    const d = new TestDevice("desktop");
    await d.register(c.t, tok);
    const conn = await d.connect(c.t, tok, { auth: false });
    await conn.next("challenge");
    await advance(31_000);
    expect((await conn.closed).code).toBe(4400);
  });

  test("a pairing offer lapses after five minutes", async () => {
    const c = await start();
    const { tok } = await account(c);
    const desktop = new TestDevice("desktop");
    const phone = new TestDevice("ios");
    await desktop.register(c.t, tok);
    await phone.register(c.t, tok);
    const dc = await desktop.connect(c.t, tok);
    const pc = await phone.connect(c.t, tok);
    const offer = offerTag(newPairingCode());
    dc.send({ type: "pair_open", offer, expires_at: clock + 5 * 60 * 1000 });
    dc.send({ type: "ping" });
    await dc.next("pong");
    await advance(5 * 60 * 1000 + 1);
    pc.send({ type: "rendezvous", kind: "pair", to: desktop.deviceId, session: sessionId(), offer, data: "AAAA" });
    expect((await pc.next("error")).code).toBe("offer_unknown");
  });

  test("expiry is checked against the relay's clock with the skew allowance", async () => {
    const c = await start();
    const p = await linkedPair(c);
    const post = (ttl: number, now = clock) =>
      p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: p.phone.seal(p.desktop, instruction(), { now, ttl }) }).then((r) => r.status);
    expect(await post(72 * HOUR)).toBe(202);
    expect(await post(72 * HOUR + SKEW + 1000)).toBe(400);
    expect(await post(HOUR, clock - HOUR - SKEW + 5000)).toBe(202);
    expect(await post(HOUR, clock - HOUR - SKEW - 5000)).toBe(400);
  });
});

describe("limits", () => {
  test("the queue holds at most N messages or B bytes per device", async () => {
    const c = await start({ queueMaxMessages: 3, queueMaxBytes: 64 * 1024 });
    const p = await linkedPair(c);
    p.dc.close();
    await p.pc.next("presence", (f) => !f.online);
    const send = (text = "x") =>
      p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: p.phone.seal(p.desktop, instruction(text), { now: clock, ttl: HOUR }) });
    for (let i = 0; i < 3; i++) expect((await send()).status).toBe(202);
    const full = await send();
    expect(full.status).toBe(429);
    expect(((await full.json()) as { error: string }).error).toBe("queue_full");

    const q = await linkedPair(c);
    q.dc.close();
    await q.pc.next("presence", (f) => !f.online);
    const big = (n: number) =>
      q.phone.req(c.t, q.tok, "POST", RELAY_PATHS.sealed, { envelope: q.phone.seal(q.desktop, instruction("y".repeat(n)), { now: clock, ttl: HOUR }) });
    expect((await big(40_000)).status).toBe(202);
    expect((await big(40_000)).status).toBe(429);
    expect((await big(5_000)).status).toBe(202);
  });

  test("sealed messages per minute, per account", async () => {
    const c = await start({ sealedPerMinute: 2 });
    const p = await linkedPair(c);
    const send = () => p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: p.phone.seal(p.desktop, instruction(), { now: clock, ttl: HOUR }) });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(429);
    await advance(60_000);
    expect((await send()).status).toBe(202);
  });

  test("pairing and linking attempts per ten minutes", async () => {
    const c = await start({ rendezvousPerTenMinutes: 2 });
    const { tok } = await account(c);
    const desktop = new TestDevice("desktop");
    const phone = new TestDevice("ios");
    await desktop.register(c.t, tok);
    await phone.register(c.t, tok);
    const dc = await desktop.connect(c.t, tok);
    const pc = await phone.connect(c.t, tok);
    for (let i = 0; i < 2; i++) {
      pc.send({ type: "rendezvous", kind: "link", to: desktop.deviceId, session: sessionId(), data: "AAAA" });
      await dc.next("rendezvous");
    }
    pc.send({ type: "rendezvous", kind: "link", to: desktop.deviceId, session: sessionId(), data: "AAAA" });
    expect((await pc.next("error")).code).toBe("rate_limited");
  });

  test("devices per account and registrations per hour", async () => {
    const c = await start({ maxDevices: 2, registrationsPerHour: 3 });
    const { tok } = await account(c);
    const a = new TestDevice("desktop");
    expect((await a.register(c.t, tok)).status).toBe(200);
    expect((await new TestDevice("ios").register(c.t, tok)).status).toBe(200);
    const r = await new TestDevice("ios").register(c.t, tok);
    expect(((await r.json()) as { error: string }).error).toBe("too_many_devices");
    expect((await a.register(c.t, tok)).status).toBe(200);

    const c2 = await account(c);
    for (let i = 0; i < 2; i++) expect((await new TestDevice("ios").register(c.t, c2.tok)).status).toBe(200);
  });

  test("open pairing offers per desktop", async () => {
    const c = await start({ offersPerDesktop: 2 });
    const { tok } = await account(c);
    const d = new TestDevice("desktop");
    await d.register(c.t, tok);
    const dc = await d.connect(c.t, tok);
    for (let i = 0; i < 2; i++) dc.send({ type: "pair_open", offer: offerTag(newPairingCode()), expires_at: clock + 60_000 });
    dc.send({ type: "pair_open", offer: offerTag(newPairingCode()), expires_at: clock + 60_000 });
    expect((await dc.next("error")).code).toBe("rate_limited");
  });

  test("a connection that floods frames is told to slow down, then closed", async () => {
    const c = await start({ framesPerSecond: 1, frameBurst: 5, maxDroppedFrames: 3 });
    const { tok } = await account(c);
    const d = new TestDevice("desktop");
    await d.register(c.t, tok);
    const conn = await d.connect(c.t, tok);
    for (let i = 0; i < 20; i++) conn.send({ type: "ping" });
    expect((await conn.next("error")).code).toBe("rate_limited");
    expect((await conn.closed).code).toBe(4429);
  });
});

describe("last seen", () => {
  test("written on connect and disconnect, and at most every few minutes in between", async () => {
    const c = await start({ lastSeenWriteMs: 60_000 });
    const p = await linkedPair(c);
    const seen = async () => {
      const r = (await (await p.desktop.req(c.t, p.tok, "GET", RELAY_PATHS.devices)).json()) as { devices: { device_id: string; last_seen_at: number }[] };
      return r.devices.find((d) => d.device_id === p.phone.deviceId)!.last_seen_at;
    };
    const t0 = await seen();
    expect(t0).toBe(clock);
    await advance(30_000);
    p.pc.send({ type: "ping" });
    await p.pc.next("pong");
    expect(await seen()).toBe(t0);
    await advance(31_000);
    p.pc.send({ type: "ping" });
    await p.pc.next("pong");
    expect(await seen()).toBe(clock);
    await advance(5_000);
    p.pc.close();
    await p.dc.next("presence", (f) => !f.online);
    expect(await seen()).toBe(clock);
  });
});

describe("restarts", () => {
  test("with a data directory, links and queued messages survive a relay restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    try {
      const c = await start({}, { dataDir: dir });
      const p = await linkedPair(c);
      p.dc.close();
      await p.pc.next("presence", (f) => !f.online);
      const env = p.phone.seal(p.desktop, instruction(), { now: clock, ttl: HOUR });
      p.pc.send({ type: "sealed", envelope: env });
      await p.pc.next("receipt");
      await relay!.stop();
      expect((await p.pc.closed).code).toBeGreaterThan(0);

      const c2 = await start({}, { dataDir: dir, port: 0 });
      const dc = await p.desktop.connect(c2.t, p.tok);
      expect((await dc.next("sealed")).envelope).toEqual(env);
      const pc = await p.phone.connect(c2.t, p.tok);
      pc.send({ type: "live", to: p.desktop.deviceId, session: sessionId(), data: "AAAA" });
      await dc.next("live");
      dc.close();
      pc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dropped connections reconnect and pick up where they were", async () => {
    const c = await start();
    const p = await linkedPair(c);
    relay!.dropConnections();
    await p.dc.closed;
    await p.pc.closed;
    const dc = await p.desktop.connect(c.t, p.tok);
    const pc = await p.phone.connect(c.t, p.tok);
    const ready = pc;
    ready.send({ type: "live", to: p.desktop.deviceId, session: sessionId(), data: "AAAA" });
    await dc.next("live");
  });
});

describe("the issuer's keys", () => {
  test("a rotated signing key is picked up without a restart", async () => {
    const c = await start({}, { jwksCooldownMs: 0 });
    const { sub, tok } = await account(c);
    const d = new TestDevice("desktop");
    expect((await d.register(c.t, tok)).status).toBe(200);
    await issuer.rotateKeys(true);
    const fresh = await issuer.mint({ sub });
    expect((await d.req(c.t, fresh, "GET", RELAY_PATHS.devices)).status).toBe(200);
  });
});

describe("statement", () => {
  test("a statement for a device of another kind is refused", async () => {
    const c = await start();
    const { sub, tok } = await account(c);
    const desktop = new TestDevice("desktop");
    const web = new TestDevice("web");
    await desktop.register(c.t, tok);
    await web.register(c.t, tok);
    const dc = await desktop.connect(c.t, tok);
    const s = statement(desktop, web, sub, clock);
    dc.send({ type: "link_add", statement: { ...s, platform: "ios" } });
    expect((await dc.next("error")).code).toBe("invalid");
  });
});
