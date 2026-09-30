import { concat, utf8 } from "./bytes";
import {
  aeadDecrypt,
  aeadEncrypt,
  CryptoError,
  DH_LEN,
  type DhKey,
  generateX25519,
  hash,
  HASH_LEN,
  noiseHkdf,
  type Random,
  systemRandom,
  TAG_LEN,
} from "./crypto";

/**
 * The Noise Protocol Framework, revision 34 (noiseprotocol.org/noise.html), for the four
 * patterns Homerun uses, with the suite 25519_ChaChaPoly_SHA256 (§9.4, §18). This is protocol
 * code over the primitives in `crypto.ts`; it is checked against an independent implementation's
 * transcripts (the cacophony vectors in `vectors/noise-cacophony.json`).
 */

export const NOISE_MAX_MESSAGE = 65535;
const MAX_NONCE = 2n ** 64n - 1n;

export type PatternName = "K" | "KK" | "IKpsk1" | "XX";
type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";
interface Pattern {
  /** Pre-messages: which statics each side knows in advance (initiator's first, §7.1). */
  initiatorPre: boolean;
  responderPre: boolean;
  messages: Token[][];
  oneWay: boolean;
}

export const PATTERNS: Record<PatternName, Pattern> = {
  // -> s  <- s  ...  -> e, es, ss
  K: { initiatorPre: true, responderPre: true, messages: [["e", "es", "ss"]], oneWay: true },
  // -> s  <- s  ...  -> e, es, ss  <- e, ee, se
  KK: {
    initiatorPre: true,
    responderPre: true,
    messages: [
      ["e", "es", "ss"],
      ["e", "ee", "se"],
    ],
    oneWay: false,
  },
  // <- s  ...  -> e, es, s, ss, psk  <- e, ee, se
  IKpsk1: {
    initiatorPre: false,
    responderPre: true,
    messages: [
      ["e", "es", "s", "ss", "psk"],
      ["e", "ee", "se"],
    ],
    oneWay: false,
  },
  // -> e  <- e, ee, s, es  -> s, se
  XX: {
    initiatorPre: false,
    responderPre: false,
    messages: [["e"], ["e", "ee", "s", "es"], ["s", "se"]],
    oneWay: false,
  },
};

export const protocolName = (p: PatternName) => `Noise_${p}_25519_ChaChaPoly_SHA256`;

export class NoiseError extends Error {
  override name = "NoiseError";
}

// ---------------------------------------------------------------- CipherState (§5.1)

export class CipherState {
  private k: Uint8Array | null = null;
  private n = 0n;

  initializeKey(k: Uint8Array | null): void {
    this.k = k;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  /** The next nonce, for tests. */
  get nonce(): bigint {
    return this.n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    const out = aeadEncrypt(this.k, this.n, ad, plaintext);
    this.n++;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError("nonce exhausted");
    // The nonce advances only on success (§5.1), so a forged message can't desynchronise us.
    const out = aeadDecrypt(this.k, this.n, ad, ciphertext);
    this.n++;
    return out;
  }
}

// ---------------------------------------------------------------- SymmetricState (§5.2)

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  readonly cipher = new CipherState();

  constructor(name: string) {
    const n = utf8(name);
    if (n.length <= HASH_LEN) {
      this.h = new Uint8Array(HASH_LEN);
      this.h.set(n);
    } else {
      this.h = hash(n);
    }
    this.ck = this.h;
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.cipher.initializeKey(tempK!);
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concat(this.h, data));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = noiseHkdf(this.ck, ikm, 3);
    this.ck = ck!;
    this.mixHash(tempH!);
    this.cipher.initializeKey(tempK!);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const c = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(c);
    return c;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const p = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = noiseHkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1!);
    c2.initializeKey(k2!);
    return [c1, c2];
  }
}

// ---------------------------------------------------------------- HandshakeState (§5.3)

export interface HandshakeOptions {
  pattern: PatternName;
  initiator: boolean;
  prologue: Uint8Array;
  /** Our static key, when the pattern has one for our side. */
  s?: DhKey;
  /** Their static public key, when known in advance (a pre-message). */
  rs?: Uint8Array;
  /** Pre-shared key for psk patterns (32 bytes). */
  psk?: Uint8Array;
  /** A fixed ephemeral, for test vectors only. */
  e?: DhKey;
  random?: Random;
}

export interface TransportPair {
  /** Encrypts what we send. Null for the responder of a one-way pattern. */
  send: CipherState | null;
  /** Decrypts what we receive. Null for the initiator of a one-way pattern. */
  recv: CipherState | null;
  handshakeHash: Uint8Array;
  /** Their static public key, now authenticated. */
  remoteStatic: Uint8Array;
}

export class HandshakeState {
  private readonly ss: SymmetricState;
  private readonly pattern: Pattern;
  private readonly initiator: boolean;
  private readonly s: DhKey | undefined;
  private e: DhKey | undefined;
  private rs: Uint8Array | undefined;
  private re: Uint8Array | undefined;
  private readonly psk: Uint8Array | undefined;
  private readonly hasPsk: boolean;
  private readonly random: Random;
  private index = 0;
  private failed = false;

