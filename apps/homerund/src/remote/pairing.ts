import { PAIRING_OFFER_TTL_MS } from "@homerun/core";
import {
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
    const me = this.d.me();
    const account = this.d.account();
    for (const o of this.offers.values()) {
      const r = new PairResponder({ desktopId: me.deviceId, deviceId: f.from, sessionId: f.session, code: o.code, me: me.noise });
      let read;
      try {
        read = r.read(fromB64url(f.data));
      } catch {
        continue;
      }
      // The relay registered the sender; a phone can't claim to be a browser or the reverse.
      if (!account || (f.device && f.device.kind !== read.hello.platform)) break;
      const now = this.d.now();
      const row: DeviceRow = {
        device_id: f.from,
        name: read.hello.name,
        platform: read.hello.platform,
        method: "qr",
        static_public_key: toB64url(read.remoteStatic),
        signing_public_key: read.hello.signing_public_key,
        paired_at: now,
        last_seen_at: now,
      };
      const statement = linkStatement(me, account, row, now);
      const reply = r.reply({ device_id: me.deviceId, name: this.d.name, signing_public_key: publicOf(me).signing_public_key, statement });
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
export function linkStatement(me: DeviceIdentity, account: string, row: DeviceRow, now: number): LinkStatement {
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
