import type { PairedDevice } from "@homerun/core";
import { fromB64url } from "@homerun/protocol";
import type { Store } from "../store/store";

/**
 * Phones and browsers linked to this desktop (§9.6): their public keys, pinned when they paired,
 * and the relay's presence. The relay decides who may reach whom; these keys decide who a Noise
 * session or a sealed message is really from.
 */

export interface DeviceRow {
  device_id: string;
  name: string;
  /** The device's role: `ios` only when this desktop verified its App Attest attestation. */
  platform: "ios" | "web";
  /** What the device said it was. */
  claimed_platform: "ios" | "web";
  method: "qr" | "code";
  static_public_key: string;
  signing_public_key: string;
  paired_at: number;
  last_seen_at: number | null;
  /** The App Attest credential key (uncompressed P-256, base64url) and its last counter. */
  attest_key: string | null;
  attest_counter: number | null;
  /** The Secure Enclave key that signs Face ID approvals, bound into the attestation. */
  approval_key: string | null;
}

export class PairedDevices {
  private online = new Set<string>();

  constructor(private store: Store) {}

  list(): PairedDevice[] {
    return this.rows().map((r) => ({
      device_id: r.device_id as PairedDevice["device_id"],
      name: r.name,
      platform: r.platform,
      claimed_platform: r.claimed_platform,
      method: r.method,
      paired_at: r.paired_at,
      online: this.online.has(r.device_id),
      last_seen_at: r.last_seen_at,
      biometric_approvals: r.platform === "ios" && r.approval_key !== null,
    }));
  }

  rows(): DeviceRow[] {
    return this.store.db.query<DeviceRow, []>("SELECT * FROM remote_devices ORDER BY paired_at, device_id").all();
  }

  get(id: string): DeviceRow | null {
    return this.store.db.query<DeviceRow, [string]>("SELECT * FROM remote_devices WHERE device_id = ?").get(id);
  }

  view(id: string): PairedDevice | null {
    return this.list().find((d) => d.device_id === id) ?? null;
  }

  staticKey(id: string): Uint8Array | null {
    const r = this.get(id);
    return r ? fromB64url(r.static_public_key) : null;
  }

  /** Pairing again replaces the old keys: the phone was reset or signed in afresh. */
  add(r: DeviceRow): void {
    this.store.db
      .query(
        `INSERT INTO remote_devices (device_id, name, platform, claimed_platform, method, static_public_key, signing_public_key,
           paired_at, last_seen_at, attest_key, attest_counter, approval_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET name = excluded.name, platform = excluded.platform,
           claimed_platform = excluded.claimed_platform, method = excluded.method,
           static_public_key = excluded.static_public_key, signing_public_key = excluded.signing_public_key,
           paired_at = excluded.paired_at, last_seen_at = excluded.last_seen_at, attest_key = excluded.attest_key,
           attest_counter = excluded.attest_counter, approval_key = excluded.approval_key`,
      )
      .run(
        r.device_id,
        r.name,
        r.platform,
        r.claimed_platform,
        r.method,
        r.static_public_key,
        r.signing_public_key,
        r.paired_at,
        r.last_seen_at,
        r.attest_key,
        r.attest_counter,
        r.approval_key,
      );
  }

  /** Pins a replacement Face ID approval key and the assertion counter that vouched for it. */
  renewApprovalKey(id: string, approvalKey: string, counter: number): boolean {
    return (
      this.store.db
        .query("UPDATE remote_devices SET approval_key = ?, attest_counter = ? WHERE device_id = ? AND platform = 'ios'")
        .run(approvalKey, counter, id).changes > 0
    );
  }

  remove(id: string): boolean {
    this.online.delete(id);
    return this.store.db.query("DELETE FROM remote_devices WHERE device_id = ?").run(id).changes > 0;
  }

  /** Forgets every device; returns their ids. */
  clear(): string[] {
    const ids = this.rows().map((r) => r.device_id);
    this.store.db.query("DELETE FROM remote_devices").run();
    this.online.clear();
    return ids;
  }

  /** Returns whether anything shown changed. */
  setPresence(id: string, online: boolean, lastSeenAt: number | null): boolean {
    const r = this.get(id);
    if (!r) return false;
    const was = this.online.has(id);
    if (online) this.online.add(id);
    else this.online.delete(id);
    const seen = lastSeenAt ?? r.last_seen_at;
    if (seen !== r.last_seen_at) this.store.db.query("UPDATE remote_devices SET last_seen_at = ? WHERE device_id = ?").run(seen, id);
    return was !== online || seen !== r.last_seen_at;
  }

  /** The relay link is down: nobody is known to be online. */
  allOffline(): boolean {
    const any = this.online.size > 0;
    this.online.clear();
    return any;
  }
}
