import { describe, expect, test } from "bun:test";
import { newMsgId, newPairingCode, offerTag, RELAY_PATHS, sealRaw, type SealedEnvelope } from "@homerun/protocol";
import { fakeDeviceToken, type ApnsMock, type OidcIssuer } from "@homerun/testkit";
import { b64, type Conn, instruction, pushBody, sessionId, statement, type Target, TestDevice } from "./helpers";

/**
 * The relay's behaviour, black box, on whichever host `ctx` provides (Bun or workerd). Every
 * test uses its own account, so tests don't share state.
 */

export interface Ctx {
  t: Target;
  issuer: OidcIssuer;
  apns: ApnsMock;
}

const HOUR = 60 * 60 * 1000;

export async function account(c: Ctx) {
  const sub = `user_${b64(9)}`;
  const tok = await c.issuer.mint({ sub });
  return { sub, tok };
}

/** An account with a desktop and a phone, registered, connected and linked. */
export async function linkedPair(c: Ctx, phoneKind: "ios" | "web" = "ios") {
  const { sub, tok } = await account(c);
  const desktop = new TestDevice("desktop", "Mac");
  const phone = new TestDevice(phoneKind, "iPhone");
  expect((await desktop.register(c.t, tok)).status).toBe(200);
  expect((await phone.register(c.t, tok)).status).toBe(200);
  const dc = await desktop.connect(c.t, tok);
  const pc = await phone.connect(c.t, tok);
  dc.send({ type: "link_add", statement: statement(desktop, phone, sub, c.t.now()) });
  await dc.next("links", (f) => f.links.length === 1);
  await pc.next("links", (f) => f.links.length === 1);
  return { sub, tok, desktop, phone, dc, pc };
}

