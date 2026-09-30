import { describe, expect, test } from "bun:test";
import type { DeviceId, SealedInner } from "@homerun/core";
import { fromB64url, toB64url, utf8 } from "../src/bytes";
import { generateDeviceKeys, identityFromStored, publicOf, type DeviceIdentity } from "../src/identity";
import { LiveInitiator, liveRespond } from "../src/live";
import { newMsgId, openSealed, seal, SEALED_MAX_BYTES } from "../src/sealed";
import { LinkInitiator, LinkResponder } from "../src/linking";
import { decodePairingUrl, encodePairingUrl, newPairingCode, PairInitiator, PairResponder } from "../src/pairing";
import { signLinkStatement, verifyLinkStatement, type LinkStatementBody } from "../src/statement";
import { buildApnsPayload, APNS_GENERIC_ALERT } from "../src/apns";
import { parseDeviceProof, signChallenge, challengeBytes, signRequest, requestBytes, verifySignature } from "../src/wire";

const dev = (kind: "desktop" | "ios" | "web"): DeviceIdentity =>
  identityFromStored(crypto.randomUUID() as DeviceId, kind, generateDeviceKeys());
const sid = () => toB64url(crypto.getRandomValues(new Uint8Array(16)));
const NOW = 1_780_272_000_000;

describe("identity", () => {
  test("stored keys round-trip and the public view carries both keys", () => {
    const stored = generateDeviceKeys();
    const a = identityFromStored("0e5a3c1d-7b2f-4d8e-9a61-3f0c2b7d9e10" as DeviceId, "desktop", stored);
    const b = identityFromStored(a.deviceId, "desktop", JSON.parse(JSON.stringify(stored)));
    expect(publicOf(a)).toEqual(publicOf(b));
    expect(fromB64url(publicOf(a).static_public_key)).toHaveLength(32);
  });
});

describe("live session (Noise KK)", () => {
  const pair = (maxChunk?: number) => {
    const phone = dev("ios");
    const desktop = dev("desktop");
    const s = sid();
    const common = { initiatorId: phone.deviceId, responderId: desktop.deviceId, sessionId: s, maxChunk };
    const init = new LiveInitiator({ ...common, me: phone.noise, peer: desktop.noise.publicKey });
    const { reply, session: d } = liveRespond({ ...common, me: desktop.noise, peer: phone.noise.publicKey }, init.start());
    return { phone, desktop, p: init.finish(reply), d, common };
  };

  test("both directions, many messages", () => {
    const { p, d } = pair();
    for (let i = 0; i < 50; i++) {
      const [f] = p.encrypt({ jsonrpc: "2.0", id: i, method: "ping" });
      expect(d.decrypt(f!)).toEqual({ jsonrpc: "2.0", id: i, method: "ping" });
      const [g] = d.encrypt({ jsonrpc: "2.0", id: i, result: { i } });
      expect(p.decrypt(g!)).toEqual({ jsonrpc: "2.0", id: i, result: { i } });
    }
  });

  test("a large message is fragmented and reassembled", () => {
    const { p, d } = pair();
    const big = { jsonrpc: "2.0" as const, method: "event", params: { text: "x".repeat(200_000) } };
    const frames = p.encrypt(big);
    expect(frames.length).toBeGreaterThan(3);
    const out = frames.map((f) => d.decrypt(f));
    expect(out.slice(0, -1).every((x) => x === null)).toBe(true);
    expect(out.at(-1)).toEqual(big);
  });

  test("replayed, reordered or tampered frames are rejected", () => {
    const { p, d } = pair();
    const [a] = p.encrypt({ jsonrpc: "2.0", method: "a" });
    const [b] = p.encrypt({ jsonrpc: "2.0", method: "b" });
    expect(() => d.decrypt(b!)).toThrow();
    const { p: p2, d: d2 } = pair();
    const [x] = p2.encrypt({ jsonrpc: "2.0", method: "x" });
    const t = x!.slice();
    t[t.length - 1]! ^= 1;
    expect(() => d2.decrypt(t)).toThrow();
    expect(d2.decrypt(x!)).toEqual({ jsonrpc: "2.0", method: "x" });
    expect(() => d2.decrypt(x!)).toThrow();
    void a;
  });

  test("a device that isn't the pinned peer can't open a session", () => {
    const { desktop, common } = pair();
    const mallory = dev("ios");
    const init = new LiveInitiator({ ...common, me: mallory.noise, peer: desktop.noise.publicKey });
    const phonePinned = dev("ios").noise.publicKey;
    expect(() => liveRespond({ ...common, me: desktop.noise, peer: phonePinned }, init.start())).toThrow();
  });

  test("the session id is bound: a replayed message 1 fails under another session", () => {
    const { phone, desktop, common } = pair();
    const m1 = new LiveInitiator({ ...common, me: phone.noise, peer: desktop.noise.publicKey }).start();
    expect(() => liveRespond({ ...common, sessionId: sid(), me: desktop.noise, peer: phone.noise.publicKey }, m1)).toThrow();
  });
});

