import type { DeviceId } from "@homerun/core";
import { toB64url, toHex } from "../bytes";
import { ed25519Key, x25519Key } from "../crypto";
import type { DeviceIdentity, DeviceKind } from "../identity";
import { seededRandom } from "./seeded";

/** The devices every vector file uses. Test keys only, published on purpose. */
export const VECTOR_DEVICES = {
  desktop: { device_id: "0e5a3c1d-7b2f-4d8e-9a61-3f0c2b7d9e10", kind: "desktop" },
  phone: { device_id: "5b1f6a2e-3c4d-4e8f-8a7b-1c2d3e4f5a6b", kind: "ios" },
  web: { device_id: "9c8b7a6f-5e4d-4c3b-9a29-18f7e6d5c4b3", kind: "web" },
  other: { device_id: "2d3e4f5a-6b7c-4d8e-9f01-a2b3c4d5e6f7", kind: "ios" },
} as const satisfies Record<string, { device_id: string; kind: DeviceKind }>;
export type VectorDeviceName = keyof typeof VECTOR_DEVICES;

/** A device's keys as written into vector files. */
export interface VectorDeviceKeys {
  device_id: DeviceId;
  kind: DeviceKind;
  x25519_secret: string;
  x25519_public: string;
  ed25519_secret: string;
  ed25519_public: string;
}

export function vectorDeviceKeys(name: VectorDeviceName): VectorDeviceKeys {
  const r = seededRandom(`device/${name}`);
  const x = x25519Key(r(32));
  const e = ed25519Key(r(32));
  return {
    ...VECTOR_DEVICES[name],
    device_id: VECTOR_DEVICES[name].device_id as DeviceId,
    x25519_secret: toHex(x.secretKey),
    x25519_public: toB64url(x.publicKey),
    ed25519_secret: toHex(e.secretKey),
    ed25519_public: toB64url(e.publicKey),
  };
}

export function identityOf(k: VectorDeviceKeys, fromHex: (h: string) => Uint8Array): DeviceIdentity {
  return { deviceId: k.device_id, kind: k.kind, noise: x25519Key(fromHex(k.x25519_secret)), signing: ed25519Key(fromHex(k.ed25519_secret)) };
}

/** A fixed "now": 2026-06-01T00:00:00Z. */
export const T0 = 1_780_272_000_000;
export const ACCOUNT = "user_01J9ZVECTORACCOUNT0000000";
