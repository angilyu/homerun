import { describe, expect, test } from "bun:test";
import cacophony from "../vectors/noise-cacophony.json";
import { fromHex, toHex } from "../src/bytes";
import { generateX25519, x25519Key } from "../src/crypto";
import { HandshakeState, NoiseError, type PatternName } from "../src/noise";
import { verifyCacophony } from "../src/vectors/cacophony";

describe("Noise against cacophony (an independent implementation)", () => {
  for (const v of cacophony.vectors) {
    test(v.protocol_name, () => {
      expect(verifyCacophony(v)).toEqual({ ok: true });
    });
  }
});

function pair(pattern: PatternName) {
  const is = generateX25519();
  const rs = generateX25519();
  const psk = pattern === "IKpsk1" ? new Uint8Array(32).fill(7) : undefined;
  const pre = { K: [true, true], KK: [true, true], IKpsk1: [false, true], XX: [false, false] }[pattern];
  const prologue = new Uint8Array([1, 2, 3]);
  const init = new HandshakeState({ pattern, initiator: true, prologue, s: is, rs: pre[1] ? rs.publicKey : undefined, psk });
  const resp = new HandshakeState({ pattern, initiator: false, prologue, s: rs, rs: pre[0] ? is.publicKey : undefined, psk });
  return { init, resp, is, rs };
}

describe("handshakes", () => {
  for (const p of ["K", "KK", "IKpsk1", "XX"] as PatternName[]) {
    test(`${p} round trip authenticates both statics`, () => {
      const { init, resp, is, rs } = pair(p);
      let from = init;
      let to = resp;
      while (!init.finished) {
        const m = from.writeMessage(new Uint8Array([9]));
        expect(to.readMessage(m)).toEqual(new Uint8Array([9]));
        [from, to] = [to, from];
      }
      expect(resp.finished).toBe(true);
      const a = init.split();
      const b = resp.split();
      expect(toHex(a.handshakeHash)).toBe(toHex(b.handshakeHash));
      expect(toHex(a.remoteStatic)).toBe(toHex(rs.publicKey));
      expect(toHex(b.remoteStatic)).toBe(toHex(is.publicKey));
      const c = a.send!.encryptWithAd(new Uint8Array(0), new Uint8Array([1, 2]));
      expect(b.recv!.decryptWithAd(new Uint8Array(0), c)).toEqual(new Uint8Array([1, 2]));
    });
  }

  test("a different prologue fails the first authenticated message", () => {
    const is = generateX25519();
    const rs = generateX25519();
    const init = new HandshakeState({ pattern: "KK", initiator: true, prologue: new Uint8Array([1]), s: is, rs: rs.publicKey });
    const resp = new HandshakeState({ pattern: "KK", initiator: false, prologue: new Uint8Array([2]), s: rs, rs: is.publicKey });
    expect(() => resp.readMessage(init.writeMessage())).toThrow(NoiseError);
  });

  test("KK with the wrong remote static fails", () => {
    const is = generateX25519();
    const rs = generateX25519();
    const other = generateX25519();
    const init = new HandshakeState({ pattern: "KK", initiator: true, prologue: new Uint8Array(0), s: is, rs: other.publicKey });
    const resp = new HandshakeState({ pattern: "KK", initiator: false, prologue: new Uint8Array(0), s: rs, rs: is.publicKey });
    expect(() => resp.readMessage(init.writeMessage())).toThrow(NoiseError);
  });

  test("IKpsk1 with the wrong psk fails on the first message", () => {
    const is = generateX25519();
    const rs = generateX25519();
    const init = new HandshakeState({ pattern: "IKpsk1", initiator: true, prologue: new Uint8Array(0), s: is, rs: rs.publicKey, psk: new Uint8Array(32).fill(1) });
    const resp = new HandshakeState({ pattern: "IKpsk1", initiator: false, prologue: new Uint8Array(0), s: rs, psk: new Uint8Array(32).fill(2) });
    expect(() => resp.readMessage(init.writeMessage())).toThrow(NoiseError);
  });

  test("a tampered handshake message is rejected, and the state refuses to continue", () => {
    const { init, resp } = pair("KK");
    const m = init.writeMessage(new Uint8Array([5]));
    m[m.length - 1]! ^= 1;
    expect(() => resp.readMessage(m)).toThrow(NoiseError);
    expect(() => resp.writeMessage()).toThrow(NoiseError);
  });

  test("a low-order public key is refused", () => {
    const s = generateX25519();
    const zero = new Uint8Array(32);
    const init = new HandshakeState({ pattern: "KK", initiator: true, prologue: new Uint8Array(0), s, rs: zero });
    expect(() => init.writeMessage()).toThrow();
  });

  test("transport nonces advance only on success", () => {
    const { init, resp } = pair("KK");
    resp.readMessage(init.writeMessage());
    init.readMessage(resp.writeMessage());
    const a = init.split();
    const b = resp.split();
    const c = a.send!.encryptWithAd(new Uint8Array(0), new Uint8Array([1]));
    const bad = c.slice();
    bad[0]! ^= 1;
    expect(() => b.recv!.decryptWithAd(new Uint8Array(0), bad)).toThrow();
    expect(b.recv!.nonce).toBe(0n);
    expect(b.recv!.decryptWithAd(new Uint8Array(0), c)).toEqual(new Uint8Array([1]));
    expect(() => b.recv!.decryptWithAd(new Uint8Array(0), c)).toThrow();
  });

  test("x25519Key from a fixed secret matches the RFC 7748 example", () => {
    const k = x25519Key(fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"));
    expect(toHex(k.publicKey)).toBe("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  });
});