  constructor(o: HandshakeOptions) {
    this.pattern = PATTERNS[o.pattern];
    this.initiator = o.initiator;
    this.s = o.s;
    this.e = o.e;
    this.rs = o.rs;
    this.psk = o.psk;
    this.random = o.random ?? systemRandom;
    this.hasPsk = this.pattern.messages.some((m) => m.includes("psk"));
    if (this.hasPsk && (!this.psk || this.psk.length !== 32)) throw new NoiseError("psk required (32 bytes)");
    if (!this.hasPsk && this.psk) throw new NoiseError("pattern has no psk");
    const needS = this.initiator ? this.pattern.initiatorPre || this.sends("s") : this.pattern.responderPre || this.sends("s");
    if (needS && !this.s) throw new NoiseError("static key required");
    const needRs = this.initiator ? this.pattern.responderPre : this.pattern.initiatorPre;
    if (needRs && (!this.rs || this.rs.length !== DH_LEN)) throw new NoiseError("remote static key required");
    if (!needRs && this.rs) throw new NoiseError("pattern does not take a remote static key in advance");

    this.ss = new SymmetricState(protocolName(o.pattern));
    this.ss.mixHash(o.prologue);
    if (this.pattern.initiatorPre) this.ss.mixHash(this.initiator ? this.s!.publicKey : this.rs!);
    if (this.pattern.responderPre) this.ss.mixHash(this.initiator ? this.rs! : this.s!.publicKey);
  }

  /** Whether our side sends the `token` in any message. */
  private sends(token: Token): boolean {
    return this.pattern.messages.some((m, i) => (i % 2 === 0) === this.initiator && m.includes(token));
  }

  get isInitiator(): boolean {
    return this.initiator;
  }

  get finished(): boolean {
    return this.index >= this.pattern.messages.length;
  }

  /** Whose turn it is. */
  get myTurn(): boolean {
    return !this.finished && (this.index % 2 === 0) === this.initiator;
  }

  get handshakeHash(): Uint8Array {
    return this.ss.h;
  }

  /** The remote static key, once received or if known in advance. */
  get remoteStatic(): Uint8Array | undefined {
    return this.rs;
  }

  private dh(ours: DhKey | undefined, theirs: Uint8Array | undefined): Uint8Array {
    if (!ours || !theirs) throw new NoiseError("missing key for DH");
    return ours.dh(theirs);
  }

  private tokenDh(token: "ee" | "es" | "se" | "ss"): Uint8Array {
    switch (token) {
      case "ee":
        return this.dh(this.e, this.re);
      case "ss":
        return this.dh(this.s, this.rs);
      case "es":
        return this.initiator ? this.dh(this.e, this.rs) : this.dh(this.s, this.re);
      case "se":
        return this.initiator ? this.dh(this.s, this.re) : this.dh(this.e, this.rs);
    }
  }

  private guard(): void {
    if (this.failed) throw new NoiseError("handshake already failed");
    if (this.finished) throw new NoiseError("handshake already finished");
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.guard();
    if (!this.myTurn) throw new NoiseError("not our turn");
    try {
      const out: Uint8Array[] = [];
      for (const t of this.pattern.messages[this.index]!) {
        if (t === "e") {
          if (!this.e) this.e = generateX25519(this.random);
          out.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          if (this.hasPsk) this.ss.mixKey(this.e.publicKey);
        } else if (t === "s") {
          out.push(this.ss.encryptAndHash(this.s!.publicKey));
        } else if (t === "psk") {
          this.ss.mixKeyAndHash(this.psk!);
        } else {
          this.ss.mixKey(this.tokenDh(t));
        }
      }
      out.push(this.ss.encryptAndHash(payload));
      const msg = concat(...out);
      if (msg.length > NOISE_MAX_MESSAGE) throw new NoiseError("message too long");
      this.index++;
      return msg;
    } catch (e) {
      this.failed = true;
      throw e;
    }
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.guard();
    if (this.myTurn) throw new NoiseError("not their turn");
    if (message.length > NOISE_MAX_MESSAGE) throw new NoiseError("message too long");
    try {
      let off = 0;
      const take = (n: number) => {
        if (off + n > message.length) throw new NoiseError("message too short");
        const b = message.subarray(off, off + n);
        off += n;
        return b;
      };
      for (const t of this.pattern.messages[this.index]!) {
        if (t === "e") {
          this.re = take(DH_LEN).slice();
          this.ss.mixHash(this.re);
          if (this.hasPsk) this.ss.mixKey(this.re);
        } else if (t === "s") {
          const len = this.ss.cipher.hasKey() ? DH_LEN + TAG_LEN : DH_LEN;
          this.rs = this.ss.decryptAndHash(take(len)).slice();
        } else if (t === "psk") {
          this.ss.mixKeyAndHash(this.psk!);
        } else {
          this.ss.mixKey(this.tokenDh(t));
        }
      }
      const rest = message.subarray(off);
      if (this.ss.cipher.hasKey() && rest.length < TAG_LEN) throw new NoiseError("message too short");
      const payload = this.ss.decryptAndHash(rest);
      this.index++;
      return payload;
    } catch (e) {
      this.failed = true;
      if (e instanceof CryptoError) throw new NoiseError(`handshake failed: ${e.message}`);
      throw e;
    }
  }

  /** After the last message: the transport keys (§5.2 Split). */
  split(): TransportPair {
    if (!this.finished || this.failed) throw new NoiseError("handshake not finished");
    const [c1, c2] = this.ss.split();
    const remoteStatic = this.rs;
    if (!remoteStatic) throw new NoiseError("no remote static key");
    if (this.pattern.oneWay) {
      return this.initiator
        ? { send: c1, recv: null, handshakeHash: this.ss.h, remoteStatic }
        : { send: null, recv: c1, handshakeHash: this.ss.h, remoteStatic };
    }
    return this.initiator
      ? { send: c1, recv: c2, handshakeHash: this.ss.h, remoteStatic }
      : { send: c2, recv: c1, handshakeHash: this.ss.h, remoteStatic };
  }
}
