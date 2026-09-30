import { MAX_FRAME_BYTES, RpcMessage } from "@homerun/core";
import { framed, fromUtf8, utf8 } from "./bytes";
import type { DhKey, Random } from "./crypto";
import { encryptFragments, Reassembler } from "./frames";
import { type CipherState, HandshakeState, NoiseError } from "./noise";

/**
 * A live session (§9.4): Noise_KK between a remote device (the initiator) and a desktop, both
 * statics pinned at pairing. The prologue binds both device ids and a random session id, so a
 * handshake can't be moved to another session or pair. Handshake messages carry no application
 * data: a replayed first message can never carry a command. After the handshake, each JSON-RPC
 * message (the same protocol as the local socket) is sent as one or more fragments.
 */

export const LIVE_LABEL = "homerun/live/v1";
export const SESSION_ID_BYTES = 16;

export function livePrologue(initiatorId: string, responderId: string, sessionId: string): Uint8Array {
  return framed(LIVE_LABEL, initiatorId, responderId, sessionId);
}

export interface LiveHandshakeOptions {
  initiatorId: string;
  responderId: string;
  sessionId: string;
  me: DhKey;
  /** The peer's pinned static key. */
  peer: Uint8Array;
  random?: Random;
  /** Fixed ephemeral, for vectors only. */
  e?: DhKey;
  /** Smaller fragments, for vectors only. */
  maxChunk?: number;
}

export class LiveSession {
  private readonly send: CipherState;
  private readonly reassembler: Reassembler;
  readonly handshakeHash: Uint8Array;

  constructor(
    send: CipherState,
    recv: CipherState,
    handshakeHash: Uint8Array,
    maxMessageBytes = MAX_FRAME_BYTES,
    /** Smaller fragments, for vectors only. */
    private readonly maxChunk?: number,
  ) {
    this.send = send;
    this.reassembler = new Reassembler(recv, maxMessageBytes);
    this.handshakeHash = handshakeHash;
  }

  /** Encrypts one JSON-RPC message into one or more relay frames. */
  encrypt(message: RpcMessage): Uint8Array[] {
    return this.encryptBytes(utf8(JSON.stringify(message)));
  }

  encryptBytes(bytes: Uint8Array): Uint8Array[] {
    return encryptFragments(this.send, bytes, this.maxChunk);
  }

  /** Decrypts one relay frame; returns the message once its last fragment arrives. */
  decrypt(frame: Uint8Array): RpcMessage | null {
    const whole = this.reassembler.push(frame);
    if (whole === null) return null;
    let json: unknown;
    try {
      json = JSON.parse(fromUtf8(whole));
    } catch {
      throw new NoiseError("frame is not JSON");
    }
    const parsed = RpcMessage.safeParse(json);
    if (!parsed.success) throw new NoiseError("frame is not a JSON-RPC message");
    return parsed.data;
  }

  decryptBytes(frame: Uint8Array): Uint8Array | null {
    return this.reassembler.push(frame);
  }
}

/** The remote device's side: write message 1, read message 2. */
export class LiveInitiator {
  private readonly hs: HandshakeState;

  constructor(private readonly o: LiveHandshakeOptions) {
    this.hs = new HandshakeState({
      pattern: "KK",
      initiator: true,
      prologue: livePrologue(o.initiatorId, o.responderId, o.sessionId),
      s: o.me,
      rs: o.peer,
      random: o.random,
      e: o.e,
    });
  }

  start(): Uint8Array {
    return this.hs.writeMessage();
  }

  finish(message2: Uint8Array): LiveSession {
    const payload = this.hs.readMessage(message2);
    if (payload.length !== 0) throw new NoiseError("handshake messages carry no data");
    const t = this.hs.split();
    return new LiveSession(t.send!, t.recv!, t.handshakeHash, MAX_FRAME_BYTES, this.o.maxChunk);
  }
}

/** The desktop's side: read message 1, write message 2, and the session is ready. */
export function liveRespond(o: LiveHandshakeOptions, message1: Uint8Array): { reply: Uint8Array; session: LiveSession } {
  const hs = new HandshakeState({
    pattern: "KK",
    initiator: false,
    prologue: livePrologue(o.initiatorId, o.responderId, o.sessionId),
    s: o.me,
    rs: o.peer,
    random: o.random,
    e: o.e,
  });
  const payload = hs.readMessage(message1);
  if (payload.length !== 0) throw new NoiseError("handshake messages carry no data");
  const reply = hs.writeMessage();
  const t = hs.split();
  return { reply, session: new LiveSession(t.send!, t.recv!, t.handshakeHash, MAX_FRAME_BYTES, o.maxChunk) };
}