export function sharedScenarios(get: () => Ctx) {
  describe("access tokens", () => {
    test("health needs no token; everything else does", async () => {
      const { t } = get();
      expect((await fetch(t.url + RELAY_PATHS.health)).status).toBe(200);
      const r = await fetch(t.url + RELAY_PATHS.devices);
      expect(r.status).toBe(401);
      expect(((await r.json()) as { error: string }).error).toBe("unauthenticated");
    });

    test("rejects expired, foreign-key, wrong-issuer and wrong-client tokens", async () => {
      const c = get();
      const d = new TestDevice("desktop");
      const cases: [Parameters<OidcIssuer["mint"]>[0], string][] = [
        [{ skewSec: -3600, ttlSec: 600 }, "token_expired"],
        [{ foreignKey: true }, "unauthenticated"],
        [{ iss: "https://evil.example" }, "unauthenticated"],
        [{ clientId: "client_other", aud: null }, "unauthenticated"],
      ];
      for (const [opts, code] of cases) {
        const r = await d.register(c.t, await c.issuer.mint(opts));
        expect(r.status).toBe(401);
        expect(((await r.json()) as { error: string }).error).toBe(code);
      }
    });

    test("the WebSocket upgrade needs a valid token", async () => {
      const c = get();
      const d = new TestDevice("desktop");
      await expect(d.connect(c.t, await c.issuer.mint({ foreignKey: true }))).rejects.toThrow();
    });
  });

  describe("registration and device proofs", () => {
    test("registers, re-registers idempotently, refuses other keys under the same id", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop", "Mac");
      const r = await d.register(c.t, tok);
      expect(r.status).toBe(200);
      expect(((await r.json()) as { device: { device_id: string } }).device.device_id).toBe(d.deviceId);
      expect((await d.register(c.t, tok)).status).toBe(200);
      const impostor = new TestDevice("desktop");
      Object.defineProperty(impostor, "id", { value: { ...impostor.id, deviceId: d.deviceId } });
      const bad = await impostor.register(c.t, tok);
      expect(bad.status).toBe(409);
      expect(((await bad.json()) as { error: string }).error).toBe("device_key_mismatch");
    });

    test("a request needs a fresh proof by a registered device", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop");
      expect((await d.req(c.t, tok, "GET", RELAY_PATHS.devices)).status).toBe(404);
      await d.register(c.t, tok);
      expect((await d.req(c.t, tok, "GET", RELAY_PATHS.devices)).status).toBe(200);
      expect((await d.req(c.t, tok, "GET", RELAY_PATHS.devices, undefined, { sign: false })).status).toBe(401);
      expect((await d.req(c.t, tok, "GET", RELAY_PATHS.devices, undefined, { ts: c.t.now() - 10 * 60 * 1000 })).status).toBe(401);
    });

    test("a device of one account is unknown in another", async () => {
      const c = get();
      const a = await account(c);
      const b = await account(c);
      const d = new TestDevice("desktop");
      await d.register(c.t, a.tok);
      expect((await d.req(c.t, b.tok, "GET", RELAY_PATHS.devices)).status).toBe(404);
    });

    test("GET /v1/devices lists every device of the account, with linked_at for linked ones", async () => {
      const c = get();
      const p = await linkedPair(c);
      const other = new TestDevice("ios", "iPad");
      await other.register(c.t, p.tok);
      const r = (await (await p.desktop.req(c.t, p.tok, "GET", RELAY_PATHS.devices)).json()) as { devices: { device_id: string; linked_at: number | null; online: boolean }[] };
      const byId = new Map(r.devices.map((d) => [d.device_id, d]));
      expect(byId.get(p.phone.deviceId)?.linked_at).toBeNumber();
      expect(byId.get(p.phone.deviceId)?.online).toBe(true);
      expect(byId.get(other.deviceId)?.linked_at).toBeNull();
      expect(byId.has(p.desktop.deviceId)).toBe(false);
    });
  });

  describe("connections", () => {
    test("challenge, auth and ready, with the homerun.v1 subprotocol", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop");
      await d.register(c.t, tok);
      const conn = await d.connect(c.t, tok);
      expect(conn.protocol).toBe("homerun.v1");
      conn.send({ type: "ping" });
      await conn.next("pong");
      conn.close();
    });

    test("a browser passes its token as a subprotocol", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("web");
      await d.register(c.t, tok);
      const conn = await d.connect(c.t, tok, { browser: true });
      expect(conn.protocol).toBe("homerun.v1");
      conn.close();
    });

    test("a wrong challenge signature closes with 4403", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop");
      await d.register(c.t, tok);
      const conn = await d.connect(c.t, tok, { auth: false });
      await conn.next("challenge");
      conn.send({ type: "auth", device_id: d.deviceId, signature: b64(64) });
      expect((await conn.closed).code).toBe(4403);
    });

    test("anything before auth closes with 4400", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop");
      await d.register(c.t, tok);
      const conn = await d.connect(c.t, tok, { auth: false });
      conn.send({ type: "ping" });
      expect((await conn.closed).code).toBe(4400);
    });

    test("a second connection for the same device replaces the first with 4409", async () => {
      const c = get();
      const { tok } = await account(c);
      const d = new TestDevice("desktop");
      await d.register(c.t, tok);
      const first = await d.connect(c.t, tok);
      const second = await d.connect(c.t, tok);
      expect((await first.closed).code).toBe(4409);
      second.send({ type: "ping" });
      await second.next("pong");
      second.close();
    });

    test("reauth with a fresh token", async () => {
      const c = get();
      const p = await linkedPair(c);
      p.pc.send({ type: "reauth", token: await c.issuer.mint({ sub: p.sub, ttlSec: 7200 }) });
      const r = await p.pc.next("reauthed");
      expect(r.token_expires_at).toBeGreaterThan(Date.now() + HOUR);
      p.pc.send({ type: "reauth", token: await c.issuer.mint({ sub: "user_someone_else" }) });
      expect((await p.pc.next("error")).code).toBe("unauthenticated");
    });

    test("presence: linked devices see each other come and go", async () => {
      const c = get();
      const p = await linkedPair(c);
      p.pc.close();
      const off = await p.dc.next("presence", (f) => !f.online);
      expect(off.device_id).toBe(p.phone.deviceId);
      expect(off.last_seen_at).toBeNumber();
      const pc2 = await p.phone.connect(c.t, p.tok);
      await p.dc.next("presence", (f) => f.online && f.device_id === p.phone.deviceId);
      pc2.close();
    });
  });

  describe("links", () => {
    test("only a desktop's valid statement, matching both registrations, adds a link", async () => {
      const c = get();
      const { sub, tok } = await account(c);
      const desktop = new TestDevice("desktop");
      const phone = new TestDevice("ios");
      const stranger = new TestDevice("desktop");
      for (const d of [desktop, phone, stranger]) await d.register(c.t, tok);
      const dc = await desktop.connect(c.t, tok);
      const pc = await phone.connect(c.t, tok);
      const sc = await stranger.connect(c.t, tok);

      pc.send({ type: "link_add", statement: statement(desktop, phone, sub, c.t.now()) });
      expect((await pc.next("error")).code).toBe("forbidden");
      dc.send({ type: "link_add", statement: statement(desktop, phone, "user_other", c.t.now()) });
      expect((await dc.next("error")).code).toBe("invalid");
      sc.send({ type: "link_add", statement: statement(desktop, phone, sub, c.t.now()) });
      expect((await sc.next("error")).code).toBe("invalid");
      const unregistered = new TestDevice("ios");
      dc.send({ type: "link_add", statement: statement(desktop, unregistered, sub, c.t.now()) });
      expect((await dc.next("error")).code).toBe("device_unknown");

      dc.send({ type: "link_add", statement: statement(desktop, phone, sub, c.t.now()) });
      const links = await pc.next("links");
      expect(links.links.map((l) => l.device_id)).toEqual([desktop.deviceId]);
      for (const x of [dc, pc, sc]) x.close();
    });
  });

  describe("live sessions", () => {
    test("frames pass between linked devices, opaque", async () => {
      const c = get();
      const p = await linkedPair(c);
      const s = sessionId();
      const data = b64(200);
      p.pc.send({ type: "live", to: p.desktop.deviceId, session: s, data });
      const got = await p.dc.next("live");
      expect(got).toEqual({ type: "live", from: p.phone.deviceId, session: s, data });
      p.dc.send({ type: "live", to: p.phone.deviceId, session: s, data: "AAAA" });
      expect((await p.pc.next("live")).data).toBe("AAAA");
      p.pc.send({ type: "live_close", to: p.desktop.deviceId, session: s });
      expect((await p.dc.next("live_close")).session).toBe(s);
    });

    test("never between unlinked devices, and an offline peer closes the session", async () => {
      const c = get();
      const p = await linkedPair(c);
      const other = new TestDevice("ios");
      await other.register(c.t, p.tok);
      const oc = await other.connect(c.t, p.tok);
      oc.send({ type: "live", to: p.desktop.deviceId, session: sessionId(), data: "AAAA" });
      expect((await oc.next("error")).code).toBe("not_linked");
      expect(await p.dc.quiet("live")).toBe(true);
      p.dc.close();
      await p.pc.next("presence", (f) => !f.online);
      const s = sessionId();
      p.pc.send({ type: "live", to: p.desktop.deviceId, session: s, data: "AAAA" });
      expect((await p.pc.next("live_close")).session).toBe(s);
      oc.close();
    });
  });

  describe("pairing and linking rendezvous", () => {
    test("QR pairing: the phone reaches the desktop through an open offer, and link_add consumes it", async () => {
      const c = get();
      const { sub, tok } = await account(c);
      const desktop = new TestDevice("desktop", "Mac");
      const phone = new TestDevice("ios", "iPhone");
      await desktop.register(c.t, tok);
      await phone.register(c.t, tok);
      const dc = await desktop.connect(c.t, tok);
      const pc = await phone.connect(c.t, tok);
      const offer = offerTag(newPairingCode());
      dc.send({ type: "pair_open", offer, expires_at: c.t.now() + 5 * 60 * 1000 });
      dc.send({ type: "ping" });
      await dc.next("pong");

      const s = sessionId();
      pc.send({ type: "rendezvous", kind: "pair", to: desktop.deviceId, session: s, offer: offerTag(newPairingCode()), data: "AAAA" });
      expect((await pc.next("error")).code).toBe("offer_unknown");
      pc.send({ type: "rendezvous", kind: "pair", to: desktop.deviceId, session: s, offer, data: "AAAA" });
      const first = await dc.next("rendezvous");
      expect(first).toMatchObject({ kind: "pair", from: phone.deviceId, session: s, device: { kind: "ios", name: "iPhone" } });
      dc.send({ type: "rendezvous", kind: "pair", to: phone.deviceId, session: s, data: "BBBB" });
      const reply = await pc.next("rendezvous");
      expect(reply.data).toBe("BBBB");
      expect(reply.device).toBeUndefined();

      // A third device of the account can't join the session.
      const intruder = new TestDevice("ios");
      await intruder.register(c.t, tok);
      const ic = await intruder.connect(c.t, tok);
      ic.send({ type: "rendezvous", kind: "pair", to: desktop.deviceId, session: s, data: "CCCC" });
      expect((await ic.next("error")).code).toBe("forbidden");

      dc.send({ type: "link_add", statement: statement(desktop, phone, sub, c.t.now()), offer });
      await pc.next("links", (f) => f.links.length === 1);
      pc.send({ type: "rendezvous", kind: "pair", to: desktop.deviceId, session: sessionId(), offer, data: "AAAA" });
      expect((await pc.next("error")).code).toBe("offer_unknown");
      for (const x of [dc, pc, ic]) x.close();
    });

    test("linking by code needs no offer; a desktop doesn't start one; only desktops are targets", async () => {
      const c = get();
      const { tok } = await account(c);
      const desktop = new TestDevice("desktop");
      const phone = new TestDevice("ios");
      const tablet = new TestDevice("ios");
      for (const d of [desktop, phone, tablet]) await d.register(c.t, tok);
      const dc = await desktop.connect(c.t, tok);
      const pc = await phone.connect(c.t, tok);
      const tc = await tablet.connect(c.t, tok);
      const s = sessionId();
      pc.send({ type: "rendezvous", kind: "link", to: desktop.deviceId, session: s, data: "AAAA" });
      expect((await dc.next("rendezvous")).kind).toBe("link");
      dc.send({ type: "rendezvous", kind: "link", to: phone.deviceId, session: sessionId(), data: "AAAA" });
      expect((await dc.next("error")).code).toBe("forbidden");
      pc.send({ type: "rendezvous", kind: "link", to: tablet.deviceId, session: sessionId(), data: "AAAA" });
      expect((await pc.next("error")).code).toBe("device_unknown");
      pc.send({ type: "rendezvous_close", to: desktop.deviceId, session: s });
      expect((await dc.next("rendezvous_close")).session).toBe(s);
      for (const x of [dc, pc, tc]) x.close();
    });

    test("pair offers: desktop only", async () => {
      const c = get();
      const p = await linkedPair(c);
      p.pc.send({ type: "pair_open", offer: offerTag(newPairingCode()), expires_at: c.t.now() + 60_000 });
      expect((await p.pc.next("error")).code).toBe("forbidden");
      p.dc.send({ type: "pair_open", offer: offerTag(newPairingCode()), expires_at: c.t.now() + HOUR });
      expect((await p.dc.next("error")).code).toBe("invalid");
    });
  });

  describe("sealed messages", () => {
    test("an instruction over HTTPS is queued, delivered when the desktop connects, and acked", async () => {
      const c = get();
      const p = await linkedPair(c);
      p.dc.close();
      await p.pc.next("presence", (f) => !f.online);
      const env = p.phone.seal(p.desktop, instruction(), { now: c.t.now(), ttl: 12 * HOUR });
      const r = await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: env });
      expect(r.status).toBe(202);
      expect(await r.json()).toEqual({ msg_id: env.header.msg_id, status: "queued" });
      // Posting it again (a retry) is harmless.
      expect((await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: env })).status).toBe(202);

      const dc = await p.desktop.connect(c.t, p.tok);
      const got = await dc.next("sealed");
      expect(got.envelope).toEqual(env);
      expect(await dc.quiet("sealed")).toBe(true);
      dc.send({ type: "ack", id: got.id });
      const receipt = await p.pc.next("receipt", (f) => f.status === "delivered");
      expect(receipt.msg_id).toBe(env.header.msg_id);
      dc.close();
      const dc2 = await p.desktop.connect(c.t, p.tok);
      expect(await dc2.quiet("sealed")).toBe(true);
      dc2.close();
    });

    test("over the WebSocket, an online desktop gets it at once", async () => {
      const c = get();
      const p = await linkedPair(c);
      const env = p.phone.seal(p.desktop, instruction(), { now: c.t.now(), ttl: 12 * HOUR });
      p.pc.send({ type: "sealed", envelope: env });
      expect((await p.pc.next("receipt")).status).toBe("queued");
      expect((await p.dc.next("sealed")).envelope.header.msg_id).toBe(env.header.msg_id);
    });

    test("routing rules: sender, link, direction and lifetime", async () => {
      const c = get();
      const p = await linkedPair(c);
      const now = c.t.now();
      const post = async (from: TestDevice, env: SealedEnvelope) => {
        const r = await from.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: env });
        return r.status === 202 ? "ok" : ((await r.json()) as { error: string }).error;
      };
      const other = new TestDevice("ios");
      await other.register(c.t, p.tok);
      expect(await post(other, other.seal(p.desktop, instruction(), { now, ttl: HOUR }))).toBe("not_linked");
      const lying = p.phone.seal(p.desktop, instruction(), { now, ttl: HOUR });
      expect(await post(other, lying)).toBe("forbidden");
      expect(await post(p.desktop, p.desktop.seal(p.phone, instruction(), { now, ttl: HOUR }))).toBe("forbidden");
      expect(await post(p.phone, p.phone.seal(p.desktop, instruction(), { now, ttl: 80 * HOUR }))).toBe("invalid");
      expect(await post(p.phone, p.phone.seal(p.desktop, instruction(), { now: now - 2 * HOUR, ttl: HOUR }))).toBe("invalid");
      expect(
        await post(p.phone, p.phone.seal(p.desktop, { type: "answer", request_id: crypto.randomUUID(), response: { type: "approval", decision: "allow" }, via: "notification" }, { now, ttl: 2 * HOUR })),
      ).toBe("invalid");
    });

    test("a web client can send instructions but not lock-screen answers", async () => {
      const c = get();
      const p = await linkedPair(c, "web");
      const now = c.t.now();
      const ok = await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: p.phone.seal(p.desktop, instruction(), { now, ttl: HOUR }) });
      expect(ok.status).toBe(202);
      const answer = p.phone.seal(p.desktop, { type: "answer", request_id: crypto.randomUUID(), response: { type: "approval", decision: "allow" }, via: "notification" }, { now, ttl: HOUR });
      const r = await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.sealed, { envelope: answer });
      expect(r.status).toBe(403);
    });
  });

  describe("push", () => {
    test("a sealed push reaches APNs inside the payload, once", async () => {
      const c = get();
      const p = await linkedPair(c);
      const token = fakeDeviceToken();
      expect((await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.pushToken, { token, environment: "sandbox" })).status).toBe(204);
      const env = p.desktop.seal(p.phone, pushBody(), { now: c.t.now(), ttl: 24 * HOUR });
      p.dc.send({ type: "sealed", envelope: env });
      expect((await p.dc.next("receipt")).status).toBe("pushed");
      const d = await c.apns.waitFor((x) => x.token === token);
      expect(d.payload.hr).toEqual(env);
      expect(d.topic).toBe(c.apns.topic);
      expect(Number(d.expiration)).toBe(Math.floor(env.header.expires_at / 1000));
      p.dc.send({ type: "sealed", envelope: env });
      expect((await p.dc.next("receipt")).status).toBe("pushed");
      expect(c.apns.deliveries.filter((x) => x.token === token)).toHaveLength(1);
      expect(await p.pc.quiet("sealed")).toBe(true);
    });

    test("an unregistered token is forgotten", async () => {
      const c = get();
      const p = await linkedPair(c);
      const token = fakeDeviceToken();
      await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.pushToken, { token, environment: "production" });
      c.apns.unregister(token);
      p.dc.send({ type: "sealed", envelope: p.desktop.seal(p.phone, pushBody(), { now: c.t.now(), ttl: HOUR }) });
      expect((await p.dc.next("error")).code).toBe("not_found");
      p.dc.send({ type: "sealed", envelope: p.desktop.seal(p.phone, pushBody(), { now: c.t.now(), ttl: HOUR }) });
      const e = await p.dc.next("error");
      expect(e.message).toContain("no push token");
    });

    test("too big for APNs: a generic alert, and the message waits in the queue", async () => {
      const c = get();
      const p = await linkedPair(c);
      const token = fakeDeviceToken();
      await p.phone.req(c.t, p.tok, "POST", RELAY_PATHS.pushToken, { token, environment: "sandbox" });
      const now = c.t.now();
      // The relay can't see inside; a desktop could seal anything under a push header.
      const env = sealRaw({
        header: { v: 1, mode: "sealed", kind: "push", msg_id: newMsgId(), to_device_id: p.phone.deviceId, from_device_id: p.desktop.deviceId, expires_at: now + HOUR },
        plaintext: new Uint8Array(5000),
        sender: p.desktop.id.noise,
        recipientStatic: p.phone.id.noise.publicKey,
      });
      p.dc.send({ type: "sealed", envelope: env });
      expect((await p.dc.next("receipt")).status).toBe("pushed");
      const d = await c.apns.waitFor((x) => x.token === token);
      expect(d.payload.hr).toBeUndefined();
      expect(d.body.length).toBeLessThanOrEqual(4096);
      expect((await p.pc.next("sealed")).envelope).toEqual(env);
    });

    test("only an iOS device registers a push token", async () => {
      const c = get();
      const p = await linkedPair(c);
      const r = await p.desktop.req(c.t, p.tok, "POST", RELAY_PATHS.pushToken, { token: fakeDeviceToken(), environment: "sandbox" });
      expect(r.status).toBe(403);
    });
  });

  describe("unpairing and account deletion", () => {
    test("unpairing removes the phone, its queue and its credential", async () => {
      const c = get();
      const p = await linkedPair(c);
      p.pc.send({ type: "sealed", envelope: p.phone.seal(p.desktop, instruction(), { now: c.t.now(), ttl: HOUR }) });
      await p.dc.next("sealed");
      p.dc.send({ type: "link_remove", device_id: p.phone.deviceId });
      expect((await p.pc.closed).code).toBe(4410);
      expect((await p.dc.next("links", (f) => f.links.length === 0)).links).toEqual([]);
      expect((await p.phone.req(c.t, p.tok, "GET", RELAY_PATHS.devices)).status).toBe(404);
      p.dc.close();
      const dc = await p.desktop.connect(c.t, p.tok);
      expect(await dc.quiet("sealed")).toBe(true);
      dc.close();
    });

    test("deleting the account closes every connection and forgets every device", async () => {
      const c = get();
      const p = await linkedPair(c);
      const r = await p.desktop.req(c.t, p.tok, "DELETE", RELAY_PATHS.account);
      expect(r.status).toBe(204);
      expect((await p.dc.closed).code).toBe(4410);
      expect((await p.pc.closed).code).toBe(4410);
      expect((await p.desktop.req(c.t, p.tok, "GET", RELAY_PATHS.devices)).status).toBe(404);
      expect((await p.desktop.register(c.t, p.tok)).status).toBe(200);
    });
  });
}

export type { Conn };
