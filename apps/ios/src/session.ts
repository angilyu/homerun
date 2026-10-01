import { deletedText, errorMessage, Store, type ApprovalSigner, type AppClient, type ThreadCache } from "@homerun/app-state";
import { decodePairingUrl, type LinkedDevice } from "@homerun/protocol";
import { LinkDeclinedError, PairingError, RemoteClient, RemoteSessions, SignedOutError, type DesktopView, type RelayTransport } from "@homerun/remote";
import { NativeKeys, NativeStore, NativeTokens } from "./adapters";
import { Attester } from "./attest";
import type { HistoryCache } from "./cache";
import type { IosConfig } from "./config";
import { nativeCode, type HomerunNative, type NativeSubscription, type NativeTap } from "./native";

/**
 * The iPhone app's session (§9.8): sign in in the system sheet (Swift owns the tokens), register
 * this phone as an `ios` device with App Attest, pair with a desktop by QR or link by code, open
 * the shared app state on the chosen desktop over the relay, keep its push token registered and
 * route notification taps. The views render `phase`; nothing here knows about React Native.
 */

export const REDIRECT_URI = "com.angilyu.homerun.ios:/auth/callback";
const CHOSEN = "chosen-desktop";

export interface IosEnv {
  native: HomerunNative;
  config: IosConfig;
  /** Shown on the desktop's paired-devices list ("Ada's iPhone"). */
  deviceName: string;
  cache: HistoryCache;
  fetch?: typeof fetch;
  reconnect?: { initialMs: number; maxMs: number };
}

/** What a shown desktop needs: its transport, its history cache and, where it takes this phone's Face ID, the approval signer. */
export interface OpenDesktop {
  transport: RelayTransport;
  desktopId: string;
  /** What the desktop takes this phone for: `web` unless it verified its App Attest attestation (§18 row 84). */
  role: "ios" | "web";
  cache: ThreadCache;
  signApproval?: ApprovalSigner;
}

export interface Shown {
  client: AppClient;
}

export type LinkStep =
  | { k: "choose"; error: string | null }
  | { k: "pairing" }
  | { k: "linking"; desktopId: string; name: string; code: string | null }
  | { k: "declined"; name: string };

export type Phase<A extends Shown> =
  | { s: "starting" }
  | { s: "signed_out"; notice: string | null; tone: "info" | "warn" }
  | { s: "signing_in" }
  | { s: "connecting" }
  /** Pairing or linking a desktop; `desktops` are the account's desktops not linked yet (null while loading). */
  | { s: "link"; desktops: LinkedDevice[] | null; step: LinkStep; notice: string | null }
  | { s: "pick" }
  | { s: "ready"; desktopId: string; app: A }
  | { s: "error"; message: string };

/** A thread or request a notification asked to open, on the shown desktop. */
export interface Focus {
  desktopId: string;
  threadId: string | null;
  requestId: string | null;
}

export class IosSession<A extends Shown> {
  readonly phase = new Store<Phase<A>>({ s: "starting" });
  /** The desktops this phone is paired with, with presence. */
  readonly desktops = new Store<DesktopView[]>([]);
  /** What a tapped notification asked to open; the views take it. */
  readonly focus = new Store<Focus | null>(null);
  readonly attester: Attester;
  private readonly tokens: NativeTokens;
  private readonly store: NativeStore;
  private client: RemoteClient | null = null;
  private sessions: RemoteSessions | null = null;
  private shown: { desktopId: string; app: A } | null = null;
  private offs: (() => void)[] = [];
  private subs: NativeSubscription[] = [];
  private pendingTap: NativeTap | null = null;
  /** Bumped on every change of course, so a late answer from an abandoned step is ignored. */
  private epoch = 0;
  private removed = false;
  private unlinking = false;

  constructor(
    private readonly env: IosEnv,
    private readonly open: (d: OpenDesktop) => A,
  ) {
    this.tokens = new NativeTokens(env.native);
    this.store = new NativeStore(env.native);
    this.attester = new Attester(env.native);
  }

  get email(): string | null {
    return this.tokens.email;
  }

  get deviceId(): string | null {
    return this.client?.deviceId ?? null;
  }

  /** Whether the shown desktop takes this phone's Face ID approvals. */
  role(desktopId: string): "ios" | "web" | null {
    return this.client?.role(desktopId) ?? null;
  }

