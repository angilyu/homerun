import type { DeviceId, JsonValue, RpcMessage, SealedBody, SealedInner } from "@homerun/core";
import {
  type AppAttestPolicy,
  attestedRole,
  type DeviceIdentity,
  encodePairingUrl,
  fromB64url,
  generateDeviceKeys,
  identityFromStored,
  LinkResponder,
  type LinkStatement,
  liveRespond,
  type LiveSession,
  newMsgId,
  newPairingCode,
  offerTag,
  openSealed,
  PAIR_OFFER_TTL_MS,
  PairResponder,
  publicOf,
  RELAY_PATHS,
  type RemotePlatform,
  seal,
  type SealedRejectReason,
  seenUntil,
  type ServerFrame,
  signLinkStatement,
  toB64url,
  verifyAttestation,
} from "@homerun/protocol";
import { RelayConnection } from "../src";

/**
 * Plays the desktop for the reference client's tests, with the protocol package's responder
 * APIs: offers QR pairing, answers code linking (the test decides whether the codes match),
 * accepts live sessions and answers a few RPC methods, opens sealed messages and sends pushes.
 * The runtime does all this for real in 9b.
 */

interface Peer {
  static: Uint8Array;
  platform: RemotePlatform;
}

export type Received = { ok: true; inner: SealedInner } | { ok: false; reason: SealedRejectReason };

export class FakeDesktop {
  readonly id: DeviceIdentity;
  readonly conn: RelayConnection;
  readonly peers = new Map<string, Peer>();
  readonly received: Received[] = [];
  readonly calls: { from: string; method: string }[] = [];
  private seen = new Map<string, number>();
  private offers = new Map<string, string>();
  private live = new Map<string, LiveSession>();
  private receivedWaiters: ((r: Received) => void)[] = [];
  private unclaimed: Received[] = [];
  /** Decides a code-linking attempt; the test compares the phone's code with this one. */
  confirmCode: (code: string, device: { name: string; platform: RemotePlatform }) => Promise<boolean> = async () => true;
  /** Whose App Attest attestations make a device an iPhone; like the runtime, anything else is web. */
  attest: AppAttestPolicy | null = null;

  constructor(
    readonly relayUrl: string,
    readonly account: string,
    token: () => Promise<string>,
    readonly name = "Studio Mac",
  ) {
    this.id = identityFromStored(crypto.randomUUID() as DeviceId, "desktop", generateDeviceKeys());
    this.conn = new RelayConnection({ url: relayUrl, identity: this.id, token, freshToken: token, reconnect: { initialMs: 50, maxMs: 500 } });
    // Handshake steps are async; frames of one conversation are handled strictly in order.
    this.conn.onFrame((f) => {
      const key = "from" in f && "session" in f ? `${f.type}/${f.from}/${f.session}` : f.type;
      const next = (this.lanes.get(key) ?? Promise.resolve()).then(() => this.onFrame(f)).catch((e) => console.error("fake desktop:", e));
      this.lanes.set(key, next);
    });
  }

  get deviceId(): DeviceId {
    return this.id.deviceId;
  }

  async start(): Promise<void> {
    await this.conn.call("POST", RELAY_PATHS.devices, { device: publicOf(this.id), name: this.name });
    await this.conn.connect();
  }

  stop(): void {
    this.conn.close();
  }

  /** Opens a pairing offer and returns the QR code's URL (§9.6). */
  openPairing(): string {
    const code = newPairingCode();
    const offer = offerTag(code);
    this.offers.set(offer, code);
    this.conn.send({ type: "pair_open", offer, expires_at: Date.now() + PAIR_OFFER_TTL_MS });
    return encodePairingUrl({ v: 1, device_id: this.deviceId, static_public_key: publicOf(this.id).static_public_key, pairing_code: code });
  }

  unpair(deviceId: string): void {
    this.conn.send({ type: "link_remove", device_id: deviceId as DeviceId });
    this.peers.delete(deviceId);
  }

