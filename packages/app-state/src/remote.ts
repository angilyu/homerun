import { NOTIFICATIONS, type AccountStatus, type PairedDevice, type ProviderDeletion } from "@homerun/core";
import { errorMessage } from "./errors";
import { ago, when } from "./format";
import type { Rpc } from "./rpc";
import { Store } from "./store";
import type { UserItem } from "./threads/timeline";

export interface PairingOffer {
  offer_id: string;
  /** The QR code's content: a one-time secret, shown only on the pairing screen (§9.6). */
  qr_url: string;
  expires_at: number;
  /** Set when a phone scanned it. */
  paired: PairedDevice | null;
}

/**
 * The desktop's account, relay link and paired devices (§9.6, §10): `account.status` and
 * `devices.list`, kept current by `account.changed`, `devices.changed` and
 * `devices.pairing_completed`. The web and iOS clients never see these methods (they're local UI
 * only), so only the desktop builds this.
 */
export class Remote {
  readonly account = new Store<AccountStatus | null>(null);
  readonly devices = new Store<readonly PairedDevice[] | null>(null);
  /** The QR offer on screen, if any. */
  readonly pairing = new Store<PairingOffer | null>(null);
  readonly error = new Store<string | null>(null);
  /** What happened to the sign-in when this desktop deleted the account (§10.9); null otherwise. */
  readonly deleted = new Store<ProviderDeletion | null>(null);

  constructor(private readonly rpc: Rpc) {}

  async refresh(): Promise<void> {
    try {
      const [a, d] = await Promise.all([this.rpc.call("account.status", {}), this.rpc.call("devices.list", {})]);
      this.account.set(a.status);
      this.devices.set(d.devices);
      this.error.set(null);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }

  /** A notification for this store; false if it isn't one. */
  apply(method: string, params: unknown, onProtocolError?: (what: string, detail: unknown) => void): boolean {
    switch (method) {
      case "account.changed": {
        const r = NOTIFICATIONS["account.changed"].params.safeParse(params);
        if (!r.success) onProtocolError?.(method, r.error.issues);
        else this.account.set(r.data.status);
        return true;
      }
      case "devices.changed": {
        const r = NOTIFICATIONS["devices.changed"].params.safeParse(params);
        if (!r.success) onProtocolError?.(method, r.error.issues);
        else this.devices.set(r.data.devices);
        return true;
      }
      case "devices.pairing_completed": {
        const r = NOTIFICATIONS["devices.pairing_completed"].params.safeParse(params);
        if (!r.success) onProtocolError?.(method, r.error.issues);
        else this.pairing.set((p) => (p && p.offer_id === r.data.offer_id ? { ...p, paired: r.data.device } : p));
        return true;
      }
    }
    return false;
  }

  signIn = () => {
    this.deleted.set(null);
    return this.set(this.rpc.call("account.sign_in", {}));
  };
  cancelSignIn = () => this.set(this.rpc.call("account.cancel_sign_in", {}));
  signOut = () => this.set(this.rpc.call("account.sign_out", {}));
  deleteAccount = async () => {
    const r = await this.rpc.call("account.delete", {});
    this.account.set(r.status);
    this.deleted.set(r.provider);
  };

  async unpair(device_id: string): Promise<void> {
    await this.rpc.call("devices.unpair", { device_id });
    this.devices.set((ds) => ds?.filter((d) => d.device_id !== device_id) ?? ds);
  }

  async startPairing(): Promise<PairingOffer> {
    const r = await this.rpc.call("devices.pairing.start", {});
    const offer = { ...r, paired: null };
    this.pairing.set(offer);
    return offer;
  }

  /** The pairing screen closed: cancel its offer unless a phone already used it. */
  async closePairing(): Promise<void> {
    const p = this.pairing.get();
    this.pairing.set(null);
    if (p && !p.paired) await this.rpc.call("devices.pairing.cancel", { offer_id: p.offer_id }).catch(() => {});
  }

  private async set(p: Promise<{ status: AccountStatus }>): Promise<void> {
    this.account.set((await p).status);
  }
}

/** After deleting the account: whether the sign-in at the identity provider went too (§10.9). */
export function deletedText(p: ProviderDeletion): string {
  switch (p) {
    case "deleted":
      return "Your account was deleted, including your sign-in.";
    case "pending":
      return "Your account was deleted. Deleting your sign-in is still finishing; Homerun’s relay keeps trying.";
    case "manual":
      return "Your account was deleted here. Your sign-in wasn’t: delete it with the service you signed in with.";
  }
}

export function platformName(p: PairedDevice["platform"]): string {
  return p === "ios" ? "iPhone" : "Web browser";
}

/** "Connected", "Connecting…", "Offline since 9:41". The last failure, if any, is `relay.error`. */
export function relayText(s: AccountStatus, now: number): string {
  const r = s.relay;
  switch (r.state) {
    case "off":
      return "Not connected";
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "offline":
      return r.since !== null ? `Offline since ${when(r.since, now)}` : "Offline";
  }
}

/** "Online", "Last seen 5 min ago", "Not seen yet". */
export function seenText(d: PairedDevice, now: number): string {
  if (d.online) return "Online";
  return d.last_seen_at !== null ? `Last seen ${ago(d.last_seen_at, now)}` : "Not seen yet";
}

/**
 * "Sent 3 h ago from Wenjing's iPhone": an instruction that waited at the relay while this
 * desktop was offline (§9.4). Null for a message that arrived when it was sent.
 */
export function sentFromText(item: Pick<UserItem, "sent_at" | "surface" | "device_id">, devices: readonly PairedDevice[] | null, now: number): string | null {
  if (item.sent_at === null) return null;
  const d = devices?.find((x) => x.device_id === item.device_id);
  const from = d ? d.name : item.surface === "ios" ? "iPhone" : item.surface === "web" ? "the web" : null;
  return `Sent ${ago(item.sent_at, now)}${from ? ` from ${from}` : ""}`;
}
