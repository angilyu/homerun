import { z } from "zod";
import { DeviceId, RelayPresence, StaticPublicKey, TimestampMs } from "@homerun/core";
import { framed, fromB64url, toB64url, utf8 } from "./bytes";
import { ed25519Verify, hash, type SigningKey } from "./crypto";
import { DeviceKind, DevicePublic, SigningPublicKey } from "./identity";
import { NOISE_MAX_MESSAGE } from "./noise";
import { SealedEnvelope } from "./sealed";
import { LinkStatement } from "./statement";

/**
 * The relay's wire protocol (§9.2–§9.5): HTTPS endpoints and WebSocket frames between a device
 * and the relay. Every request carries the provider's access token (a JWT the relay verifies
 * with the provider's JWKS) and a device proof (an Ed25519 signature by the device's registered
 * key). Everything end-to-end is opaque here: Noise messages and sealed envelopes.
 *
 * WebSocket frames are JSON text; binary fields are base64url without padding.
 */

export const RELAY_API_VERSION = "v1";
export const WS_SUBPROTOCOL = "homerun.v1";
/** Browsers can't set headers on a WebSocket: they offer `bearer.<token>` as a second subprotocol. */
export const WS_BEARER_PREFIX = "bearer.";

/** The relay's endpoints. `connect` is the WebSocket; the rest are HTTPS. */
export const RELAY_PATHS = {
  connect: "/v1/connect",
  devices: "/v1/devices",
  sealed: "/v1/sealed",
  pushToken: "/v1/push-token",
  account: "/v1/account",
  health: "/v1/health",
} as const;

const B64 = z.string().regex(/^[A-Za-z0-9_-]*$/);
/** A Noise message: at most 65,535 bytes decoded. */
const NoiseB64 = B64.max(Math.ceil((NOISE_MAX_MESSAGE * 4) / 3));
export const SessionId = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const OfferTag = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const DeviceName = z.string().min(1).max(100);

// ---------------------------------------------------------------- device proof

export const RELAY_AUTH_LABEL = "homerun/relay-auth/v1";
export const RELAY_REQUEST_LABEL = "homerun/relay-request/v1";
/** How far a signed request's timestamp may be from the relay's clock. */
export const REQUEST_SKEW_MS = 5 * 60 * 1000;
export const DEVICE_PROOF_HEADER = "homerun-device";

/** WebSocket: the device signs the relay's challenge. */
export function challengeBytes(nonce: string, deviceId: string): Uint8Array {
  return framed(RELAY_AUTH_LABEL, nonce, deviceId);
}

export function signChallenge(key: SigningKey, nonce: string, deviceId: string): string {
  return toB64url(key.sign(challengeBytes(nonce, deviceId)));
}

export function requestBytes(deviceId: string, ts: number, method: string, path: string, body: Uint8Array): Uint8Array {
  return framed(RELAY_REQUEST_LABEL, deviceId, String(ts), method.toUpperCase(), path, toB64url(hash(body)));
}

/** HTTPS: `homerun-device: <device_id>.<ts>.<signature>` over the method, path and body hash. */
export function signRequest(key: SigningKey, deviceId: string, ts: number, method: string, path: string, body: Uint8Array): string {
  return `${deviceId}.${ts}.${toB64url(key.sign(requestBytes(deviceId, ts, method, path, body)))}`;
}

export function parseDeviceProof(header: string | null): { deviceId: string; ts: number; signature: string } | null {
  if (!header) return null;
  const m = /^([0-9a-f-]{36})\.(\d{1,16})\.([A-Za-z0-9_-]{86})$/.exec(header);
  if (!m || !DeviceId.safeParse(m[1]).success) return null;
  return { deviceId: m[1]!, ts: Number(m[2]), signature: m[3]! };
}

export function verifySignature(signature: string, message: Uint8Array, publicKey: string): boolean {
  try {
    return ed25519Verify(fromB64url(signature), message, fromB64url(publicKey));
  } catch {
    return false;
  }
}

export const bodyBytes = (body: string) => utf8(body);

// ---------------------------------------------------------------- HTTPS bodies

export const RegisterDevice = z.strictObject({ device: DevicePublic, name: DeviceName });
export type RegisterDevice = z.infer<typeof RegisterDevice>;

export const LinkedDevice = z.strictObject({
  device_id: DeviceId,
  kind: DeviceKind,
  name: DeviceName,
  static_public_key: StaticPublicKey,
  signing_public_key: SigningPublicKey,
  online: z.boolean(),
  last_seen_at: TimestampMs.nullable(),
  linked_at: TimestampMs.nullable(),
});
export type LinkedDevice = z.infer<typeof LinkedDevice>;

/** `GET /v1/devices`: every device of the account, for linking by code (§10.5). */
export const DeviceList = z.strictObject({ devices: z.array(LinkedDevice) });

