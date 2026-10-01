import { PAIRING_OFFER_TTL_MS } from "@homerun/core";
import {
  type AppAttestPolicy,
  type ClientFrame,
  type DeviceIdentity,
  encodePairingUrl,
  fromB64url,
  type LinkStatement,
  newPairingCode,
  offerTag,
  PairResponder,
  publicOf,
  type RemotePlatform,
  type ServerFrame,
  signLinkStatement,
  toB64url,
} from "@homerun/protocol";
import { log } from "../log";
import { agreeWithRelay, deviceRole } from "./attest";
import type { DeviceRow } from "./devices";

/**
 * QR pairing (§9.6): the desktop shows a one-time code in a QR code with its device id and static
 * key; the phone answers with Noise IKpsk1 keyed by the code, which proves it scanned the code
 * and gives us its static key. We sign a link statement for the pair and ask the relay to link
 * the two devices.
 */

type Rendezvous = Extract<ServerFrame, { type: "rendezvous" }>;

export interface PairingDeps {
  me: () => DeviceIdentity;
  name: string;
  /** The signed-in account's subject, written into link statements. */
  account: () => string | null;
  send: (f: ClientFrame) => boolean;
  now: () => number;
  paired: (offerId: string, row: DeviceRow) => void;
  /** Whose App Attest attestations make a device an iPhone (§9.8). */
  attest: AppAttestPolicy;
  ttlMs?: number;
}

interface Offer {
  offerId: string;
  code: string;
  tag: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Pairing {
  private offers = new Map<string, Offer>();
  /** First messages are handled one at a time: the handshake awaits the key, and an offer is single-use. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private d: PairingDeps) {}

  /** Opens an offer; any earlier one closes (there is one pairing screen). */
  start(): { offer_id: string; qr_url: string; expires_at: number } {
    this.closeAll();
    const me = this.d.me();
    const code = newPairingCode();
    const ttl = this.d.ttlMs ?? PAIRING_OFFER_TTL_MS;
    const o: Offer = {
      offerId: crypto.randomUUID(),
      code,
      tag: offerTag(code),
      expiresAt: this.d.now() + ttl,
      timer: setTimeout(() => this.close(o.offerId), ttl),
    };
    this.offers.set(o.offerId, o);
    this.open(o);
    const qr_url = encodePairingUrl({ v: 1, device_id: me.deviceId, static_public_key: publicOf(me).static_public_key, pairing_code: code });
    return { offer_id: o.offerId, qr_url, expires_at: o.expiresAt };
  }

  cancel(offerId: string): boolean {
    return this.close(offerId);
  }

  /** The link (re)connected: the relay has forgotten our offers. */
  reopen(): void {
    for (const o of this.offers.values()) this.open(o);
  }

  closeAll(): void {
    for (const id of [...this.offers.keys()]) this.close(id);
  }

  /** A first pairing message: try it against each open offer (normally one). */
  onRendezvous(f: Rendezvous): void {
    this.queue = this.queue
      .then(() => this.handle(f))
      .catch((e) => {
        log.warn("pairing failed", { error: (e as Error).message });
        this.d.send({ type: "rendezvous_close", to: f.from, session: f.session });
      });
  }

  private async handle(f: Rendezvous): Promise<void> {
    const me = this.d.me();
    for (const o of [...this.offers.values()]) {
      const r = new PairResponder({ desktopId: me.deviceId, deviceId: f.from, sessionId: f.session, code: o.code, me: me.noise });
      let read;
      try {
        read = await r.read(fromB64url(f.data));
      } catch {
        continue;
      }
      // The offer may have closed (cancelled, expired) while the handshake ran.
      if (this.offers.get(o.offerId) !== o) break;
      const account = this.d.account();
      const now = this.d.now();
      const keys = { device_id: f.from, static_public_key: toB64url(read.remoteStatic), signing_public_key: read.hello.signing_public_key };
      // The relay registered the sender with the role its own check of the attestation gave;
      // where the two differ, the device pairs with the lower one (§18 row 102).
      const role = agreeWithRelay(deviceRole(read.hello.platform, read.hello.attestation, keys, this.d.attest, now), f.device?.kind);
      if (!account) break;
      const row: DeviceRow = { ...keys, ...role, name: read.hello.name, method: "qr", paired_at: now, last_seen_at: now };
      const statement = await linkStatement(me, account, row, now);
      if (this.offers.get(o.offerId) !== o) break;
      const reply = await r.reply({ device_id: me.deviceId, name: this.d.name, signing_public_key: publicOf(me).signing_public_key, statement });
      this.d.send({ type: "rendezvous", kind: "pair", to: f.from, session: f.session, data: toB64url(reply) });
      this.d.send({ type: "link_add", statement, offer: o.tag });
      this.close(o.offerId);
      log.info("paired a device by QR code", { device_id: f.from, platform: row.platform });
      this.d.paired(o.offerId, row);
      return;
    }
    this.d.send({ type: "rendezvous_close", to: f.from, session: f.session });
  }

  private open(o: Offer): void {
    this.d.send({ type: "pair_open", offer: o.tag, expires_at: o.expiresAt });
  }

  private close(offerId: string): boolean {
    const o = this.offers.get(offerId);
    if (!o) return false;
    clearTimeout(o.timer);
    this.offers.delete(offerId);
    this.d.send({ type: "pair_close", offer: o.tag });
    return true;
  }
}

/** The desktop's signed statement that it linked this device, in this account (§9.6). */
export function linkStatement(me: DeviceIdentity, account: string, row: DeviceRow, now: number): Promise<LinkStatement> {
  return signLinkStatement(
    {
      v: 1,
      account,
      desktop_device_id: me.deviceId,
      device_id: row.device_id as LinkStatement["device_id"],
      desktop_static_public_key: publicOf(me).static_public_key,
      device_static_public_key: row.static_public_key,
      device_signing_public_key: row.signing_public_key,
      platform: row.platform as RemotePlatform,
      method: row.method,
      created_at: now,
    },
    me.signing,
  );
}
