import { RELAY_QUEUE_MAX_BYTES, RELAY_QUEUE_MAX_MESSAGES } from "@homerun/core";
import { SEALED_MAX_BYTES } from "@homerun/protocol";

/** The relay's limits (§9.4, §10.7). Defaults are the design's; tests shrink them. */
export interface RelayLimits {
  /** Devices per account. */
  maxDevices: number;
  /** Per recipient device: messages and bytes waiting (§9.4: 100 messages or 1 MB). */
  queueMaxMessages: number;
  queueMaxBytes: number;
  sealedMaxBytes: number;
  /** Per account. */
  sealedPerMinute: number;
  rendezvousPerTenMinutes: number;
  registrationsPerHour: number;
  /** Per connection: a token bucket of frames. */
  framesPerSecond: number;
  frameBurst: number;
  /** Frames dropped for rate before the connection is closed. */
  maxDroppedFrames: number;
  /** Open QR offers per desktop. */
  offersPerDesktop: number;
  /** How often `last_seen_at` is written while a device stays connected. */
  lastSeenWriteMs: number;
  /** A connection that hasn't answered the challenge by then is closed. */
  challengeTimeoutMs: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxDevices: 20,
  queueMaxMessages: RELAY_QUEUE_MAX_MESSAGES,
  queueMaxBytes: RELAY_QUEUE_MAX_BYTES,
  sealedMaxBytes: SEALED_MAX_BYTES,
  sealedPerMinute: 60,
  rendezvousPerTenMinutes: 10,
  registrationsPerHour: 30,
  framesPerSecond: 50,
  frameBurst: 200,
  maxDroppedFrames: 100,
  offersPerDesktop: 3,
  lastSeenWriteMs: 5 * 60 * 1000,
  challengeTimeoutMs: 30 * 1000,
};
