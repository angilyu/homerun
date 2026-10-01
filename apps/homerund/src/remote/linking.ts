import { type DeviceId, LINK_REQUEST_TTL_MS } from "@homerun/core";
import { type AppAttestPolicy, type ClientFrame, type DeviceIdentity, fromB64url, LinkResponder, publicOf, type ServerFrame, toB64url } from "@homerun/protocol";
import { log } from "../log";
import { type DeviceRole, deviceRole } from "./attest";
import type { DeviceRow } from "./devices";
import { linkStatement } from "./pairing";

/**
 * Linking by matching codes (§10.5): a phone or browser signed in to the same account asks to
 * link; Noise XX and a commit/reveal give both sides the same six digits, which neither could
 * choose. The shell shows the code in a native prompt (never the webview: the new device gets
 * the app's authority), defaulting to Don't Link; the user compares it with the other screen.
 *
 * One request at a time: another device asking meanwhile is turned away, and asks again.
 */

type Rendezvous = Extract<ServerFrame, { type: "rendezvous" }>;

export interface LinkRequestView {
  name: string;
  platform: "ios" | "web";
  claimed_platform: "ios" | "web";
}

export interface LinkingDeps {
  me: () => DeviceIdentity;
  name: string;
  account: () => string | null;
  send: (f: ClientFrame) => boolean;
  now: () => number;
  /** `devices.link_requested` / `devices.link_withdrawn` to the shell. */
  toShell: (method: "devices.link_requested" | "devices.link_withdrawn", params: unknown) => void;
  linked: (row: DeviceRow) => void;
  /** Whose App Attest attestations make a device an iPhone (§9.8). */
  attest: AppAttestPolicy;
  /** The pending request appeared or went away. */
  changed: () => void;
  ttlMs?: number;
}

interface Attempt {
  from: DeviceId;
  session: string;
  r: LinkResponder;
  step: 1 | 2 | 3;
  /** The relay's registration of the sender. */
  kind: string | null;
  request: { id: string; name: string; role: DeviceRole; timer: ReturnType<typeof setTimeout> } | null;
  /** The user answered; the statement is being signed. */
  deciding: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** An attempt that never reaches the prompt is dropped after this. */
const HANDSHAKE_MS = 60_000;

export class Linking {
  private attempt: Attempt | null = null;
  /** Handshake steps await the key; they run one at a time, in the order the relay delivered them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private d: LinkingDeps) {}

  /** The request the shell's prompt is showing, if any. */
  get request(): LinkRequestView | null {
    const r = this.attempt?.request;
    return r ? { name: r.name, platform: r.role.platform, claimed_platform: r.role.claimed_platform } : null;
  }

  onRendezvous(f: Rendezvous): void {
    this.queue = this.queue.then(() => this.handle(f)).catch(() => {});
  }

  private async handle(f: Rendezvous): Promise<void> {
    const a = this.attempt;
    if (a && (a.from !== f.from || a.session !== f.session)) {
      this.d.send({ type: "rendezvous_close", to: f.from, session: f.session });
      return;
    }
    try {
      if (!a) return await this.begin(f);
      const data = fromB64url(f.data);
      if (a.step === 1) {
        a.step = 2;
        const m = await a.r.commit(data);
        if (this.attempt === a) this.reply(a, m);
        return;
      }
      if (a.step === 2 && !a.request) {
        a.step = 3;
        const code = a.r.verify(data);
        const device = a.r.device!;
        const keys = { device_id: a.from, static_public_key: toB64url(a.r.deviceStatic!), signing_public_key: device.signing_public_key };
        const role = deviceRole(device.platform, device.attestation, keys, this.d.attest, this.d.now());
        if (a.kind !== null && a.kind !== role.platform) throw new Error("the device's role doesn't match its registration");
        return this.prompt(a, code, device.name, role);
      }
      throw new Error("unexpected linking message");
    } catch (e) {
      log.info("code linking failed", { error: (e as Error).message });
      this.end(a ?? this.attempt, true);
    }
  }