export const PostSealed = z.strictObject({ envelope: SealedEnvelope });
export const PostSealedResult = z.strictObject({ msg_id: z.string(), status: z.enum(["queued", "delivered", "pushed"]) });

export const PushTokenBody = z.strictObject({
  token: z.string().regex(/^[0-9a-f]{64,200}$/),
  environment: z.enum(["sandbox", "production"]),
});

export const RelayErrorCode = z.enum([
  "unauthenticated",
  "token_expired",
  "device_proof_invalid",
  "device_unknown",
  "device_key_mismatch",
  "not_linked",
  "forbidden",
  "invalid",
  "too_large",
  "queue_full",
  "rate_limited",
  "too_many_devices",
  "offer_unknown",
  "not_found",
  "internal",
]);
export type RelayErrorCode = z.infer<typeof RelayErrorCode>;

export const RelayErrorBody = z.strictObject({ error: RelayErrorCode, message: z.string().max(500) });

// ---------------------------------------------------------------- WebSocket: device → relay

const Rendezvous = z.strictObject({
  type: z.literal("rendezvous"),
  kind: z.enum(["pair", "link"]),
  to: DeviceId,
  session: SessionId,
  /** On the first pairing message: which open offer it answers. */
  offer: OfferTag.optional(),
  data: NoiseB64,
});

export const ClientFrame = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("auth"), device_id: DeviceId, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }),
  z.strictObject({ type: z.literal("reauth"), token: z.string().min(1).max(8192) }),
  z.strictObject({ type: z.literal("live"), to: DeviceId, session: SessionId, data: NoiseB64 }),
  z.strictObject({ type: z.literal("live_close"), to: DeviceId, session: SessionId }),
  z.strictObject({ type: z.literal("sealed"), envelope: SealedEnvelope }),
  z.strictObject({ type: z.literal("ack"), id: z.string().min(1).max(64) }),
  Rendezvous,
  z.strictObject({ type: z.literal("rendezvous_close"), to: DeviceId, session: SessionId }),
  z.strictObject({ type: z.literal("pair_open"), offer: OfferTag, expires_at: TimestampMs }),
  z.strictObject({ type: z.literal("pair_close"), offer: OfferTag }),
  z.strictObject({ type: z.literal("link_add"), statement: LinkStatement, offer: OfferTag.optional() }),
  z.strictObject({ type: z.literal("link_remove"), device_id: DeviceId }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------------------------------------------------------------- WebSocket: relay → device

export const ReceiptStatus = z.enum(["queued", "delivered", "pushed", "expired", "rejected"]);
export type ReceiptStatus = z.infer<typeof ReceiptStatus>;

export const ServerFrame = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("challenge"), nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/) }),
  z.strictObject({ type: z.literal("ready"), device_id: DeviceId, links: z.array(LinkedDevice), token_expires_at: TimestampMs }),
  RelayPresence,
  z.strictObject({ type: z.literal("live"), from: DeviceId, session: SessionId, data: NoiseB64 }),
  z.strictObject({ type: z.literal("live_close"), from: DeviceId, session: SessionId }),
  z.strictObject({ type: z.literal("sealed"), id: z.string().min(1).max(64), envelope: SealedEnvelope }),
  z.strictObject({
    type: z.literal("receipt"),
    msg_id: z.string(),
    to: DeviceId,
    status: ReceiptStatus,
    reason: z.string().max(200).optional(),
  }),
  z.strictObject({
    type: z.literal("rendezvous"),
    kind: z.enum(["pair", "link"]),
    from: DeviceId,
    session: SessionId,
    data: NoiseB64,
    /** The relay's registration of the sender (unauthenticated end to end; Noise checks keys). */
    device: z.strictObject({ kind: DeviceKind, name: DeviceName }).optional(),
  }),
  z.strictObject({ type: z.literal("rendezvous_close"), from: DeviceId, session: SessionId }),
  z.strictObject({ type: z.literal("links"), links: z.array(LinkedDevice) }),
  z.strictObject({ type: z.literal("reauthed"), token_expires_at: TimestampMs }),
  z.strictObject({ type: z.literal("error"), code: RelayErrorCode, message: z.string().max(500), ref: z.string().max(64).optional() }),
  z.strictObject({ type: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

/** WebSocket close codes. */
export const CLOSE = {
  NORMAL: 1000,
  /** The token expired without a `reauth`. */
  TOKEN_EXPIRED: 4401,
  DEVICE_PROOF_INVALID: 4403,
  /** The device was removed (unpaired everywhere or the account deleted). */
  DEVICE_REMOVED: 4410,
  /** Another connection for the same device replaced this one. */
  REPLACED: 4409,
  RATE_LIMITED: 4429,
  PROTOCOL_ERROR: 4400,
} as const;
