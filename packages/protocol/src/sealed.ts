import { z } from "zod";
import { CLOCK_SKEW_MS, DeviceId, RELAY_ENVELOPE_VERSION, SealedInner, SealedMsgId, TimestampMs } from "@homerun/core";
import { concat, framed, fromB64url, fromUtf8, toB64url, utf8 } from "./bytes";
import { CryptoError, type DhKey, type Random, systemRandom } from "./crypto";
import { encryptFragments, Reassembler } from "./frames";
import { HandshakeState, NOISE_MAX_MESSAGE, NoiseError } from "./noise";

/**
 * Sealed messages (§9.4): one-way Noise_K from the sender's pinned static to the recipient's.
 * The prologue binds the whole clear header, so the relay can't re-address, re-date or re-label a
 * message without the recipient noticing. The authenticated copy of every field is inside; the
 * clear header is for routing and early dropping only.
 *
 * Wire form of `ciphertext`: a sequence of Noise messages, each preceded by its length (u16
 * big-endian). The first is the handshake message, whose payload is the first fragment; the rest
 * are transport messages. Fragments carry a last-fragment flag (frames.ts).
 */

export const SEALED_LABEL = "homerun/sealed/v1";
/** Largest sealed message the relay accepts and a recipient decrypts (decoded bytes). */
export const SEALED_MAX_BYTES = 512 * 1024;

/** Longest lifetime each kind may claim; longer is refused (§9.4, adjustable instruction expiry). */
export const SEALED_MAX_LIFETIME_MS = {
  instruction: 72 * 60 * 60 * 1000,
  push: 24 * 60 * 60 * 1000,
  answer: 60 * 60 * 1000,
} as const;

export const SealedKind = z.enum(["instruction", "push", "answer"]);
export type SealedKind = z.infer<typeof SealedKind>;

/**
 * What the relay reads. `kind` is in the clear because the relay treats pushes differently (they
 * go to APNs, not to a queue, §9.7); it is authenticated by the prologue like every other field.
 */
export const SealedHeader = z.strictObject({
  v: z.literal(RELAY_ENVELOPE_VERSION),
  mode: z.literal("sealed"),
  kind: SealedKind,
  msg_id: SealedMsgId,
  to_device_id: DeviceId,
  from_device_id: DeviceId,
  expires_at: TimestampMs,
  /**
   * Pushes only: APNs `apns-collapse-id` (`collapseId`), so a withdrawal replaces the push it
   * withdraws. Opaque to the relay; bound by the prologue like everything else.
   */
  collapse_id: z.string().regex(/^[A-Za-z0-9_-]{22}$/).optional(),
});
export type SealedHeader = z.infer<typeof SealedHeader>;

export const SealedEnvelope = z.strictObject({
  header: SealedHeader,
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/).max(Math.ceil((SEALED_MAX_BYTES * 4) / 3)),
});
export type SealedEnvelope = z.infer<typeof SealedEnvelope>;

export function sealedPrologue(h: SealedHeader): Uint8Array {
  const fields = [SEALED_LABEL, String(h.v), h.mode, h.kind, h.msg_id, h.to_device_id, h.from_device_id, String(h.expires_at)];
  // Appended only when present, so headers without one keep their M9 prologue.
  if (h.collapse_id !== undefined) fields.push(h.collapse_id);
  return framed(...fields);
}

export function newMsgId(random: Random = systemRandom): string {
  return toB64url(random(16));
}

export interface SealOptions {
  inner: SealedInner;
  to: string;
  /** Pushes only (`collapseId`). */
  collapseId?: string;
  sender: DhKey;
  recipientStatic: Uint8Array;
  random?: Random;
  /** Fixed ephemeral, for vectors only. */
  e?: DhKey;
  /** Smaller fragments, for vectors only. */
  maxChunk?: number;
}

export async function seal(o: SealOptions): Promise<SealedEnvelope> {
  const inner = SealedInner.parse(o.inner);
  const header: SealedHeader = {
    v: RELAY_ENVELOPE_VERSION,
    mode: "sealed",
    kind: inner.body.type,
    msg_id: inner.msg_id,
    to_device_id: DeviceId.parse(o.to),
    from_device_id: inner.sender_device_id,
    expires_at: inner.expires_at,
    ...(o.collapseId !== undefined ? { collapse_id: o.collapseId } : {}),
  };
  if (o.collapseId !== undefined && inner.body.type !== "push") throw new NoiseError("only pushes carry a collapse id");
  return sealRaw({ ...o, header, plaintext: utf8(JSON.stringify(inner)) });
}

/**
 * Seals arbitrary bytes under an arbitrary header, without checking that they agree. For test
 * vectors (a sender that lies about itself) and for `seal`; applications use `seal`.
 */
export async function sealRaw(o: {
  header: SealedHeader;
  plaintext: Uint8Array;
  sender: DhKey;
  recipientStatic: Uint8Array;
  random?: Random;
  e?: DhKey;
  maxChunk?: number;
}): Promise<SealedEnvelope> {
  const hs = new HandshakeState({
    pattern: "K",
    initiator: true,
    prologue: sealedPrologue(o.header),
    s: o.sender,
    rs: o.recipientStatic,
    random: o.random,
    e: o.e,
  });
  // The handshake message carries an empty payload; the body goes in transport messages.
  const first = await hs.writeMessage();
  const t = hs.split();
  const rest = encryptFragments(t.send!, o.plaintext, o.maxChunk);
  const parts: Uint8Array[] = [];
  for (const m of [first, ...rest]) parts.push(Uint8Array.of(m.length >> 8, m.length & 0xff), m);
  const bytes = concat(...parts);
  if (bytes.length > SEALED_MAX_BYTES) throw new NoiseError("sealed message too large");
  return { header: o.header, ciphertext: toB64url(bytes) };
}