  /** Boots the app: configuration, the saved sign-in, the push listeners. */
  async start(): Promise<void> {
    const n = this.env.native;
    this.subs.push(
      n.addListener("pushToken", (t) => void this.client?.registerPushToken(t.token, t.environment).catch(() => {})),
      n.addListener("pushTap", () => void this.takeTap()),
    );
    await this.boot();
  }

  private async boot(): Promise<void> {
    this.set({ s: "starting" });
    const epoch = ++this.epoch;
    try {
      const c = this.env.config;
      await this.env.native.configure(
        JSON.stringify({ relayUrl: c.relayUrl, issuer: c.issuer, clientId: c.clientId, redirectUri: REDIRECT_URI, authParams: c.authParams ?? {}, dev: c.dev }),
      );
      const account = await this.tokens.load();
      if (epoch !== this.epoch) return;
      if (!account) return this.set({ s: "signed_out", notice: null, tone: "info" });
      await this.connect(epoch);
    } catch (e) {
      if (epoch === this.epoch) this.fail(e);
    }
  }

  /** Signs in in the system's sheet (the identity provider offers Sign in with Apple). */
  async signIn(): Promise<void> {
    const epoch = ++this.epoch;
    this.set({ s: "signing_in" });
    try {
      const account = await this.tokens.signIn();
      if (epoch !== this.epoch) return;
      if (!account) return this.set({ s: "signed_out", notice: null, tone: "info" });
      await this.connect(epoch);
    } catch (e) {
      if (epoch !== this.epoch) return;
      this.set({ s: "signed_out", notice: `Sign-in didn’t finish: ${errorMessage(e)}`, tone: "warn" });
    }
  }

  /** Registers this phone (a new device after a different person signed in here) and connects. */
  private async connect(epoch: number, notice: string | null = null): Promise<void> {
    this.set({ s: "connecting" });
    const n = this.env.native;
    const subject = this.tokens.subject;
    if (subject) {
      const owner = await this.store.owner();
      if (owner !== null && owner !== subject) {
        await n.resetDevice();
        await this.env.cache.wipe();
      }
      await this.store.setOwner(subject);
    }
    const client = await RemoteClient.create({
      relayUrl: this.env.config.relayUrl,
      account: this.tokens,
      store: this.store,
      keys: new NativeKeys(n),
      kind: "ios",
      name: this.env.deviceName,
      browserWebSocket: true,
      attest: this.attester.attest,
      ...(this.env.fetch ? { fetch: this.env.fetch } : {}),
      ...(this.env.reconnect ? { reconnect: this.env.reconnect } : {}),
    });
    if (epoch !== this.epoch) return client.close();
    this.client = client;
    this.sessions = new RemoteSessions({ client, clientInfo: { name: "homerun-ios", version: this.env.config.version } });
    this.offs.push(
      client.onDesktops(() => this.desktopsChanged()),
      client.conn.onState((s) => this.connectionChanged(s)),
    );
    await client.register();
    await client.connect();
    if (epoch !== this.epoch) return;
    this.desktopsChanged();
    void this.registerPush(client);
    await this.route(notice);
    await this.takeTap();
  }

  /** Asks for notification permission once, then keeps the relay's copy of the APNs token current. */
  private async registerPush(client: RemoteClient): Promise<void> {
    const n = this.env.native;
    try {
      const last = await n.pushLastToken();
      if (last) await client.registerPushToken(last.token, last.environment);
      // A fresh token arrives as a `pushToken` event; a refusal leaves the app without pushes.
      await n.pushRegister();
    } catch {
      // the app works without pushes
    }
  }

  private connectionChanged(s: string): void {
    if (s === "replaced") {
      // Another install of this device took over its connection; leave it be.
      this.teardown();
      this.set({ s: "error", message: "This iPhone connected from somewhere else. Try again to take it back." });
    } else if (s === "removed" && !this.unlinking) {
      this.removed = true;
    } else if (s === "closed" && !this.tokens.signedIn) {
      this.teardown();
      this.set({ s: "signed_out", notice: "Your session ended. Sign in again.", tone: "warn" });
    }
  }

  private desktopsChanged(): void {
    const list = this.client?.desktops() ?? [];
    if (this.removed && list.length === 0) {
      this.removed = false;
      void this.forgetAll().then(() => this.renew("This iPhone was unpaired."));
      return;
    }
    const gone = this.desktops.get().filter((d) => !list.some((x) => x.device_id === d.device_id));
    for (const d of gone) void this.forgetDesktop(d.device_id);
    this.desktops.set(list);
    const shown = this.shown;
    if (shown && !list.some((d) => d.device_id === shown.desktopId)) {
      this.hide();
      void this.route();
    }
  }