  /** The other device gave up (or the relay closed the rendezvous). */
  onClose(from: DeviceId, session: string): void {
    const a = this.attempt;
    if (a && a.from === from && a.session === session) this.end(a, false, "cancelled");
  }

  /** The user's answer in the shell's prompt. Returns whether the request was still open. */
  async decide(requestId: string, approve: boolean): Promise<boolean> {
    const a = this.attempt;
    if (!a?.request || a.request.id !== requestId || a.deciding) return false;
    a.deciding = true;
    const account = this.d.account();
    if (!approve || !account) {
      this.reply(a, a.r.declined());
      this.end(a, false);
      return true;
    }
    const me = this.d.me();
    const now = this.d.now();
    const device = a.r.device!;
    const row: DeviceRow = {
      device_id: a.from,
      name: device.name,
      ...a.request.role,
      method: "code",
      static_public_key: toB64url(a.r.deviceStatic!),
      signing_public_key: device.signing_public_key,
      paired_at: now,
      last_seen_at: now,
    };
    const statement = await linkStatement(me, account, row, now);
    // Withdrawn (the phone gave up, the relay link dropped) while signing.
    if (this.attempt !== a) return false;
    this.d.send({ type: "link_add", statement });
    this.reply(a, a.r.linked(statement));
    this.end(a, false);
    log.info("linked a device by code", { device_id: a.from, platform: row.platform });
    this.d.linked(row);
    return true;
  }

  /** The relay link went down: the rendezvous is gone with it. */
  reset(): void {
    if (this.attempt) this.end(this.attempt, false, "cancelled");
  }

  private async begin(f: Rendezvous): Promise<void> {
    const me = this.d.me();
    const r = new LinkResponder({
      deviceId: f.from,
      desktopId: me.deviceId,
      sessionId: f.session,
      me: me.noise,
      info: { device_id: me.deviceId, name: this.d.name, signing_public_key: publicOf(me).signing_public_key },
    });
    const a: Attempt = {
      from: f.from,
      session: f.session,
      r,
      step: 1,
      kind: f.device?.kind ?? null,
      request: null,
      deciding: false,
      timer: setTimeout(() => this.end(a, true), HANDSHAKE_MS),
    };
    this.attempt = a;
    const m = await r.accept(fromB64url(f.data));
    if (this.attempt === a) this.reply(a, m);
  }

  private prompt(a: Attempt, code: string, name: string, role: DeviceRole): void {
    const now = this.d.now();
    const ttl = this.d.ttlMs ?? LINK_REQUEST_TTL_MS;
    clearTimeout(a.timer);
    const id = crypto.randomUUID();
    a.request = {
      id,
      name,
      role,
      timer: setTimeout(() => {
        if (this.attempt !== a || a.deciding) return;
        this.reply(a, a.r.declined());
        this.end(a, false, "expired");
      }, ttl),
    };
    this.d.toShell("devices.link_requested", {
      request_id: id,
      name,
      platform: role.platform,
      claimed_platform: role.claimed_platform,
      code,
      requested_at: now,
      expires_at: now + ttl,
    });
    this.d.changed();
  }

  private reply(a: Attempt, data: Uint8Array): void {
    this.d.send({ type: "rendezvous", kind: "link", to: a.from, session: a.session, data: toB64url(data) });
  }

  private end(a: Attempt | null, close: boolean, withdrawn?: "expired" | "cancelled"): void {
    if (!a || this.attempt !== a) return;
    this.attempt = null;
    clearTimeout(a.timer);
    if (a.request) {
      clearTimeout(a.request.timer);
      if (withdrawn) this.d.toShell("devices.link_withdrawn", { request_id: a.request.id, reason: withdrawn });
      this.d.changed();
    }
    if (close) this.d.send({ type: "rendezvous_close", to: a.from, session: a.session });
  }
}