describe("sealed messages (Noise K)", () => {
  const phone = dev("ios");
  const desktop = dev("desktop");
  const inner = (over: Partial<SealedInner> = {}): SealedInner =>
    ({
      v: 1,
      msg_id: newMsgId(),
      sender_device_id: phone.deviceId,
      created_at: NOW,
      expires_at: NOW + 60 * 60 * 1000,
      body: { type: "instruction", thread_id: null, client_msg_id: crypto.randomUUID(), text: "run the tests" },
      ...over,
    }) as SealedInner;
  const open = (env: unknown, extra: Partial<Parameters<typeof openSealed>[1]> = {}) =>
    openSealed(env, { me: desktop, senderStatic: (d) => (d === phone.deviceId ? phone.noise.publicKey : null), now: NOW, ...extra });

  test("opens once; the seen-set rejects the replay", () => {
    const m = inner();
    const env = seal({ inner: m, to: desktop.deviceId, sender: phone.noise, recipientStatic: desktop.noise.publicKey });
    const r = open(env);
    expect(r.ok && r.inner).toEqual(m);
    const seen = new Set([m.msg_id]);
    expect(open(env, { seen: (id) => seen.has(id) })).toEqual({ ok: false, reason: "replayed" });
  });

  test("a sealed message is not linkable to its plaintext and differs each time", () => {
    const m = inner();
    const a = seal({ inner: m, to: desktop.deviceId, sender: phone.noise, recipientStatic: desktop.noise.publicKey });
    const b = seal({ inner: m, to: desktop.deviceId, sender: phone.noise, recipientStatic: desktop.noise.publicKey });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain("run the tests");
  });

  test("the header is authenticated", () => {
    const env = seal({ inner: inner(), to: desktop.deviceId, sender: phone.noise, recipientStatic: desktop.noise.publicKey });
    const r = open({ ...env, header: { ...env.header, expires_at: env.header.expires_at + 1000 } });
    expect(r.ok).toBe(false);
  });

  test("a maximum-size instruction seals into several fragments and opens", () => {
    const m = inner({ body: { type: "instruction", thread_id: null, client_msg_id: crypto.randomUUID(), text: "y".repeat(100_000) } } as Partial<SealedInner>);
    const env = seal({ inner: m, to: desktop.deviceId, sender: phone.noise, recipientStatic: desktop.noise.publicKey });
    expect(open(env).ok).toBe(true);
    expect(JSON.stringify(env).length).toBeLessThan(SEALED_MAX_BYTES);
  });
});

describe("QR pairing (Noise IKpsk1)", () => {
  const phone = dev("ios");
  const desktop = dev("desktop");
  const code = newPairingCode();
  const qr = { v: 1 as const, device_id: desktop.deviceId, static_public_key: publicOf(desktop).static_public_key, pairing_code: code };
  const hello = { device_id: phone.deviceId, platform: "ios" as const, name: "iPhone", signing_public_key: publicOf(phone).signing_public_key };
  const body = (): LinkStatementBody => ({
    v: 1,
    account: "user_1",
    desktop_device_id: desktop.deviceId,
    device_id: phone.deviceId,
    desktop_static_public_key: publicOf(desktop).static_public_key,
    device_static_public_key: publicOf(phone).static_public_key,
    device_signing_public_key: publicOf(phone).signing_public_key,
    platform: "ios",
    method: "qr",
    created_at: NOW,
  });

  test("round trip through the URL; the desktop learns the phone's key and the phone gets a valid statement", () => {
    const s = sid();
    const init = new PairInitiator({ qr: decodePairingUrl(encodePairingUrl(qr))!, me: phone.noise, hello, sessionId: s });
    const resp = new PairResponder({ desktopId: desktop.deviceId, deviceId: phone.deviceId, sessionId: s, code, me: desktop.noise });
    const got = resp.read(init.start());
    expect(got.hello).toEqual(hello);
    expect(got.remoteStatic).toEqual(phone.noise.publicKey);
    const statement = signLinkStatement(body(), desktop.signing);
    const welcome = init.finish(resp.reply({ device_id: desktop.deviceId, name: "Mac", signing_public_key: publicOf(desktop).signing_public_key, statement }));
    expect(verifyLinkStatement(welcome.statement, welcome.signing_public_key)).toEqual(statement);
    expect(verifyLinkStatement(welcome.statement, publicOf(phone).signing_public_key)).toBeNull();
  });

  test("someone who didn't scan the code can't start a pairing, even knowing the desktop key", () => {
    const s = sid();
    const init = new PairInitiator({ qr: { ...qr, pairing_code: newPairingCode() }, me: phone.noise, hello, sessionId: s });
    const resp = new PairResponder({ desktopId: desktop.deviceId, deviceId: phone.deviceId, sessionId: s, code, me: desktop.noise });
    expect(() => resp.read(init.start())).toThrow();
  });
});