  private async forgetDesktop(desktopId: string): Promise<void> {
    await this.attester.forget(desktopId).catch(() => {});
    await this.env.cache.forget(desktopId);
    if ((await this.env.native.kvGet(CHOSEN).catch(() => null)) === desktopId) await this.env.native.kvSet(CHOSEN, null).catch(() => {});
  }

  private async forgetAll(): Promise<void> {
    for (const d of this.desktops.get()) await this.forgetDesktop(d.device_id);
  }

  /** Starts again as a new device, still signed in. */
  private async renew(notice: string): Promise<void> {
    const epoch = ++this.epoch;
    this.teardown();
    try {
      await this.connect(epoch, notice);
    } catch (e) {
      if (epoch === this.epoch) this.fail(e);
    }
  }

  /** Opens the desktop chosen last, the only one, or asks; with none, pairs one. */
  private async route(notice: string | null = null): Promise<void> {
    const list = this.client?.desktops() ?? [];
    if (list.length === 0) return this.linkAnother(notice);
    const chosen = await this.env.native.kvGet(CHOSEN).catch(() => null);
    const pick = list.find((d) => d.device_id === chosen) ?? (list.length === 1 ? list[0] : undefined);
    if (pick) await this.show(pick.device_id);
    else this.set({ s: "pick" });
  }

  /** Shows a paired desktop. */
  async show(desktopId: string): Promise<void> {
    const client = this.client;
    const sessions = this.sessions;
    if (!client || !sessions) return;
    if (this.shown?.desktopId !== desktopId) {
      this.hide();
      const epoch = this.epoch;
      const transport = sessions.transport(desktopId);
      const role = client.role(desktopId) === "ios" ? "ios" : "web";
      const signApproval = await this.attester.signerFor(desktopId, client.deviceId, transport, role).catch(() => undefined);
      if (epoch !== this.epoch || this.client !== client) return;
      if (this.shown?.desktopId !== desktopId) {
        this.hide();
        const app = this.open({ transport, desktopId, role, cache: this.env.cache.forDesktop(desktopId), ...(signApproval ? { signApproval } : {}) });
        app.client.start();
        this.shown = { desktopId, app };
      }
    }
    await this.env.native.kvSet(CHOSEN, desktopId).catch(() => {});
    this.set({ s: "ready", desktopId, app: this.shown!.app });
  }

  private hide(): void {
    const shown = this.shown;
    this.shown = null;
    if (!shown) return;
    shown.app.client.stop();
    this.sessions?.release(shown.desktopId);
  }

  /** Back to the open desktop, from pairing another. */
  back(): void {
    ++this.epoch;
    if (this.shown) this.set({ s: "ready", desktopId: this.shown.desktopId, app: this.shown.app });
    else void this.route();
  }

  /** Starts pairing a desktop: lists the account's desktops this phone isn't paired with, for linking by code. */
  async linkAnother(notice: string | null = null): Promise<void> {
    const client = this.client;
    if (!client) return;
    const epoch = ++this.epoch;
    this.set({ s: "link", desktops: null, step: { k: "choose", error: null }, notice });
    try {
      const linked = new Set(client.desktops().map((d) => d.device_id as string));
      const all = await client.accountDevices();
      if (epoch !== this.epoch) return;
      this.set({ s: "link", desktops: all.filter((d) => d.kind === "desktop" && !linked.has(d.device_id)), step: { k: "choose", error: null }, notice });
    } catch (e) {
      if (epoch === this.epoch) this.set({ s: "link", desktops: [], step: { k: "choose", error: errorMessage(e) }, notice });
    }
  }

  /** Pairs with the desktop whose QR code the camera read (§9.6). */
  async pair(qrUrl: string): Promise<void> {
    const client = this.client;
    const p = this.phase.get();
    if (!client || p.s !== "link") return;
    const qr = decodePairingUrl(qrUrl);
    const epoch = ++this.epoch;
    const step = (s: LinkStep) => epoch === this.epoch && this.set({ ...p, step: s, notice: null });
    if (!qr) return void step({ k: "choose", error: "That isn’t a Homerun pairing code." });
    step({ k: "pairing" });
    try {
      const desk = await this.attester.pairing(
        () => qr.device_id,
        () => client.pair(qrUrl),
      );
      if (epoch === this.epoch) await this.show(desk.device_id);
    } catch (e) {
      step({ k: "choose", error: e instanceof PairingError ? e.message : `Pairing didn’t finish: ${errorMessage(e)}` });
    }
  }

