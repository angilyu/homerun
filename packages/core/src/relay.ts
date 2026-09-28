import { z } from "zod";
import { named } from "./registry";
import { ClientMsgId, DeviceId, RequestId, TaskId, ThreadId, TimestampMs } from "./common";
import { InputResponse } from "./input";
import { RpcMessage } from "./protocol/jsonrpc";

/**
 * Relay-facing payloads (§9.4, §9.6, §9.7). Schemas only: the Noise `KK` / `K` handshakes and
 * AEAD framing arrive in milestone 9. What the relay can read is the clear header; everything
 * else here is the plaintext *inside* the ciphertext.
 */

export const RELAY_ENVELOPE_VERSION = 1 as const;

const b64url = (len: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${len}}$`));

/** 128-bit random, base64url without padding (§9.4). */
export const SealedMsgId = named("SealedMsgId", b64url(22));
/** X25519 public key, base64url without padding. */
export const StaticPublicKey = named("StaticPublicKey", b64url(43));

// ---------------------------------------------------------------- clear header

/**
 * The routing metadata the relay sees. `expires_at` is a copy for early dropping only; the
 * recipient enforces the authenticated copy inside the ciphertext.
 */
export const RelayEnvelopeHeader = named(
  "RelayEnvelopeHeader",
  z.object({
    v: z.literal(RELAY_ENVELOPE_VERSION),
    mode: z.enum(["live", "sealed"]),
    to_device_id: DeviceId,
    from_device_id: DeviceId,
    expires_at: TimestampMs.optional(),
  }),
);
export type RelayEnvelopeHeader = z.infer<typeof RelayEnvelopeHeader>;

/** Relay → client, in the clear: the other device's presence ("offline, last seen <t>"). */
export const RelayPresence = named(
  "RelayPresence",
  z.object({ type: z.literal("presence"), device_id: DeviceId, online: z.boolean(), last_seen_at: TimestampMs.nullable() }),
);

// ---------------------------------------------------------------- live mode

/** Inside a live-session frame: one JSON-RPC message, the same protocol as the local socket. */
export const LivePayload = named("LivePayload", RpcMessage);

// ---------------------------------------------------------------- sealed mode

/** An instruction queued for an offline desktop: "send anyway, run when my Mac wakes". */
export const SealedInstruction = named(
  "SealedInstruction",
  z.object({
    type: z.literal("instruction"),
    /** Null starts a new chat; with `task_id` it starts a run of that task. */
    thread_id: ThreadId.nullable(),
    task_id: TaskId.optional(),
    client_msg_id: ClientMsgId,
    text: z.string().min(1).max(100_000),
  }),
);

export const PushCategory = named(
  "PushCategory",
  z.enum(["input_request", "run_finished", "run_failed", "monitor_changed", "schedule_missed"]),
);

/** Decrypted by the iOS Notification Service Extension (§9.7). */
export const SealedPush = named(
  "SealedPush",
  z.object({
    type: z.literal("push"),
    category: PushCategory,
    title: z.string().min(1).max(200),
    body: z.string().max(1000),
    thread_id: ThreadId.optional(),
    request_id: RequestId.optional(),
    /** Present when the request can be answered from the lock screen (§9.7). */
    actions: z.array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(64) })).max(4).optional(),
  }),
);

/** An answer from a lock-screen action, sent in one HTTPS POST (§9.7). */
export const SealedAnswer = named(
  "SealedAnswer",
  z.object({ type: z.literal("answer"), request_id: RequestId, response: InputResponse, via: z.literal("notification") }),
);

export const SealedBody = named("SealedBody", z.discriminatedUnion("type", [SealedInstruction, SealedPush, SealedAnswer]));
export type SealedBody = z.infer<typeof SealedBody>;

/** The authenticated plaintext of a sealed message (§9.4). */
export const SealedInner = named(
  "SealedInner",
  z
    .object({
      v: z.literal(RELAY_ENVELOPE_VERSION),
      msg_id: SealedMsgId,
      sender_device_id: DeviceId,
      created_at: TimestampMs,
      expires_at: TimestampMs,
      body: SealedBody,
    })
    .refine((m) => m.expires_at > m.created_at, { path: ["expires_at"], message: "expires_at must be after created_at" }),
);
export type SealedInner = z.infer<typeof SealedInner>;

/** Default lifetimes (§9.4). The instruction expiry is adjustable in settings. */
export const SEALED_EXPIRY_DEFAULT_MS = {
  instruction: 12 * 60 * 60 * 1000,
  push: 24 * 60 * 60 * 1000,
  answer: 60 * 60 * 1000,
} as const satisfies Record<SealedBody["type"], number>;

export const CLOCK_SKEW_MS = 5 * 60 * 1000;
export const RELAY_QUEUE_MAX_MESSAGES = 100;
export const RELAY_QUEUE_MAX_BYTES = 1024 * 1024;
export const APNS_PAYLOAD_MAX_BYTES = 4096;

/** Rule 1 of §9.4: expired once `expires_at` plus the skew allowance has passed. */
export function isSealedExpired(m: Pick<SealedInner, "expires_at">, now: number): boolean {
  return now > m.expires_at + CLOCK_SKEW_MS;
}

// ---------------------------------------------------------------- pairing (§9.6)

export const PairingCode = named(
  "PairingCode",
  z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  "One-time secret shown only in the QR code. Format is not fixed by the design; see README gaps.",
);

export const PairingQrPayload = named(
  "PairingQrPayload",
  z.object({
    v: z.literal(RELAY_ENVELOPE_VERSION),
    device_id: DeviceId,
    static_public_key: StaticPublicKey,
    pairing_code: PairingCode,
  }),
);
export type PairingQrPayload = z.infer<typeof PairingQrPayload>;
