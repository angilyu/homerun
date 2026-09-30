import type { DeviceId } from "@homerun/core";
import { type ClientFrame, type DeviceIdentity, fromB64url, liveRespond, type LiveSession, type ServerFrame, toB64url } from "@homerun/protocol";
import { log } from "../log";
import type { FrameSink, RemotePeer } from "../rpc/server";
import type { DeviceRow } from "./devices";

/**
 * Live sessions (§9.3): a paired device opens Noise KK against our pinned keys, and then speaks
 * the same JSON-RPC as the local socket, one message per Noise message (fragmented if large).
 * Each session becomes an RPC connection whose peer the handshake authenticated; its `hello`
 * must name that device, and what it may call is its role's (§5.2, §13).
 */

type Live = Extract<ServerFrame, { type: "live" }>;

/** An RPC connection, as far as a live session needs one. */
export interface SessionConnection {
  onData(chunk: Buffer): void;
  onClosed(fn: () => void): void;
  close(): void;
}

export interface LiveSessionsDeps {
  me: () => DeviceIdentity;
  device: (id: string) => DeviceRow | null;
  send: (f: ClientFrame) => boolean;
  /** Serve a connection for this peer (`RpcServer.adopt`). */
  adopt: (sink: FrameSink, peer: RemotePeer) => SessionConnection;
  maxPerDevice?: number;
}

/** A phone reconnecting leaves old sessions behind; the oldest go past this many. */
export const MAX_SESSIONS_PER_DEVICE = 4;

interface Session {
  key: string;
  to: DeviceId;
  id: string;
  noise: LiveSession;
  conn: SessionConnection;
  ended: boolean;
}

export class LiveSessions {
  private sessions = new Map<string, Session>();

  constructor(private d: LiveSessionsDeps) {}

  get count(): number {
    return this.sessions.size;
  }

  onLive(f: Live): void {
    const key = `${f.from}/${f.session}`;
    const s = this.sessions.get(key);
    if (s) return this.receive(s, f.data);
    const peer = this.d.device(f.from);
    if (!peer) {
      this.d.send({ type: "live_close", to: f.from, session: f.session });
      return;
    }
    let r;
    try {
      r = liveRespond(
        { initiatorId: f.from, responderId: this.d.me().deviceId, sessionId: f.session, me: this.d.me().noise, peer: fromB64url(peer.static_public_key) },
        fromB64url(f.data),
      );
    } catch (e) {
      log.info("refused a live session", { device_id: f.from, error: (e as Error).message });
      this.d.send({ type: "live_close", to: f.from, session: f.session });
      return;
    }
    this.trim(f.from);
    const session = { key, to: f.from, id: f.session, noise: r.session, ended: false } as Session;
    this.sessions.set(key, session);
    this.d.send({ type: "live", to: f.from, session: f.session, data: toB64url(r.reply) });
    session.conn = this.d.adopt(this.sink(session), { deviceId: f.from, platform: peer.platform });
    session.conn.onClosed(() => this.end(session, true));
  }

  /** The other side closed the session. */
  onClose(from: string, session: string): void {
    const s = this.sessions.get(`${from}/${session}`);
    if (s) this.end(s, false);
  }

  /** Every session with this device (it was unpaired). */
  closeDevice(id: string): void {
    for (const s of [...this.sessions.values()]) if (s.to === id) this.end(s, true);
  }

  /** The relay link went down: Noise state doesn't survive it. */
  closeAll(): void {
    for (const s of [...this.sessions.values()]) this.end(s, false);
  }

  private receive(s: Session, data: string): void {
    let bytes: Uint8Array | null;
    try {
      bytes = s.noise.decryptBytes(fromB64url(data));
    } catch (e) {
      // A frame that fails to decrypt means the keys are out of step (or someone is tampering).
      log.info("closing a live session after a bad frame", { device_id: s.to, error: (e as Error).message });
      return this.end(s, true);
    }
    if (!bytes) return;
    s.conn.onData(Buffer.concat([Buffer.from(bytes), NEWLINE]));
  }

  private sink(s: Session): FrameSink {
    let carry: Buffer = Buffer.alloc(0);
    return {
      write: (buf) => {
        if (s.ended) return buf.length;
        carry = carry.length ? Buffer.concat([carry, buf]) : buf;
        for (;;) {
          const nl = carry.indexOf(0x0a);
          if (nl < 0) break;
          const line = carry.subarray(0, nl);
          carry = carry.subarray(nl + 1);
          for (const frame of s.noise.encryptBytes(line)) {
            if (!this.d.send({ type: "live", to: s.to, session: s.id, data: toB64url(frame) })) {
              queueMicrotask(() => this.end(s, false));
              return buf.length;
            }
          }
        }
        return buf.length;
      },
      end: () => this.end(s, true),
    };
  }

  private trim(device: string): void {
    const mine = [...this.sessions.values()].filter((s) => s.to === device);
    const max = this.d.maxPerDevice ?? MAX_SESSIONS_PER_DEVICE;
    for (const s of mine.slice(0, Math.max(0, mine.length - max + 1))) this.end(s, true);
  }

  private end(s: Session, tellPeer: boolean): void {
    if (s.ended) return;
    s.ended = true;
    this.sessions.delete(s.key);
    if (tellPeer) this.d.send({ type: "live_close", to: s.to, session: s.id });
    s.conn?.close();
  }
}

const NEWLINE = Buffer.from("\n");
