import type { AccountStatus, ApprovalProof, InputRequest, InputResponse, PairedDevice, ProviderDeletion } from "@homerun/core";
import { AccountDeleted, type AppAttestPolicy, approvalRenewalClientDataHash, fromB64url, verifyAssertion, type DeviceIdentity, type LinkedDevice, productionAppAttestPolicy, RELAY_PATHS, type ServerFrame } from "@homerun/protocol";
import { log } from "../log";
import type { FrameSink, RemotePeer } from "../rpc/server";
import { RemoteAccount, SignedOutError, TOKEN_HANDOVER_MS, type AccountDeps } from "./account";
import { approvalRefusal } from "./approvals";
import { type DeviceRow, PairedDevices } from "./devices";
import { forgetIdentity, loadIdentity, newIdentity } from "./keys";
import { RelayLink, type RelayLinkDeps } from "./link";
import { Linking } from "./linking";
import { Pairing } from "./pairing";
import { SealedMessages, type SealedEffects } from "./sealed";
import { LiveSessions, type SessionConnection } from "./sessions";

/**
 * Remote access as the rest of the runtime sees it (§9, §10): the account, the relay link, and
 * the phones and browsers paired with this desktop. It answers the `account.*` and `devices.*`
 * methods, reports changes to local clients, and serves paired devices' live sessions as RPC
 * connections.
 */

export type RemoteNotification =
  | "account.changed"
  | "browser.open"
  | "devices.changed"
  | "devices.pairing_completed"
  | "devices.link_requested"
  | "devices.link_withdrawn";

export interface RemoteDeps extends Omit<AccountDeps, "openBrowser" | "accountSwitched"> {
  /** A notification to local clients or the shell. */
  broadcast: (method: RemoteNotification, params: unknown) => void;
  /** Serve a live session as an RPC connection (`RpcServer.adopt`). */
  adopt?: (sink: FrameSink, peer: RemotePeer) => SessionConnection;
  /** This computer's name, shown on the phone. */
  hostname?: string;
  linkBackoff?: RelayLinkDeps["backoff"];
  wakePingMs?: number;
  pairingTtlMs?: number;
  linkRequestTtlMs?: number;
  /** What sealed instructions and lock-screen answers do (the run manager). */
  effects?: SealedEffects;
  /** Whose App Attest attestations make a device an iPhone; Apple's production root by default. */
  appAttest?: AppAttestPolicy;
  /** An iPhone replaced its Face ID approval key: tell the user on this Mac (§18 row 116). */
  approvalKeyRenewed?: (device: { device_id: string; name: string }) => void;
}

/** What tests may shorten or replace. */
export type RemoteTuning = Pick<RemoteDeps, "fetch" | "signInTimeoutMs" | "handoverMs" | "linkBackoff" | "wakePingMs" | "pairingTtlMs" | "linkRequestTtlMs" | "appAttest">;

/** A remote-access call that can't be done as asked. */
export class RemoteError extends Error {
  override name = "RemoteError";
  constructor(
    readonly kind: "unavailable" | "not_found" | "refused",
    message: string,
  ) {
    super(message);
  }
}

