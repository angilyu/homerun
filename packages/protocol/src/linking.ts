import { z } from "zod";
import { DeviceId } from "@homerun/core";
import { concat, constantTimeEqual, framed, fromB64url, fromUtf8, toB64url, utf8 } from "./bytes";
import { type DhKey, hash, type Random, systemRandom } from "./crypto";
import { SigningPublicKey } from "./identity";
import { type CipherState, HandshakeState, NoiseError } from "./noise";
import { LinkStatement, RemotePlatform } from "./statement";
import { AppAttestation } from "./app-attest";

/**
 * Linking with a matching code (§10.5), for a device that can't scan the desktop's QR code. Both
 * devices are signed in to the same account; neither knows the other's key.
 *
 * Noise_XX, phone as initiator, then a commit/reveal exchange inside the session:
 *   phone → desktop  (XX 3)       its details and commit = SHA-256(label ‖ nP)
 *   desktop → phone  (transport)  nD
 *   phone → desktop  (transport)  nP; the desktop checks the commit
 * Both show a 6-digit code from SHA-256(label ‖ handshake hash ‖ nP ‖ nD). A relay in the middle
 * holds two different handshake hashes and must fix nP' (to the desktop) and nD' (to the phone)
 * before it learns the other side's nonce, so each attempt matches with probability 10^-6, and
 * each attempt needs the user. (The design's "hash of both public keys" could be ground by a
 * relay that picks keys, §18.) The user confirms on the desktop, which then signs the link.
 */

export const CODE_LINK_LABEL = "homerun/code-link/v1";
export const SAS_COMMIT_LABEL = "homerun/sas-commit/v1";
export const SAS_LABEL = "homerun/sas/v1";
export const LINK_ATTEMPT_TTL_MS = 5 * 60 * 1000;
const NONCE_BYTES = 32;

export function linkPrologue(deviceId: string, desktopId: string, sessionId: string): Uint8Array {
  return framed(CODE_LINK_LABEL, deviceId, desktopId, sessionId);
}

export function sasCommit(nonce: Uint8Array): Uint8Array {
  return hash(concat(utf8(SAS_COMMIT_LABEL), nonce));
}

/** The six digits both screens show. */
export function sasCode(handshakeHash: Uint8Array, nP: Uint8Array, nD: Uint8Array): string {
  const d = hash(concat(utf8(SAS_LABEL), handshakeHash, nP, nD));
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(d[i]!);
  return (v % 1_000_000n).toString().padStart(6, "0");
}

const Nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** XX message 2's payload (desktop → phone). */
export const LinkDesktopInfo = z.strictObject({
  device_id: DeviceId,
  name: z.string().min(1).max(100),
  signing_public_key: SigningPublicKey,
});
export type LinkDesktopInfo = z.infer<typeof LinkDesktopInfo>;

/** XX message 3's payload (phone → desktop). */
export const LinkDeviceInfo = z.strictObject({
  device_id: DeviceId,
  platform: RemotePlatform,
  name: z.string().min(1).max(100),
  signing_public_key: SigningPublicKey,
  /** An iPhone's App Attest attestation (§9.8); without a valid one the desktop treats it as web. */
  attestation: AppAttestation.optional(),
  commit: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type LinkDeviceInfo = z.infer<typeof LinkDeviceInfo>;

/** Transport messages after the handshake. */
export const LinkMessage = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("nonce"), n: Nonce }),
  z.strictObject({ t: z.literal("reveal"), n: Nonce }),
  z.strictObject({ t: z.literal("linked"), statement: LinkStatement }),
  z.strictObject({ t: z.literal("declined") }),
]);
export type LinkMessage = z.infer<typeof LinkMessage>;

const json = (v: unknown) => utf8(JSON.stringify(v));
function parse<T>(schema: z.ZodType<T>, b: Uint8Array): T {
  try {
    const r = schema.safeParse(JSON.parse(fromUtf8(b)));
    if (r.success) return r.data;
  } catch {
    // fall through
  }
  throw new NoiseError("malformed linking payload");
}
const EMPTY = new Uint8Array(0);

/** The phone's side. */
export class LinkInitiator {
  private readonly hs: HandshakeState;
  private readonly nP: Uint8Array;
  private send: CipherState | null = null;
  private recv: CipherState | null = null;
  private hh: Uint8Array | null = null;
  desktop: LinkDesktopInfo | null = null;
  desktopStatic: Uint8Array | null = null;
  code: string | null = null;

  constructor(
    private readonly o: {
      deviceId: string;
      desktopId: string;
      sessionId: string;
      me: DhKey;
      info: Omit<LinkDeviceInfo, "commit">;
      random?: Random;
      e?: DhKey;
      nonce?: Uint8Array;
    },
  ) {
    this.hs = new HandshakeState({
      pattern: "XX",
      initiator: true,
      prologue: linkPrologue(o.deviceId, o.desktopId, o.sessionId),
      s: o.me,
      random: o.random,
      e: o.e,
    });
    this.nP = o.nonce ?? (o.random ?? systemRandom)(NONCE_BYTES);
  }

