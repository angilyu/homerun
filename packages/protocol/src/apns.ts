import { APNS_PAYLOAD_MAX_BYTES } from "@homerun/core";
import { utf8 } from "./bytes";
import type { SealedEnvelope } from "./sealed";

/**
 * The APNs payload for a sealed push (§9.7). Apple sees only a generic alert; the sealed
 * envelope rides in `hr`, and `mutable-content` lets the iOS Notification Service Extension
 * open it and replace the text (milestone 10). If the whole payload would exceed APNs' 4 KB
 * limit, it goes without `hr` and the phone shows the generic text, then syncs when opened.
 */

export const APNS_GENERIC_ALERT = { title: "Homerun", body: "You have a new update." } as const;

export interface ApnsPayload {
  /** The JSON body to POST, at most 4,096 bytes. */
  body: string;
  /** Whether the sealed envelope fit. */
  sealed: boolean;
  /** Seconds since the epoch: APNs stops trying after this (the push's own expiry). */
  expiration: number;
}

export function buildApnsPayload(env: SealedEnvelope, maxBytes = APNS_PAYLOAD_MAX_BYTES): ApnsPayload {
  const aps = { alert: { ...APNS_GENERIC_ALERT }, "mutable-content": 1, sound: "default" };
  const expiration = Math.floor(env.header.expires_at / 1000);
  const withSealed = JSON.stringify({ aps, hr: env });
  if (utf8(withSealed).length <= maxBytes) return { body: withSealed, sealed: true, expiration };
  return { body: JSON.stringify({ aps }), sealed: false, expiration };
}
