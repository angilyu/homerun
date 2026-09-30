import { concat } from "./bytes";
import type { CipherState } from "./noise";
import { NOISE_MAX_MESSAGE, NoiseError } from "./noise";
import { TAG_LEN } from "./crypto";

/**
 * Fragmentation inside Noise transport messages (§9.4). Each Noise message's plaintext is one
 * flag byte (0 = last fragment, 1 = more follow) and a chunk, so a message larger than Noise's
 * 65,535-byte limit is split, and a truncated sequence can't pass as complete: the final
 * fragment is authenticated as final.
 */

const EMPTY = new Uint8Array(0);
export const MAX_CHUNK = NOISE_MAX_MESSAGE - TAG_LEN - 1;

export function encryptFragments(cipher: CipherState, message: Uint8Array, maxChunk = MAX_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  do {
    const chunk = message.subarray(off, off + maxChunk);
    off += chunk.length;
    const last = off >= message.length;
    out.push(cipher.encryptWithAd(EMPTY, concat(Uint8Array.of(last ? 0 : 1), chunk)));
  } while (off < message.length);
  return out;
}

/** Reassembles fragments, with a cap on the whole message. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(
    private readonly cipher: CipherState,
    private readonly maxBytes: number,
  ) {}

  /** Returns the complete message, or null if more fragments are expected. */
  push(noiseMessage: Uint8Array): Uint8Array | null {
    if (noiseMessage.length > NOISE_MAX_MESSAGE) throw new NoiseError("frame too long");
    const pt = this.cipher.decryptWithAd(EMPTY, noiseMessage);
    if (pt.length < 1 || (pt[0] !== 0 && pt[0] !== 1)) throw new NoiseError("malformed fragment");
    this.size += pt.length - 1;
    if (this.size > this.maxBytes) throw new NoiseError("message too large");
    this.parts.push(pt.subarray(1));
    if (pt[0] === 1) return null;
    const whole = concat(...this.parts);
    this.parts = [];
    this.size = 0;
    return whole;
  }

  get pending(): boolean {
    return this.parts.length > 0;
  }
}