export const SEALED_REJECT_REASONS = [
  "malformed",
  "unsupported_version",
  "too_large",
  "wrong_recipient",
  "unknown_sender",
  "decrypt_failed",
  "sender_mismatch",
  "header_mismatch",
  "expired",
  "from_future",
  "lifetime_too_long",
  "replayed",
] as const;
export type SealedRejectReason = (typeof SEALED_REJECT_REASONS)[number];

export type OpenResult =
  | { ok: true; header: SealedHeader; inner: SealedInner }
  | { ok: false; reason: SealedRejectReason; detail?: string };

export interface OpenOptions {
  /** Our device id and static key. */
  me: { deviceId: string; noise: DhKey };
  /** The pinned static key of a paired sender, or null when the sender isn't paired with us. */
  senderStatic(deviceId: string): Uint8Array | null;
  now: number;
  /** Message ids already processed and not yet expired (§9.4 rule 3). */
  seen?(msgId: string): boolean;
}

/**
 * Opens a sealed message and applies every check of §9.4 except whether an answer's request is
 * still pending (the caller knows that). Recording `msg_id` in the seen-set is the caller's job,
 * in the same transaction as the message's effect, so a crash can never apply it twice.
 */
export async function openSealed(raw: unknown, o: OpenOptions): Promise<OpenResult> {
  if (typeof raw === "object" && raw !== null && (raw as { header?: { v?: unknown } }).header?.v !== undefined) {
    if ((raw as { header: { v: unknown } }).header.v !== RELAY_ENVELOPE_VERSION) return { ok: false, reason: "unsupported_version" };
  }
  const env = SealedEnvelope.safeParse(raw);
  if (!env.success) {
    const tooLong = env.error.issues.some((i) => i.code === "too_big");
    return { ok: false, reason: tooLong ? "too_large" : "malformed" };
  }
  const { header } = env.data;
  if (header.to_device_id !== o.me.deviceId) return { ok: false, reason: "wrong_recipient" };
  const rs = o.senderStatic(header.from_device_id);
  if (!rs) return { ok: false, reason: "unknown_sender" };
  // Cheap checks on the clear copy first; they're repeated on the authenticated copy below.
  if (o.now > header.expires_at + CLOCK_SKEW_MS) return { ok: false, reason: "expired" };

  let bytes: Uint8Array;
  try {
    bytes = fromB64url(env.data.ciphertext);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (bytes.length > SEALED_MAX_BYTES) return { ok: false, reason: "too_large" };
  const messages: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; ) {
    if (off + 2 > bytes.length) return { ok: false, reason: "malformed" };
    const len = (bytes[off]! << 8) | bytes[off + 1]!;
    if (len > NOISE_MAX_MESSAGE || off + 2 + len > bytes.length) return { ok: false, reason: "malformed" };
    messages.push(bytes.subarray(off + 2, off + 2 + len));
    off += 2 + len;
  }
  if (messages.length < 2) return { ok: false, reason: "malformed" };

  let plaintext: Uint8Array | null = null;
  try {
    const hs = new HandshakeState({ pattern: "K", initiator: false, prologue: sealedPrologue(header), s: o.me.noise, rs });
    if ((await hs.readMessage(messages[0]!)).length !== 0) return { ok: false, reason: "malformed" };
    const t = hs.split();
    const r = new Reassembler(t.recv!, SEALED_MAX_BYTES);
    for (const [i, m] of messages.slice(1).entries()) {
      plaintext = r.push(m);
      if (plaintext !== null && i !== messages.length - 2) return { ok: false, reason: "malformed" };
    }
  } catch (e) {
    if (e instanceof NoiseError || e instanceof CryptoError) {
      return { ok: false, reason: "decrypt_failed" };
    }
    throw e;
  }
  if (plaintext === null) return { ok: false, reason: "malformed", detail: "truncated" };

  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(plaintext));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof json === "object" && json !== null && (json as { v?: unknown }).v !== RELAY_ENVELOPE_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  const parsed = SealedInner.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "malformed" };
  const inner = parsed.data;
  if (inner.sender_device_id !== header.from_device_id) return { ok: false, reason: "sender_mismatch" };
  if (inner.msg_id !== header.msg_id || inner.expires_at !== header.expires_at || inner.body.type !== header.kind || (header.collapse_id !== undefined && header.kind !== "push")) {
    return { ok: false, reason: "header_mismatch" };
  }
  if (o.now > inner.expires_at + CLOCK_SKEW_MS) return { ok: false, reason: "expired" };
  if (inner.created_at > o.now + CLOCK_SKEW_MS) return { ok: false, reason: "from_future" };
  if (inner.expires_at - inner.created_at > SEALED_MAX_LIFETIME_MS[inner.body.type]) {
    return { ok: false, reason: "lifetime_too_long" };
  }
  if (o.seen?.(inner.msg_id)) return { ok: false, reason: "replayed" };
  return { ok: true, header, inner };
}

/** How long a msg_id must stay in the seen-set: until it could no longer pass the expiry check. */
export function seenUntil(inner: Pick<SealedInner, "expires_at">): number {
  return inner.expires_at + CLOCK_SKEW_MS;
}

/** The decoded size, for queue accounting. */
export function sealedSize(env: SealedEnvelope): number {
  return Math.floor((env.ciphertext.length * 3) / 4);
}