  /** Sends a sealed push to a phone, as the runtime does when it needs an answer. */
  async push(to: string, body: Extract<SealedBody, { type: "push" }>, ttlMs = 24 * 3600_000): Promise<ServerFrame> {
    const now = Date.now();
    const env = await seal({
      inner: { v: 1, msg_id: newMsgId(), sender_device_id: this.deviceId, created_at: now, expires_at: now + ttlMs, body } as SealedInner,
      to,
      sender: this.id.noise,
      recipientStatic: this.peers.get(to)!.static,
    });
    const reply = this.conn.waitFor("receipt", (r) => r.msg_id === env.header.msg_id).catch(() => null);
    const err = this.conn.waitFor("error", (e) => e.ref === env.header.msg_id).catch(() => null);
    this.conn.send({ type: "sealed", envelope: env });
    return (await Promise.race([reply, err]))!;
  }

  /** The next sealed message the desktop opens (or refuses). */
  nextReceived(timeoutMs = 5000): Promise<Received> {
    const ready = this.unclaimed.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("the desktop received nothing")), timeoutMs);
      this.receivedWaiters.push((r) => (clearTimeout(t), resolve(r)));
    });
  }

  /** Sends a notification to every open live session. */
  notify(method: string, params: Record<string, JsonValue>): void {
    for (const [key, s] of this.live) {
      const [to, session] = key.split("/") as [DeviceId, string];
      for (const frame of s.encrypt({ jsonrpc: "2.0", method, params } as RpcMessage)) {
        this.conn.send({ type: "live", to, session, data: toB64url(frame) });
      }
    }
  }

  private lanes = new Map<string, Promise<void>>();

  private async onFrame(f: ServerFrame): Promise<void> {
    if (f.type === "rendezvous" && f.kind === "pair") return this.onPair(f);
    if (f.type === "rendezvous" && f.kind === "link") return this.onLink(f);
    if (f.type === "live") return this.onLive(f);
    if (f.type === "live_close") this.live.delete(`${f.from}/${f.session}`);
    if (f.type === "sealed") return this.onSealed(f.id, f.envelope);
  }

  // ---------------------------------------------------------------- pairing

  private pairing = new Map<string, PairResponder>();

  private async onPair(f: Extract<ServerFrame, { type: "rendezvous" }>): Promise<void> {
    // The relay only forwards a first pairing message for an open offer; the desktop tries each
    // of its open codes (normally one).
    for (const [offer, code] of this.offers) {
      const r = new PairResponder({ desktopId: this.deviceId, deviceId: f.from, sessionId: f.session, code, me: this.id.noise });
      let read;
      try {
        read = await r.read(fromB64url(f.data));
      } catch {
        continue;
      }
      this.offers.delete(offer);
      const platform = this.role(f.from, read.remoteStatic, read.hello);
      const statement = await this.statement(f.from, read.remoteStatic, read.hello.signing_public_key, platform, "qr");
      this.peers.set(f.from, { static: read.remoteStatic, platform });
      const reply = await r.reply({ device_id: this.deviceId, name: this.name, signing_public_key: publicOf(this.id).signing_public_key, statement });
      this.conn.send({ type: "rendezvous", kind: "pair", to: f.from, session: f.session, data: toB64url(reply) });
      this.conn.send({ type: "link_add", statement, offer });
      this.conn.send({ type: "pair_close", offer });
      return;
    }
    this.conn.send({ type: "rendezvous_close", to: f.from, session: f.session });
  }

  // ---------------------------------------------------------------- code linking

  private linking = new Map<string, { r: LinkResponder; step: number }>();

  private async onLink(f: Extract<ServerFrame, { type: "rendezvous" }>): Promise<void> {
    const key = `${f.from}/${f.session}`;
    let st = this.linking.get(key);
    const send = (b: Uint8Array) => this.conn.send({ type: "rendezvous", kind: "link", to: f.from, session: f.session, data: toB64url(b) });
    if (!st) {
      st = {
        r: new LinkResponder({
          deviceId: f.from,
          desktopId: this.deviceId,
          sessionId: f.session,
          me: this.id.noise,
          info: { device_id: this.deviceId, name: this.name, signing_public_key: publicOf(this.id).signing_public_key },
        }),
        step: 0,
      };
      this.linking.set(key, st);
    }
    const data = fromB64url(f.data);
    if (st.step === 0) {
      st.step = 1;
      return void send(await st.r.accept(data));
    }
    if (st.step === 1) {
      st.step = 2;
      return void send(await st.r.commit(data));
    }
    if (st.step === 2) {
      st.step = 3;
      const code = st.r.verify(data);
      const device = st.r.device!;
      const platform = this.role(f.from, st.r.deviceStatic!, device);
      const ok = await this.confirmCode(code, { name: device.name, platform });
      this.linking.delete(key);
      if (!ok) return void send(st.r.declined());
      const statement = await this.statement(f.from, st.r.deviceStatic!, device.signing_public_key, platform, "code");
      this.peers.set(f.from, { static: st.r.deviceStatic!, platform });
      this.conn.send({ type: "link_add", statement });
      send(st.r.linked(statement));
    }
  }

  private role(deviceId: string, deviceStatic: Uint8Array, d: { platform: RemotePlatform; signing_public_key: string; attestation?: unknown }): RemotePlatform {
    if (d.platform !== "ios" || !this.attest || d.attestation === undefined) return "web";
    const identity = { device_id: deviceId as DeviceId, static_public_key: toB64url(deviceStatic), signing_public_key: d.signing_public_key };
    return attestedRole(d.platform, verifyAttestation(d.attestation, identity, this.attest, Date.now()));
  }

  private statement(deviceId: string, deviceStatic: Uint8Array, signing: string, platform: RemotePlatform, method: "qr" | "code"): Promise<LinkStatement> {
    return signLinkStatement(
      {
        v: 1,
        account: this.account,
        desktop_device_id: this.deviceId,
        device_id: deviceId as DeviceId,
        desktop_static_public_key: publicOf(this.id).static_public_key,
        device_static_public_key: toB64url(deviceStatic),
        device_signing_public_key: signing,
        platform,
        method,
        created_at: Date.now(),
      },
      this.id.signing,
    );
  }

  // ---------------------------------------------------------------- live

  private async onLive(f: Extract<ServerFrame, { type: "live" }>): Promise<void> {
    const key = `${f.from}/${f.session}`;
    const s = this.live.get(key);
    if (!s) {
      const peer = this.peers.get(f.from);
      if (!peer) return void this.conn.send({ type: "live_close", to: f.from, session: f.session });
      const r = await liveRespond({ initiatorId: f.from, responderId: this.deviceId, sessionId: f.session, me: this.id.noise, peer: peer.static }, fromB64url(f.data));
      this.live.set(key, r.session);
      this.conn.send({ type: "live", to: f.from, session: f.session, data: toB64url(r.reply) });
      return;
    }
    const m = s.decrypt(fromB64url(f.data));
    if (!m || !("method" in m) || !("id" in m)) return;
    this.calls.push({ from: f.from, method: m.method });
    const reply: RpcMessage =
      m.method === "echo"
        ? { jsonrpc: "2.0", id: m.id, result: (m.params ?? null) as JsonValue }
        : m.method === "big"
          ? { jsonrpc: "2.0", id: m.id, result: "x".repeat(200_000) }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } };
    for (const frame of s.encrypt(reply)) this.conn.send({ type: "live", to: f.from, session: f.session, data: toB64url(frame) });
  }

  // ---------------------------------------------------------------- sealed

  private async onSealed(id: string, env: Parameters<typeof openSealed>[0]): Promise<void> {
    const now = Date.now();
    const r = await openSealed(env, {
      me: { deviceId: this.deviceId, noise: this.id.noise },
      senderStatic: (from) => this.peers.get(from)?.static ?? null,
      now,
      seen: (msgId) => (this.seen.get(msgId) ?? 0) > now,
    });
    if (r.ok) this.seen.set(r.inner.msg_id, seenUntil(r.inner));
    this.conn.send({ type: "ack", id });
    const out: Received = r.ok ? { ok: true, inner: r.inner } : { ok: false, reason: r.reason };
    this.received.push(out);
    const w = this.receivedWaiters.shift();
    if (w) w(out);
    else this.unclaimed.push(out);
  }
}