describe("code linking (Noise XX + commit/reveal)", () => {
  const run = (phone: DeviceIdentity, desktop: DeviceIdentity, s: string) => {
    const info = { device_id: phone.deviceId, platform: "ios" as const, name: "iPhone", signing_public_key: publicOf(phone).signing_public_key };
    const dinfo = { device_id: desktop.deviceId, name: "Mac", signing_public_key: publicOf(desktop).signing_public_key };
    return {
      p: new LinkInitiator({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: s, me: phone.noise, info }),
      d: new LinkResponder({ deviceId: phone.deviceId, desktopId: desktop.deviceId, sessionId: s, me: desktop.noise, info: dinfo }),
    };
  };

  test("both sides show the same six-digit code and learn each other's keys", () => {
    const phone = dev("ios");
    const desktop = dev("desktop");
    const { p, d } = run(phone, desktop, sid());
    const code = d.verify(p.reveal(d.commit(p.answer(d.accept(p.start())))));
    expect(code).toMatch(/^\d{6}$/);
    expect(p.code).toBe(code);
    expect(p.desktopStatic).toEqual(desktop.noise.publicKey);
    expect(p.result(d.declined())).toEqual({ declined: true });
  });

  test("a relay in the middle ends up with different codes on each side", () => {
    const phone = dev("ios");
    const desktop = dev("desktop");
    const mitm = dev("desktop");
    const mitmAsPhone = identityFromStored(phone.deviceId, "ios", generateDeviceKeys());
    const s = sid();
    // phone <-> mitm (posing as the desktop)
    const left = run(phone, { ...mitm, deviceId: desktop.deviceId }, s);
    // mitm (posing as the phone) <-> desktop
    const right = run(mitmAsPhone, desktop, s);
    const leftCode = left.d.verify(left.p.reveal(left.d.commit(left.p.answer(left.d.accept(left.p.start())))));
    const rightCode = right.d.verify(right.p.reveal(right.d.commit(right.p.answer(right.d.accept(right.p.start())))));
    expect(left.p.code).toBe(leftCode);
    expect(leftCode).not.toBe(rightCode);
  });

  test("the phone must commit before it learns the desktop nonce", () => {
    const phone = dev("ios");
    const desktop = dev("desktop");
    const { p, d } = run(phone, desktop, sid());
    const m2 = d.accept(p.start());
    const m3 = p.answer(m2);
    expect(() => d.verify(m3)).toThrow();
  });
});

describe("apns payload", () => {
  const phone = dev("ios");
  const desktop = dev("desktop");
  test("fits, and falls back to the generic alert when the envelope doesn't", () => {
    const m = (text: string) =>
      seal({
        inner: { v: 1, msg_id: newMsgId(), sender_device_id: desktop.deviceId, created_at: NOW, expires_at: NOW + 3_600_000, body: { type: "push", category: "input_request", title: "t", body: text } } as SealedInner,
        to: phone.deviceId,
        sender: desktop.noise,
        recipientStatic: phone.noise.publicKey,
      });
    const small = buildApnsPayload(m("hi"));
    expect(small.sealed).toBe(true);
    expect(utf8(small.body).length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(small.body).aps.alert).toEqual(APNS_GENERIC_ALERT);
    const big = buildApnsPayload(m("z".repeat(1000)), 1024);
    expect(big.sealed).toBe(false);
    expect(JSON.parse(big.body).hr).toBeUndefined();
  });
});

describe("device proofs", () => {
  const phone = dev("ios");
  const pub = publicOf(phone).signing_public_key;
  test("challenge signatures verify only for the right nonce and key", () => {
    const sig = signChallenge(phone.signing, "nonce-1", phone.deviceId);
    expect(verifySignature(sig, challengeBytes("nonce-1", phone.deviceId), pub)).toBe(true);
    expect(verifySignature(sig, challengeBytes("nonce-2", phone.deviceId), pub)).toBe(false);
    expect(verifySignature(sig, challengeBytes("nonce-1", phone.deviceId), publicOf(dev("ios")).signing_public_key)).toBe(false);
    expect(verifySignature("garbage", challengeBytes("nonce-1", phone.deviceId), pub)).toBe(false);
  });
  test("request proofs cover method, path and body", () => {
    const body = utf8('{"a":1}');
    const header = signRequest(phone.signing, phone.deviceId, NOW, "POST", "/v1/sealed", body);
    const p = parseDeviceProof(header)!;
    expect(p.deviceId).toBe(phone.deviceId);
    expect(verifySignature(p.signature, requestBytes(p.deviceId, p.ts, "POST", "/v1/sealed", body), pub)).toBe(true);
    expect(verifySignature(p.signature, requestBytes(p.deviceId, p.ts, "POST", "/v1/devices", body), pub)).toBe(false);
    expect(verifySignature(p.signature, requestBytes(p.deviceId, p.ts, "POST", "/v1/sealed", utf8('{"a":2}')), pub)).toBe(false);
    expect(parseDeviceProof("nope")).toBeNull();
  });
});
