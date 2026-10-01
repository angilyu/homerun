import {
  type DeviceId,
  type InputResponse,
  SEALED_EXPIRY_DEFAULT_MS,
  type SealedBody,
  type SealedInner,
  type ThreadId,
  type TaskId,
  type ClientMsgId,
} from "@homerun/core";
import {
  AccountDeleted,
  type AppAttestation,
  type AttestedIdentity,
  decodePairingUrl,
  type DeviceIdentity,
  type DeviceKind,
  fromB64url,
  generateDeviceKeys,
  identityFromStored,
  LinkInitiator,
  type LinkedDevice,
  type LinkStatement,
  newMsgId,
  offerTag,
  openSealed,
  PairInitiator,
  publicOf,
  RELAY_PATHS,
  type ReceiptStatus,
  type RemotePlatform,
  seal,
  type SealedEnvelope,
  type SealedRejectReason,
  seenUntil,
  type ServerFrame,
  systemRandom,
  toB64url,
  verifyLinkStatement,
} from "@homerun/protocol";
import type { Account } from "./account";
import { LiveClosedError, RemoteLive } from "./live";
import { type ConnectionState, type Fetch, RelayConnection, RelayError } from "./relay-connection";
import { RendezvousChannel } from "./rendezvous";
import type { PairedDesktop, RemoteState, RemoteStore } from "./store";

/**
 * The reference remote client (§9, §10): everything a phone or browser does with the relay and
 * a desktop, with no UI and no platform APIs beyond fetch, WebSocket and crypto randomness.
 *
 * The desktop is the authority. The client pins each desktop's static and signing keys when it
 * pairs, and refuses sealed messages from anyone else; the desktop decides what a remote may do.
 */

type Platform = Extract<DeviceKind, RemotePlatform>;
type SealedPushBody = Extract<SealedBody, { type: "push" }>;
type SealedPush = Omit<SealedInner, "body"> & { body: SealedPushBody };

export interface RemoteClientOptions {
  relayUrl: string;
  account: Account;
  store: RemoteStore;
  kind: Platform;
  /** Shown on the desktop's paired-devices list. */
  name: string;
  /** Use the browser form of WebSocket auth (token as a subprotocol). Defaults to `kind === "web"`. */
  browserWebSocket?: boolean;
  reconnect?: { initialMs: number; maxMs: number } | false;
  now?: () => number;
  fetch?: Fetch;
  /**
   * An iPhone's App Attest (§9.8): a fresh attestation of this device's keys, sent when it
   * registers, pairs and links. Without one, the relay and the desktop treat an `ios` device
   * as a browser.
   */
  attest?: (identity: AttestedIdentity) => Promise<AppAttestation>;
}

export interface DesktopView extends PairedDesktop {
  online: boolean;
  last_seen_at: number | null;
}

export interface Instruction {
  text: string;
  thread_id?: ThreadId | null;
  task_id?: TaskId;
  client_msg_id?: ClientMsgId;
}

export type SealedEvent =
  | { ok: true; from: DeviceId; inner: SealedInner }
  | { ok: false; from: string; reason: SealedRejectReason };

export type OpenedPush =
  | { sealed: true; push: SealedPush }
  | { sealed: false; reason: "generic" }
  | { sealed: false; reason: SealedRejectReason };

export class LinkDeclinedError extends Error {
  override name = "LinkDeclinedError";
}
export class PairingError extends Error {
  override name = "PairingError";
}

export class RemoteClient {
  readonly identity: DeviceIdentity;
  readonly conn: RelayConnection;
  private state: RemoteState;
  private presence = new Map<string, { online: boolean; last_seen_at: number | null }>();
  private linkedIds = new Set<string>();
  private sealedListeners = new Set<(e: SealedEvent) => void>();
  private receiptListeners = new Set<(r: Extract<ServerFrame, { type: "receipt" }>) => void>();
  /** Recently delivered msg_ids, so a receipt that beat `waitDelivered` still counts. */
  private delivered = new Set<string>();
  private opening: Promise<unknown> = Promise.resolve();
  private linksListeners = new Set<() => void>();

  private constructor(
    private readonly o: RemoteClientOptions,
    state: RemoteState,
  ) {
    this.state = state;
    this.identity = identityFromStored(state.device.device_id, state.device.kind, state.device.keys);
    this.conn = new RelayConnection({
      url: o.relayUrl,
      identity: this.identity,
      token: () => o.account.accessToken(),
      freshToken: async () => (await o.account.refresh()).accessToken,
      browser: o.browserWebSocket ?? o.kind === "web",
      reconnect: o.reconnect,
      fetch: o.fetch,
      now: o.now,
    });
    this.conn.onFrame((f) => this.onFrame(f));
    this.conn.onState((s) => {
      if (s === "removed") void this.forget();
    });
  }