  /**
   * Links with a desktop by matching codes (§10.5): this phone shows six digits, the desktop
   * shows its own in a native prompt, and the person approves there.
   */
  async link(desktop: Pick<LinkedDevice, "device_id" | "name">): Promise<void> {
    const client = this.client;
    const p = this.phase.get();
    if (!client || p.s !== "link") return;
    const epoch = ++this.epoch;
    const step = (s: LinkStep) => epoch === this.epoch && this.set({ ...p, step: s, notice: null });
    step({ k: "linking", desktopId: desktop.device_id, name: desktop.name, code: null });
    try {
      await this.attester.pairing(
        () => desktop.device_id,
        () => client.linkByCode(desktop.device_id, (code) => step({ k: "linking", desktopId: desktop.device_id, name: desktop.name, code })),
      );
      if (epoch === this.epoch) await this.show(desktop.device_id);
    } catch (e) {
      if (e instanceof LinkDeclinedError) step({ k: "declined", name: desktop.name });
      else step({ k: "choose", error: errorMessage(e) });
    }
  }

  /** Stops waiting for a pairing or link (the desktop's prompt times out by itself). */
  cancelLink(): void {
    const p = this.phase.get();
    if (p.s !== "link") return;
    ++this.epoch;
    this.set({ ...p, step: { k: "choose", error: null } });
  }

  /** Unpairs a desktop. The last one unpaired, the relay forgets this phone, and it starts afresh. */
  async unlink(desktopId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    const last = client.desktops().length <= 1;
    if (this.shown?.desktopId === desktopId) this.hide();
    this.unlinking = last;
    try {
      await client.unpair(desktopId);
    } finally {
      this.unlinking = false;
    }
    await this.forgetDesktop(desktopId);
    if (last) return this.renew("This iPhone was unpaired.");
    this.desktopsChanged();
    await this.route();
  }

  /** Opens what a tapped notification points at: its desktop, then its thread or request. */
  private async takeTap(): Promise<void> {
    const tap = (await this.env.native.takeTap().catch(() => null)) ?? this.pendingTap;
    this.pendingTap = null;
    if (!tap?.desktop) return;
    const client = this.client;
    if (!client || this.phase.get().s === "connecting") {
      this.pendingTap = tap;
      return;
    }
    if (!client.desktops().some((d) => d.device_id === tap.desktop)) return;
    await this.show(tap.desktop);
    this.focus.set({ desktopId: tap.desktop, threadId: tap.thread ?? null, requestId: tap.request ?? null });
  }

  /** The app left the foreground: close the history cache file, so it is unreadable once the phone locks. */
  async background(): Promise<void> {
    await this.env.cache.close();
  }

  /** Signs out. The phone stays paired and stops getting pushes; the same person signing in again picks up where they were. */
  async signOut(): Promise<void> {
    ++this.epoch;
    const client = this.client;
    if (client) await client.removePushToken().catch(() => {});
    this.teardown();
    await this.tokens.signOut();
    await this.env.cache.close();
    this.set({ s: "signed_out", notice: null, tone: "info" });
  }

  /** Deletes the account everywhere (§10.9); this phone forgets its keys, its sign-in and its history. */
  async deleteAccount(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const provider = await client.deleteAccount();
    ++this.epoch;
    this.teardown();
    await this.env.cache.wipe();
    await this.env.native.wipe().catch(() => {});
    this.set({ s: "signed_out", notice: deletedText(provider), tone: provider === "deleted" ? "info" : "warn" });
  }

  /** Tries again after an error. */
  retry(): void {
    this.teardown();
    void this.boot();
  }

  /** Closes everything (tests; the app itself lives until the system ends it). */
  close(): void {
    ++this.epoch;
    this.teardown();
    for (const s of this.subs.splice(0)) s.remove();
  }

  private teardown(): void {
    this.hide();
    for (const off of this.offs.splice(0)) off();
    this.sessions?.closeAll();
    this.sessions = null;
    this.client?.close();
    this.client = null;
    this.removed = false;
    this.desktops.set([]);
  }

  private fail(e: unknown): void {
    if (e instanceof SignedOutError || nativeCode(e) === "SIGNED_OUT") return this.set({ s: "signed_out", notice: "Your session ended. Sign in again.", tone: "warn" });
    this.set({ s: "error", message: errorMessage(e) });
  }

  private set(p: Phase<A>): void {
    this.phase.set(p);
  }
}
