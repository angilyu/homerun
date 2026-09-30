import { z } from "zod";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { DeviceId, PairingQrPayload } from "@homerun/core";
import { concat, framed, fromB64url, fromUtf8, toB64url, utf8 } from "./bytes";
import { type DhKey, hash, type Random, systemRandom } from "./crypto";
import { SigningPublicKey } from "./identity";
import { HandshakeState, NoiseError } from "./noise";
import { LinkStatement, RemotePlatform } from "./statement";
import { AppAttestation } from "./app-attest";

/**
 * QR pairing (§9.6). The desktop shows `homerun://pair?d=<base64url(JSON PairingQrPayload)>`
 * holding its device id, its static key and a one-time 128-bit code, valid for five minutes. The
 * phone runs Noise_IKpsk1 as initiator with psk = HKDF(code): only a device that scanned this
 * code completes the handshake, and it learns the desktop's key from the QR, not from the relay.
 * The relay sees only `offerTag(code)`, a hash, to route the first message to the right offer.
 */

export const PAIR_LABEL = "homerun/pair/v1";
export const PAIR_OFFER_TTL_MS = 5 * 60 * 1000;
export const PAIR_URL_PREFIX = "homerun://pair?d=";
export const PAIRING_CODE_BYTES = 16;

export function newPairingCode(random: Random = systemRandom): string {
  return toB64url(random(PAIRING_CODE_BYTES));
}

export function encodePairingUrl(p: PairingQrPayload): string {
  return PAIR_URL_PREFIX + toB64url(utf8(JSON.stringify(PairingQrPayload.parse(p))));
}

export function decodePairingUrl(url: string): PairingQrPayload | null {
  if (!url.startsWith(PAIR_URL_PREFIX)) return null;
  try {
    const r = PairingQrPayload.safeParse(JSON.parse(fromUtf8(fromB64url(url.slice(PAIR_URL_PREFIX.length)))));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** The pre-shared key both sides derive from the code (never sent anywhere). */
export function pairingPsk(code: string, desktopDeviceId: string): Uint8Array {
  return hkdf(sha256, fromB64url(code), utf8(PAIR_LABEL), utf8(`psk:${desktopDeviceId}`), 32);
}

/** What the relay is told: enough to match a hello to an offer, nothing that yields the psk. */
export function offerTag(code: string): string {
  return toB64url(hash(concat(utf8("homerun/pair-offer/v1"), fromB64url(code))).subarray(0, 16));
}

export function pairPrologue(desktopId: string, deviceId: string, sessionId: string): Uint8Array {
  return framed(PAIR_LABEL, desktopId, deviceId, sessionId);
}

/** Message 1's payload (phone → desktop), encrypted: who is asking to pair. */
export const PairHello = z.strictObject({
  device_id: DeviceId,
  platform: RemotePlatform,
  name: z.string().min(1).max(100),
  signing_public_key: SigningPublicKey,
  /** An iPhone's App Attest attestation (§9.8); without a valid one the desktop treats it as web. */
  attestation: AppAttestation.optional(),
});
export type PairHello = z.infer<typeof PairHello>;

/** Message 2's payload (desktop → phone): the desktop's name and the signed link. */
export const PairWelcome = z.strictObject({
  device_id: DeviceId,
  name: z.string().min(1).max(100),
  signing_public_key: SigningPublicKey,
  statement: LinkStatement,
});
export type PairWelcome = z.infer<typeof PairWelcome>;

const json = (v: unknown) => utf8(JSON.stringify(v));
function parse<T>(schema: z.ZodType<T>, b: Uint8Array): T {
  try {
    const r = schema.safeParse(JSON.parse(fromUtf8(b)));
    if (r.success) return r.data;
  } catch {
    // fall through
  }
  throw new NoiseError("malformed pairing payload");
}

/** The phone's side. */
export class PairInitiator {
  private readonly hs: HandshakeState;

  constructor(
    private readonly o: {
      qr: PairingQrPayload;
      me: DhKey;
      hello: PairHello;
      sessionId: string;
      random?: Random;
      e?: DhKey;
    },
  ) {
    this.hs = new HandshakeState({
      pattern: "IKpsk1",
      initiator: true,
      prologue: pairPrologue(o.qr.device_id, o.hello.device_id, o.sessionId),
      s: o.me,
      rs: fromB64url(o.qr.static_public_key),
      psk: pairingPsk(o.qr.pairing_code, o.qr.device_id),
      random: o.random,
      e: o.e,
    });
  }

  start(): Promise<Uint8Array> {
    return this.hs.writeMessage(json(PairHello.parse(this.o.hello)));
  }

  /** Reads the desktop's reply. The caller must check the statement names this phone. */
  async finish(message2: Uint8Array): Promise<PairWelcome> {
    const welcome = parse(PairWelcome, await this.hs.readMessage(message2));
    if (welcome.device_id !== this.o.qr.device_id) throw new NoiseError("welcome from a different desktop");
    return welcome;
  }
}

/** The desktop's side, in two steps so it can check the hello and sign a statement in between. */
export class PairResponder {
  private readonly hs: HandshakeState;
  hello: PairHello | null = null;

  constructor(o: { desktopId: string; deviceId: string; sessionId: string; code: string; me: DhKey; random?: Random; e?: DhKey }) {
    this.hs = new HandshakeState({
      pattern: "IKpsk1",
      initiator: false,
      prologue: pairPrologue(o.desktopId, o.deviceId, o.sessionId),
      s: o.me,
      psk: pairingPsk(o.code, o.desktopId),
      random: o.random,
      e: o.e,
    });
  }

  /**
   * Reads message 1. The psk is mixed in before its payload (psk1), so a hello that decrypts
   * proves the sender scanned the code; its static key is authenticated by `ss`.
   */
  async read(message1: Uint8Array): Promise<{ hello: PairHello; remoteStatic: Uint8Array }> {
    const hello = parse(PairHello, await this.hs.readMessage(message1));
    this.hello = hello;
    return { hello, remoteStatic: this.hs.remoteStatic! };
  }

  reply(welcome: PairWelcome): Promise<Uint8Array> {
    return this.hs.writeMessage(json(PairWelcome.parse(welcome)));
  }
}