  /** Loads this device from the store, or creates a new identity (§9.6 step 1). */
  static async create(o: RemoteClientOptions): Promise<RemoteClient> {
    let state = await o.store.load();
    if (!state || state.device.kind !== o.kind) {
      state = {
        device: { device_id: crypto.randomUUID() as DeviceId, kind: o.kind, name: o.name, keys: generateDeviceKeys() },
        desktops: {},
        seen: {},
      };
      await o.store.save(state);
    }
    return new RemoteClient(o, state);
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get deviceId(): DeviceId {
    return this.identity.deviceId;
  }

  get connectionState(): ConnectionState {
    return this.conn.state;
  }

  // ---------------------------------------------------------------- relay

  /** Registers this device's public keys with the relay under the signed-in account. */
  async register(): Promise<void> {
    const attestation = await this.attestation();
    await this.conn.call("POST", RELAY_PATHS.devices, { device: publicOf(this.identity), name: this.state.device.name, ...(attestation ? { attestation } : {}) });
  }

  /** Connects and keeps reconnecting; resolves when the relay has authenticated us. */
  async connect(): Promise<void> {
    await this.conn.connect();
  }

  close(): void {
    this.conn.close();
  }

  /** Every device in the account, for choosing a desktop to link by code (§10.5). */
  async accountDevices(): Promise<LinkedDevice[]> {
    return (await this.conn.call<{ devices: LinkedDevice[] }>("GET", RELAY_PATHS.devices)).devices;
  }

  /** The desktops this device is paired with, with the relay's presence ("last seen"). */
  desktops(): DesktopView[] {
    return Object.values(this.state.desktops).map((d) => ({
      ...d,
      online: this.presence.get(d.device_id)?.online ?? false,
      last_seen_at: this.presence.get(d.device_id)?.last_seen_at ?? null,
    }));
  }

  onSealed(fn: (e: SealedEvent) => void): () => void {
    this.sealedListeners.add(fn);
    return () => this.sealedListeners.delete(fn);
  }

  onReceipt(fn: (r: Extract<ServerFrame, { type: "receipt" }>) => void): () => void {
    this.receiptListeners.add(fn);
    return () => this.receiptListeners.delete(fn);
  }

  // ---------------------------------------------------------------- pairing and linking

  /** Pairs by scanning the desktop's QR code (§9.6): Noise IKpsk1 with the code as the psk. */
  async pair(qrUrl: string, timeoutMs = 30_000): Promise<PairedDesktop> {
    const qr = decodePairingUrl(qrUrl);
    if (!qr) throw new PairingError("not a Homerun pairing code");
    const session = toB64url(systemRandom(16));
    const init = new PairInitiator({ qr, me: this.identity.noise, hello: await this.hello(), sessionId: session });
    const ch = new RendezvousChannel(this.conn, "pair", qr.device_id, session, offerTag(qr.pairing_code));
    const linked = this.waitLinked(qr.device_id, timeoutMs);
    try {
      ch.send(await init.start());
      const welcome = await init.finish(await ch.next(timeoutMs));
      const statement = this.checkStatement(welcome.statement, welcome.signing_public_key, qr.device_id, qr.static_public_key, "qr");
      const desktop: PairedDesktop = {
        device_id: qr.device_id,
        name: welcome.name,
        static_public_key: qr.static_public_key,
        signing_public_key: welcome.signing_public_key,
        statement,
      };
      await linked;
      await this.pin(desktop);
      return desktop;
    } finally {
      linked.catch(() => {});
      ch.close(false);
    }
  }

  /**
   * Links to a desktop in the same account by matching codes (§10.5): Noise XX, then a
   * commit/reveal so neither side can choose the code. `onCode` gets the six digits to show;
   * the user checks they match the desktop's and confirms there.
   */
  async linkByCode(desktopId: string, onCode: (code: string) => void, timeoutMs = 120_000): Promise<PairedDesktop> {
    const session = toB64url(systemRandom(16));
    const init = new LinkInitiator({
      deviceId: this.deviceId,
      desktopId,
      sessionId: session,
      me: this.identity.noise,
      info: await this.hello(),
    });
    const ch = new RendezvousChannel(this.conn, "link", desktopId as DeviceId, session);
    const linked = this.waitLinked(desktopId, timeoutMs);
    let finished = false;
    try {
      ch.send(await init.start());
      ch.send(await init.answer(await ch.next()));
      ch.send(init.reveal(await ch.next()));
      onCode(init.code!);
      const r = init.result(await ch.next(timeoutMs));
      finished = true;
      if ("declined" in r) throw new LinkDeclinedError("the codes were declined on the desktop");
      const desktop = init.desktop!;
      const staticKey = toB64url(init.desktopStatic!);
      const statement = this.checkStatement(r.linked, desktop.signing_public_key, desktopId, staticKey, "code");
      const pinned: PairedDesktop = {
        device_id: desktop.device_id,
        name: desktop.name,
        static_public_key: staticKey,
        signing_public_key: desktop.signing_public_key,
        statement,
      };
      await linked;
      await this.pin(pinned);
      return pinned;
    } finally {
      linked.catch(() => {});
      ch.close(!finished);
    }
  }

  /** Removes the link to a desktop. With no desktops left, the relay forgets this device (§9.6 step 5). */
  async unpair(desktopId: string): Promise<void> {
    const last = Object.keys(this.state.desktops).filter((id) => id !== desktopId).length === 0;
    const done = last
      ? new Promise<void>((resolve) => {
          const off = this.conn.onState((s) => s === "removed" && (off(), resolve()));
        })
      : this.waitUnlinked(desktopId);
    if (!this.conn.send({ type: "link_remove", device_id: desktopId as DeviceId })) throw new RelayError("disconnected", "not connected to the relay");
    await withTimeout(done, 10_000, "the relay didn't confirm the unpairing");
    if (last) await this.forget();
    else await this.unpin(desktopId);
  }

  /** Deletes the account's relay data everywhere (§10.9), forgets this device and signs out. */
  /**
   * Deletes the account, every device's data at the relay and the user at the identity provider
   * (§10.9). The answer says whether the provider's user went too: "pending" means the relay is
   * retrying, "manual" that the user must delete their sign-in there themselves.
   */
  async deleteAccount(): Promise<AccountDeleted["provider"]> {
    const r = AccountDeleted.safeParse(await this.conn.call("DELETE", RELAY_PATHS.account));
    this.conn.close();
    await this.forget();
    await this.o.account.signOut();
    return r.success ? r.data.provider : "manual";
  }

  // ---------------------------------------------------------------- live

  /** Opens a live session with a paired desktop (§9.3). */
  async openLive(desktopId: string, timeoutMs?: number): Promise<RemoteLive> {
    const d = this.state.desktops[desktopId];
    if (!d) throw new LiveClosedError("not paired with that desktop");
    const live = new RemoteLive(this.conn, this.identity, d);
    await live.open(timeoutMs);
    return live;
  }

  // ---------------------------------------------------------------- sealed

  /**
   * Queues an instruction for a desktop, online or not (§9.4): over the WebSocket when
   * connected, else by HTTPS. The desktop applies it once, before it expires (default 12 h).
   */
  async sendInstruction(desktopId: string, i: Instruction, expiresInMs: number = SEALED_EXPIRY_DEFAULT_MS.instruction): Promise<{ msg_id: string; status: ReceiptStatus }> {
    const body: SealedBody = {
      type: "instruction",
      thread_id: i.thread_id ?? null,
      ...(i.task_id ? { task_id: i.task_id } : {}),
      client_msg_id: i.client_msg_id ?? (crypto.randomUUID() as ClientMsgId),
      text: i.text,
    };
    const env = await this.sealTo(desktopId, body, expiresInMs);
    if (this.conn.state === "ready") return this.sendOverSocket(env);
    return this.postSealed(env);
  }

  /** Resolves when the desktop has taken the message off the relay's queue (or already had). */
  waitDelivered(msgId: string, timeoutMs = 30_000): Promise<void> {
    if (this.delivered.has(msgId)) return Promise.resolve();
    return withTimeout(
      new Promise<void>((resolve) => {
        const off = this.onReceipt((r) => r.msg_id === msgId && r.status === "delivered" && (off(), resolve()));
      }),
      timeoutMs,
      "no delivery receipt",
    );
  }

  /**
   * Opens an APNs payload as the iOS Notification Service Extension would (§9.7): the sealed
   * push inside `hr`, or the generic text when it didn't fit (the app then syncs).
   */
  async openPush(apnsBody: string | Record<string, unknown>): Promise<OpenedPush> {
    const payload = typeof apnsBody === "string" ? (JSON.parse(apnsBody) as Record<string, unknown>) : apnsBody;
    if (!("hr" in payload)) return { sealed: false, reason: "generic" };
    const r = await this.open(payload.hr);
    if (!r.ok) return { sealed: false, reason: r.reason };
    if (r.inner.body.type !== "push") return { sealed: false, reason: "header_mismatch" };
    return { sealed: true, push: r.inner as SealedPush };
  }

  /**
   * Answers an input request from a notification action, in one HTTPS POST with no live
   * session (§9.7). Only for a push that offers actions; the desktop applies an answer once,
   * within an hour, and never takes a destructive approval this way.
   */
  async answerFromLockScreen(push: SealedPush, actionId: string, response: InputResponse): Promise<{ msg_id: string; status: ReceiptStatus }> {
    if (this.o.kind !== "ios") throw new Error("only a phone answers from the lock screen");
    const b = push.body;
    if (!b.request_id || !b.actions?.some((a) => a.id === actionId)) throw new Error("this notification can't be answered from the lock screen");
    const env = await this.sealTo(push.sender_device_id, { type: "answer", request_id: b.request_id, response, via: "notification" }, SEALED_EXPIRY_DEFAULT_MS.answer);
    return this.postSealed(env);
  }

  // ---------------------------------------------------------------- push tokens

  async registerPushToken(token: string, environment: "sandbox" | "production"): Promise<void> {
    await this.conn.call("POST", RELAY_PATHS.pushToken, { token, environment });
  }

  async removePushToken(): Promise<void> {
    await this.conn.call("DELETE", RELAY_PATHS.pushToken);
  }

  // ---------------------------------------------------------------- internals

  private async attestation(): Promise<AppAttestation | undefined> {
    if (this.o.kind !== "ios" || !this.o.attest) return undefined;
    const p = publicOf(this.identity);
    return this.o.attest({ device_id: this.deviceId, static_public_key: p.static_public_key, signing_public_key: p.signing_public_key });
  }

  private async hello() {
    const attestation = await this.attestation();
    return {
      device_id: this.deviceId,
      platform: this.o.kind,
      name: this.state.device.name,
      signing_public_key: publicOf(this.identity).signing_public_key,
      ...(attestation ? { attestation } : {}),
    };
  }

  /**
   * What a paired desktop lets this device do: its link statement's platform. An iPhone the
   * desktop couldn't attest is linked as a browser (§9.9).
   */
  role(desktopId: string): RemotePlatform | null {
    return this.state.desktops[desktopId]?.statement.platform ?? null;
  }

  /** A statement is only good if the desktop we talked to signed it, for us, in our account. */
  private checkStatement(raw: unknown, signingKey: string, desktopId: string, desktopStatic: string, method: "qr" | "code"): LinkStatement {
    const s = verifyLinkStatement(raw, signingKey);
    const me = publicOf(this.identity);
    const account = this.o.account.subject;
    if (
      !s ||
      s.desktop_device_id !== desktopId ||
      s.desktop_static_public_key !== desktopStatic ||
      s.device_id !== this.deviceId ||
      s.device_static_public_key !== me.static_public_key ||
      s.device_signing_public_key !== me.signing_public_key ||
      // The desktop may give an unattested iPhone a browser's role, never the reverse.
      (s.platform !== this.o.kind && s.platform !== "web") ||
      s.method !== method ||
      (account !== null && s.account !== account)
    ) {
      throw new PairingError("the desktop's link statement doesn't check out");
    }
    return s;
  }

  private sealTo(desktopId: string, body: SealedBody, expiresInMs: number): Promise<SealedEnvelope> {
    const d = this.state.desktops[desktopId];
    if (!d) throw new Error("not paired with that desktop");
    const now = this.now();
    return seal({
      inner: { v: 1, msg_id: newMsgId(), sender_device_id: this.deviceId, created_at: now, expires_at: now + expiresInMs, body } as SealedInner,
      to: desktopId,
      sender: this.identity.noise,
      recipientStatic: fromB64url(d.static_public_key),
    });
  }

  private async sendOverSocket(env: SealedEnvelope): Promise<{ msg_id: string; status: ReceiptStatus }> {
    const id = env.header.msg_id;
    const answer = new Promise<{ msg_id: string; status: ReceiptStatus }>((resolve, reject) => {
      const off = this.conn.onFrame((f) => {
        if (f.type === "receipt" && f.msg_id === id && f.status !== "delivered") {
          off();
          resolve({ msg_id: id, status: f.status });
        } else if (f.type === "error" && f.ref === id) {
          off();
          reject(new RelayError(f.code, f.message));
        }
      });
    });
    if (!this.conn.send({ type: "sealed", envelope: env })) return this.postSealed(env);
    return withTimeout(answer, 10_000, "the relay didn't take the message");
  }

  private async postSealed(env: SealedEnvelope): Promise<{ msg_id: string; status: ReceiptStatus }> {
    return this.conn.call("POST", RELAY_PATHS.sealed, { envelope: env });
  }

  /** Opens one at a time, so the seen-set check and its update can't interleave. */
  private open(raw: unknown) {
    const r = this.opening.then(() => this.openNow(raw));
    this.opening = r.catch(() => {});
    return r;
  }

  private async openNow(raw: unknown) {
    const now = this.now();
    this.pruneSeen(now);
    const r = await openSealed(raw, {
      me: { deviceId: this.deviceId, noise: this.identity.noise },
      senderStatic: (id) => {
        const d = this.state.desktops[id];
        return d ? fromB64url(d.static_public_key) : null;
      },
      now,
      seen: (id) => id in this.state.seen,
    });
    if (r.ok) {
      this.state.seen[r.inner.msg_id] = seenUntil(r.inner);
      await this.o.store.save(this.state);
    }
    return r;
  }

  private pruneSeen(now: number): void {
    for (const [id, until] of Object.entries(this.state.seen)) if (until < now) delete this.state.seen[id];
  }

  private onFrame(f: ServerFrame): void {
    switch (f.type) {
      case "ready":
      case "links":
        return this.updateLinks(f.links);
      case "presence":
        this.presence.set(f.device_id, { online: f.online, last_seen_at: f.last_seen_at });
        return;
      case "receipt":
        if (f.status === "delivered") {
          this.delivered.add(f.msg_id);
          if (this.delivered.size > DELIVERED_KEPT) this.delivered.delete(this.delivered.values().next().value!);
        }
        for (const l of [...this.receiptListeners]) l(f);
        return;
      case "sealed":
        void this.receiveSealed(f.id, f.envelope);
        return;
    }
  }

  /** A sealed message from the queue: open it, remember it, then ack so the relay drops it. */
  private async receiveSealed(id: string, env: SealedEnvelope): Promise<void> {
    const r = await this.open(env);
    this.conn.send({ type: "ack", id });
    const e: SealedEvent = r.ok ? { ok: true, from: r.inner.sender_device_id, inner: r.inner } : { ok: false, from: env.header.from_device_id, reason: r.reason };
    for (const l of [...this.sealedListeners]) l(e);
  }

  private updateLinks(links: LinkedDevice[]): void {
    this.linkedIds = new Set(links.map((l) => l.device_id));
    for (const l of links) this.presence.set(l.device_id, { online: l.online, last_seen_at: l.last_seen_at });
    // A desktop that unpaired us is gone from the relay's list: forget its keys.
    const gone = Object.keys(this.state.desktops).filter((id) => !this.linkedIds.has(id));
    if (gone.length) {
      for (const id of gone) delete this.state.desktops[id];
      void this.o.store.save(this.state);
    }
    for (const l of [...this.linksListeners]) l();
  }

  private waitLinked(desktopId: string, timeoutMs: number): Promise<void> {
    if (this.linkedIds.has(desktopId)) return Promise.resolve();
    return withTimeout(
      new Promise<void>((resolve) => {
        const off = this.onLinks(() => this.linkedIds.has(desktopId) && (off(), resolve()));
      }),
      timeoutMs,
      "the relay never recorded the link",
    );
  }

  private waitUnlinked(desktopId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const off = this.onLinks(() => !this.linkedIds.has(desktopId) && (off(), resolve()));
    });
  }

  private onLinks(fn: () => void): () => void {
    this.linksListeners.add(fn);
    return () => this.linksListeners.delete(fn);
  }

  private async pin(d: PairedDesktop): Promise<void> {
    this.state.desktops[d.device_id] = d;
    await this.o.store.save(this.state);
  }

  private async unpin(id: string): Promise<void> {
    delete this.state.desktops[id];
    await this.o.store.save(this.state);
  }

  /** The relay removed this device: drop its keys; a new pairing starts with a new identity. */
  private async forget(): Promise<void> {
    this.state.desktops = {};
    this.state.seen = {};
    await this.o.store.clear();
  }
}

const DELIVERED_KEPT = 256;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => (t = setTimeout(() => reject(new RelayError("timeout", message)), ms))),
  ]);
}