  /** XX 1: carries nothing. */
  start(): Promise<Uint8Array> {
    return this.hs.writeMessage(EMPTY);
  }

  /** Reads XX 2 and returns XX 3 with our details and commitment. */
  async answer(message2: Uint8Array): Promise<Uint8Array> {
    const desktop = parse(LinkDesktopInfo, await this.hs.readMessage(message2));
    if (desktop.device_id !== this.o.desktopId) throw new NoiseError("reply from a different desktop");
    this.desktop = desktop;
    this.desktopStatic = this.hs.remoteStatic!;
    const m3 = await this.hs.writeMessage(json(LinkDeviceInfo.parse({ ...this.o.info, commit: toB64url(sasCommit(this.nP)) })));
    const t = this.hs.split();
    this.send = t.send;
    this.recv = t.recv;
    this.hh = t.handshakeHash;
    return m3;
  }

  /** Reads the desktop's nonce; returns our reveal. The code is ready after this. */
  reveal(nonceMessage: Uint8Array): Uint8Array {
    const m = parse(LinkMessage, this.recv!.decryptWithAd(EMPTY, nonceMessage));
    if (m.t !== "nonce") throw new NoiseError("expected the desktop's nonce");
    this.code = sasCode(this.hh!, this.nP, fromB64url(m.n));
    return this.send!.encryptWithAd(EMPTY, json({ t: "reveal", n: toB64url(this.nP) }));
  }

  /** The desktop's verdict after the user compared codes. */
  result(message: Uint8Array): { linked: LinkStatement } | { declined: true } {
    const m = parse(LinkMessage, this.recv!.decryptWithAd(EMPTY, message));
    if (m.t === "linked") return { linked: m.statement };
    if (m.t === "declined") return { declined: true };
    throw new NoiseError("unexpected linking message");
  }
}

/** The desktop's side. */
export class LinkResponder {
  private readonly hs: HandshakeState;
  private readonly nD: Uint8Array;
  private send: CipherState | null = null;
  private recv: CipherState | null = null;
  private hh: Uint8Array | null = null;
  device: LinkDeviceInfo | null = null;
  deviceStatic: Uint8Array | null = null;
  code: string | null = null;

  constructor(
    private readonly o: {
      deviceId: string;
      desktopId: string;
      sessionId: string;
      me: DhKey;
      info: LinkDesktopInfo;
      random?: Random;
      e?: DhKey;
      nonce?: Uint8Array;
    },
  ) {
    this.hs = new HandshakeState({
      pattern: "XX",
      initiator: false,
      prologue: linkPrologue(o.deviceId, o.desktopId, o.sessionId),
      s: o.me,
      random: o.random,
      e: o.e,
    });
    this.nD = o.nonce ?? (o.random ?? systemRandom)(NONCE_BYTES);
  }

  /** Reads XX 1; returns XX 2 with our details. */
  async accept(message1: Uint8Array): Promise<Uint8Array> {
    if ((await this.hs.readMessage(message1)).length !== 0) throw new NoiseError("handshake message 1 carries no data");
    return this.hs.writeMessage(json(LinkDesktopInfo.parse(this.o.info)));
  }

  /** Reads XX 3 (the phone's details and commitment); returns our nonce. */
  async commit(message3: Uint8Array): Promise<Uint8Array> {
    const device = parse(LinkDeviceInfo, await this.hs.readMessage(message3));
    if (device.device_id !== this.o.deviceId) throw new NoiseError("details from a different device");
    this.device = device;
    this.deviceStatic = this.hs.remoteStatic!;
    const t = this.hs.split();
    this.send = t.send;
    this.recv = t.recv;
    this.hh = t.handshakeHash;
    return this.send!.encryptWithAd(EMPTY, json({ t: "nonce", n: toB64url(this.nD) }));
  }

  /** Reads the reveal and checks it against the commitment. The code is ready after this. */
  verify(revealMessage: Uint8Array): string {
    const m = parse(LinkMessage, this.recv!.decryptWithAd(EMPTY, revealMessage));
    if (m.t !== "reveal") throw new NoiseError("expected the reveal");
    const nP = fromB64url(m.n);
    if (!constantTimeEqual(sasCommit(nP), fromB64url(this.device!.commit))) throw new NoiseError("reveal does not match the commitment");
    this.code = sasCode(this.hh!, nP, this.nD);
    return this.code;
  }

  linked(statement: LinkStatement): Uint8Array {
    return this.send!.encryptWithAd(EMPTY, json({ t: "linked", statement: LinkStatement.parse(statement) }));
  }

  declined(): Uint8Array {
    return this.send!.encryptWithAd(EMPTY, json({ t: "declined" }));
  }
}
