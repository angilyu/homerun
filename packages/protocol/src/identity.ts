import { z } from "zod";
import { DeviceId, StaticPublicKey } from "@homerun/core";
import { fromB64url, toB64url } from "./bytes";
import { type DhKey, ed25519Key, generateEd25519, generateX25519, type Random, type SigningKey, systemRandom, x25519Key } from "./crypto";

/**
 * A device's identity (§12, §9.6 step 1): an X25519 static key for Noise and an Ed25519 key for
 * signatures (the relay device proof and, on desktops, link statements).
 */

export const DeviceKind = z.enum(["desktop", "ios", "web"]);
export type DeviceKind = z.infer<typeof DeviceKind>;

/** Ed25519 public key, base64url without padding. */
export const SigningPublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export interface DeviceIdentity {
  readonly deviceId: DeviceId;
  readonly kind: DeviceKind;
  readonly noise: DhKey;
  readonly signing: SigningKey;
}

export const DevicePublic = z.object({
  device_id: DeviceId,
  kind: DeviceKind,
  static_public_key: StaticPublicKey,
  signing_public_key: SigningPublicKey,
});
export type DevicePublic = z.infer<typeof DevicePublic>;

export function publicOf(id: DeviceIdentity): DevicePublic {
  return DevicePublic.parse({
    device_id: id.deviceId,
    kind: id.kind,
    static_public_key: toB64url(id.noise.publicKey),
    signing_public_key: toB64url(id.signing.publicKey),
  });
}

/**
 * The stored form of a device's secret keys: the value of the `device_static_key` keychain item
 * on the desktop (§5.2). Versioned so the format can change.
 */
export const StoredDeviceKeys = z.object({
  v: z.literal(1),
  x25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  ed25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type StoredDeviceKeys = z.infer<typeof StoredDeviceKeys>;

export function generateDeviceKeys(random: Random = systemRandom): StoredDeviceKeys {
  const x = generateX25519(random);
  const e = generateEd25519(random);
  return { v: 1, x25519: toB64url(x.secretKey), ed25519: toB64url(e.secretKey) };
}

export function identityFromStored(deviceId: DeviceId, kind: DeviceKind, stored: StoredDeviceKeys): DeviceIdentity {
  const k = StoredDeviceKeys.parse(stored);
  return { deviceId, kind, noise: x25519Key(fromB64url(k.x25519)), signing: ed25519Key(fromB64url(k.ed25519)) };
}