export class RemoteService {
  readonly account: RemoteAccount;
  readonly devices: PairedDevices;
  readonly link: RelayLink | null;
  readonly sessions: LiveSessions;
  private readonly pairing: Pairing;
  private readonly linking: Linking;
  private readonly sealed: SealedMessages;
  private readonly name: string;
  private readonly attest: AppAttestPolicy;
  /** Devices we asked the relay to link and haven't seen in its list yet. */
  private pendingLinks = new Set<string>();
  private cached: { raw: string; id: DeviceIdentity } | null = null;
  private stopped = false;
  /** When the shell last connected, and a timer for the end of its hand-over. */
  private shellAt: number | null = null;
  private handoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private d: RemoteDeps) {
    this.name = deviceName(d.hostname);
    this.devices = new PairedDevices(d.store);
    this.account = new RemoteAccount({
      ...d,
      openBrowser: (url) => d.broadcast("browser.open", { url }),
      accountSwitched: () => this.forgetEverything("someone else signed in"),
    });
    const send = (f: Parameters<RelayLink["send"]>[0]) => this.link?.send(f) ?? false;
    const me = () => this.identity();
    const account = () => this.account.subject;
    const attest = (this.attest = d.appAttest ?? productionAppAttestPolicy(false));
    this.pairing = new Pairing({
      me,
      name: this.name,
      account,
      send,
      now: d.now,
      ttlMs: d.pairingTtlMs,
      attest,
      paired: (offerId, row) => {
        this.added(row);
        const device = this.devices.view(row.device_id);
        if (device) d.broadcast("devices.pairing_completed", { offer_id: offerId, device });
      },
    });
    this.linking = new Linking({
      me,
      name: this.name,
      account,
      send,
      now: d.now,
      ttlMs: d.linkRequestTtlMs,
      attest,
      toShell: (m, p) => d.broadcast(m, p),
      linked: (row) => this.added(row),
      changed: () => this.changed(),
    });
    this.sessions = new LiveSessions({
      me,
      device: (id) => this.devices.get(id),
      send,
      adopt: (sink, peer) => {
        if (!d.adopt) throw new Error("no RPC server to serve live sessions");
        return d.adopt(sink, peer);
      },
    });
    this.sealed = new SealedMessages({
      store: d.store,
      devices: this.devices,
      me,
      now: d.now,
      ...(d.effects ? { effects: d.effects } : {}),
      ack: (id) => void send({ type: "ack", id }),
      post: (env) => (this.link ? this.link.call("POST", RELAY_PATHS.sealed, { envelope: env }) : Promise.reject(new Error("no relay"))),
    });
    this.link = d.config
      ? new RelayLink({
          url: d.config.relayUrl,
          identity: me,
          name: this.name,
          token: () => this.account.accessToken(),
          freshToken: () => this.account.refresh(),
          onFrame: (f) => this.onFrame(f),
          onReady: (f) => {
            this.pendingLinks.clear();
            this.reconcile(f.links);
            this.pairing.reopen();
          },
          onDown: () => this.onDown(),
          onRemoved: () => this.forgetEverything("the relay no longer knows this desktop"),
          onChange: () => this.changed(),
          signedOut: (e) => e instanceof SignedOutError,
          now: d.now,
          ...(d.fetch ? { fetch: d.fetch } : {}),
          ...(d.linkBackoff ? { backoff: d.linkBackoff } : {}),
          ...(d.wakePingMs ? { wakePingMs: d.wakePingMs } : {}),
        })
      : null;
    this.account.onChange(() => {
      this.sync();
      this.changed();
    });
    this.sync();
  }

  status(): AccountStatus {
    const a = this.account.view();
    const l = this.link;
    return {
      ...a,
      relay: l ? { state: l.state, since: l.since, error: l.error } : { state: "off", since: null, error: null },
      link_request: this.linking.request,
    };
  }

  // ---------------------------------------------------------------- account

  signIn(): AccountStatus {
    this.account.signIn();
    return this.status();
  }

  cancelSignIn(): AccountStatus {
    this.account.cancelSignIn();
    return this.status();
  }

  async signOut(): Promise<AccountStatus> {
    await this.account.signOut();
    return this.status();
  }

  /**
   * Deletes what the relay holds for the account (§10.7, §10.9): every device, link and queued
   * message. Then this desktop forgets its pairings and keys and signs out. The provider's user
   * is deleted in its own dashboard (a manual step).
   */
  /**
   * Deletes the account at the relay, which deletes the user at the identity provider too
   * (§10.9). `provider` says whether it did: "pending" means it is retrying, "manual" that the
   * user must delete their sign-in there themselves (a relay with no provider admin, or older).
   */
  async deleteAccount(): Promise<{ status: AccountStatus; provider: ProviderDeletion }> {
    if (!this.link || !this.account.usable) throw new RemoteError("unavailable", "Sign in to delete the account.");
    // Stopped first, so nothing reconnects and registers this desktop again meanwhile.
    this.link.stop();
    let provider: ProviderDeletion;
    try {
      const r = AccountDeleted.safeParse(await this.link.call("DELETE", RELAY_PATHS.account));
      provider = r.success ? r.data.provider : "manual";
    } catch (e) {
      this.sync();
      log.info("couldn't delete the account at the relay", { error: (e as Error).message });
      throw new RemoteError("unavailable", "Couldn't reach the relay, so nothing was deleted. Try again.");
    }
    this.forgetEverything("the account was deleted");
    await this.account.signOut({ forgetAccount: true });
    log.info("deleted the account", { provider });
    return { status: this.status(), provider };
  }

  // ---------------------------------------------------------------- devices

  list(): PairedDevice[] {
    return this.devices.list();
  }

  unpair(deviceId: string): void {
    if (!this.devices.remove(deviceId)) throw new RemoteError("not_found", "No paired device has that id.");
    this.pendingLinks.delete(deviceId);
    this.sessions.closeDevice(deviceId);
    // Offline, the relay still lists the link when we reconnect, and reconciling removes it.
    this.link?.send({ type: "link_remove", device_id: deviceId as PairedDevice["device_id"] });
    log.info("unpaired a device", { device_id: deviceId });
    this.devicesChanged();
  }

  startPairing(): { offer_id: string; qr_url: string; expires_at: number } {
    if (!this.link?.connected || !this.account.subject) throw new RemoteError("unavailable", "Connect to the relay first: sign in and check your connection.");
    if (!this.keysStored()) throw new RemoteError("unavailable", "Homerun is still saving this computer's keys. Try again in a moment.");
    return this.pairing.start();
  }

  cancelPairing(offerId: string): void {
    this.pairing.cancel(offerId);
  }

  async decideLink(requestId: string, approve: boolean): Promise<void> {
    if (!(await this.linking.decide(requestId, approve))) throw new RemoteError("not_found", "That link request has ended.");
  }

  /** Why an iPhone's answer is refused for want of a Face ID proof (§18 row 115), or null. */
  approvalRefusal(deviceId: string, request: InputRequest, response: InputResponse, proof: ApprovalProof | undefined): string | null {
    // The phone signs this desktop's relay identity: the id it paired with.
    const me = loadIdentity(this.d.secrets)?.deviceId ?? "";
    return approvalRefusal(this.devices.get(deviceId), me, request, response, proof, this.d.now());
  }

  /**
   * An iPhone's Face ID enrolment changed, so the Secure Enclave dropped its approval key and made
   * another (§18 row 116). The new key is pinned only when an App Attest assertion from the
   * credential pinned at pairing vouches for it, with a higher counter: a stolen session key alone
   * can't swap in a key of its own. The user hears about it on this Mac.
   */
  renewApprovalKey(deviceId: string, approvalKey: string, assertion: string): void {
    const row = this.devices.get(deviceId);
    if (!row || row.platform !== "ios" || !row.attest_key || row.attest_counter === null) {
      throw new RemoteError("refused", "Only an iPhone this Mac verified can renew its approval key.");
    }
    let r: ReturnType<typeof verifyAssertion>;
    try {
      r = verifyAssertion(fromB64url(assertion), approvalRenewalClientDataHash(deviceId, approvalKey), fromB64url(row.attest_key), row.attest_counter, this.attest);
    } catch {
      r = { ok: false, reason: "malformed" };
    }
    if (!r.ok) {
      log.warn("an approval key renewal didn't verify", { device_id: deviceId, reason: r.reason });
      throw new RemoteError("refused", "This iPhone's new Face ID key couldn't be verified. Approve destructive actions on your Mac.");
    }
    this.devices.renewApprovalKey(deviceId, approvalKey, r.counter);
    this.changed();
    this.d.approvalKeyRenewed?.({ device_id: deviceId, name: row.name });
  }

  // ---------------------------------------------------------------- runtime events

  shellConnected(): void {
    this.shellAt = this.d.now();
    this.account.shellConnected();
  }

  /** A local notification was shown: paired iPhones get it as a sealed push (§9.7). */
  push(n: Parameters<SealedMessages["push"]>[0]): void {
    if (!this.link || !this.account.usable || this.stopped) return;
    try {
      this.sealed.push(n);
    } catch (e) {
      log.info("push not sent", { error: (e as Error).message });
    }
  }

  /** A local notification was withdrawn: so is its push (§18 row 117). */
  withdraw(key: string): void {
    if (!this.link || !this.account.usable || this.stopped) return;
    this.sealed.withdraw(key);
  }

  /** The machine woke from sleep (`power.did_wake`). */
  wake(): void {
    this.link?.wake();
  }

  stop(): void {
    this.stopped = true;
    if (this.handoverTimer) clearTimeout(this.handoverTimer);
    this.pairing.closeAll();
    this.link?.stop();
    this.account.stop();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Runs the relay link while the account is signed in with a token. Without the device's keys
   * it waits for the shell's hand-over to finish: keys created while the Keychain's copy is on
   * its way would replace the ones every phone pinned.
   */
  private sync(): void {
    if (!this.link || this.stopped) return;
    if (!this.account.usable) return this.link.stop();
    if (this.d.secrets.has("device_static_key") || this.handedOver()) return this.link.start();
    if (this.handoverTimer || this.shellAt === null) return;
    const wait = this.shellAt + (this.d.handoverMs ?? TOKEN_HANDOVER_MS) - this.d.now();
    this.handoverTimer = setTimeout(() => {
      this.handoverTimer = null;
      this.sync();
    }, Math.max(0, wait));
  }

  /** The shell has handed over what the Keychain held, or we signed in since (which is later). */
  private handedOver(): boolean {
    if (!this.d.shellSecrets.accepts("refresh_token")) return true;
    return this.shellAt !== null && this.d.now() - this.shellAt >= (this.d.handoverMs ?? TOKEN_HANDOVER_MS);
  }

  /** The device's keys, created on first use. A lost key invalidates every pairing (phones pinned it). */
  private identity(): DeviceIdentity {
    const raw = this.d.secrets.get("device_static_key");
    if (raw && this.cached?.raw === raw) return this.cached.id;
    let id = loadIdentity(this.d.secrets);
    if (!id) {
      if (this.devices.clear().length) {
        log.warn("this desktop's keys are gone; its pairings can't work and are forgotten");
        this.devicesChanged();
      }
      id = newIdentity(this.d.shellSecrets);
    }
    this.cached = { raw: this.d.secrets.get("device_static_key")!, id };
    return id;
  }

  private forgetEverything(why: string): void {
    log.info("forgetting paired devices and this desktop's keys", { why });
    this.pairing.closeAll();
    this.sessions.closeAll();
    this.pendingLinks.clear();
    this.devices.clear();
    this.cached = null;
    forgetIdentity(this.d.secrets, this.d.shellSecrets);
    this.devicesChanged();
  }

  /** A phone pins the key it pairs with, so pairing waits until the shell has stored it (§5.2). */
  private keysStored(): boolean {
    return !this.d.shellSecrets.isPending("device_static_key");
  }

  private onFrame(f: ServerFrame): void {
    switch (f.type) {
      case "links":
        return this.reconcile(f.links);
      case "presence":
        if (this.devices.setPresence(f.device_id, f.online, f.last_seen_at)) this.devicesChanged();
        return;
      case "live":
        return this.sessions.onLive(f);
      case "live_close":
        return this.sessions.onClose(f.from, f.session);
      case "rendezvous":
        if (f.kind === "pair") return this.pairing.onRendezvous(f);
        if (!this.keysStored()) {
          log.info("refused a link request: the device keys aren't stored yet");
          this.link?.send({ type: "rendezvous_close", to: f.from, session: f.session });
          return;
        }
        return this.linking.onRendezvous(f);
      case "rendezvous_close":
        return this.linking.onClose(f.from, f.session);
      case "sealed":
        return void this.sealed.receive(f.id, f.envelope);
      case "error":
        log.info("relay error", { code: f.code, message: f.message });
        return;
    }
  }

  /**
   * The relay's list of devices linked to us. One we don't know (our database was restored, or
   * an unpair happened offline) is unlinked there; one it no longer lists (the phone unpaired
   * itself) is forgotten here.
   */
  private reconcile(links: LinkedDevice[]): void {
    let changed = false;
    const listed = new Set<string>();
    for (const l of links) {
      listed.add(l.device_id);
      this.pendingLinks.delete(l.device_id);
      if (!this.devices.get(l.device_id)) this.link?.send({ type: "link_remove", device_id: l.device_id });
      else changed = this.devices.setPresence(l.device_id, l.online, l.last_seen_at) || changed;
    }
    for (const r of this.devices.rows()) {
      if (listed.has(r.device_id) || this.pendingLinks.has(r.device_id)) continue;
      this.devices.remove(r.device_id);
      this.sessions.closeDevice(r.device_id);
      log.info("a device unpaired itself", { device_id: r.device_id });
      changed = true;
    }
    if (changed) this.devicesChanged();
  }

  private added(row: DeviceRow): void {
    this.devices.add(row);
    this.pendingLinks.add(row.device_id);
    this.devices.setPresence(row.device_id, true, row.last_seen_at);
    this.devicesChanged();
  }

  private onDown(): void {
    this.sessions.closeAll();
    this.linking.reset();
    if (this.devices.allOffline()) this.devicesChanged();
  }

  private devicesChanged(): void {
    this.d.broadcast("devices.changed", { devices: this.devices.list() });
  }

  private changed(): void {
    this.d.broadcast("account.changed", { status: this.status() });
  }
}

/** "Wenjing's MacBook Pro.local" → "Wenjing's MacBook Pro". */
export function deviceName(hostname: string | undefined): string {
  const n = (hostname ?? "").replace(/\.local$/i, "").trim().slice(0, 100);
  return n || "Homerun desktop";
}
