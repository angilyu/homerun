import { deletedText, errorMessage, Store, type AppClient } from "@homerun/app-state";
import { OidcError, type LinkedDevice, type PendingAuthorization } from "@homerun/protocol";
import {
  Account,
  LinkDeclinedError,
  RemoteClient,
  RemoteSessions,
  SignedOutError,
  supportsWebCryptoKeys,
  WebCryptoKeys,
  type DesktopView,
  type RelayTransport,
} from "@homerun/remote";
import type { WebConfig } from "./config";
import { deviceName } from "./device-name";
import { KvKeyDb, KvStore, TokenVault, type Kv } from "./storage";

/**
 * The web client's session (§9.9): sign in with a redirect (OIDC code flow with PKCE), resume
 * from the saved refresh token, register this browser as a `web` device, link it to a desktop
 * by code, and open the shared app on the chosen desktop over the relay. One tab at a time:
 * tabs would share one device, and the relay keeps one connection per device.
 */

export const CALLBACK_PATH = "/auth/callback";
const PENDING = "homerun.pending-sign-in";
const CHOSEN = "homerun.desktop";

/** What the page needs from the browser; a stand-in in unit tests. */
export interface WebEnv {
  config: WebConfig;
  kv: Kv;
  origin: string;
  /** The page's current URL. */
  href(): string;
  /** Replaces the URL without loading it (after the sign-in callback). */
  replaceUrl(path: string): void;
  /** Leaves the page for the identity provider. */
  navigate(url: string): void;
  /** Per-tab storage: holds the sign-in's PKCE verifier only until the callback. */
  session: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** Which desktop was open last. */
  local: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  userAgent: string;
  /** Web Locks, for one tab at a time; null where there are none (unit tests). */
  locks: LockManager | null;
  supported(): Promise<boolean>;
  fetch?: typeof fetch;
}

/** Something that shows a desktop: the app the views render, over one transport. */
export interface Shown {
  client: AppClient;
}

export type LinkStep =
  | { k: "choose"; error: string | null }
  | { k: "linking"; desktopId: string; name: string; code: string | null }
  | { k: "declined"; name: string };

export type Phase<A extends Shown> =
  | { s: "starting" }
  | { s: "unsupported" }
  | { s: "elsewhere" }
  | { s: "signed_out"; notice: string | null; tone: "info" | "warn" }
  | { s: "redirecting" }
  | { s: "connecting" }
  /** Linking this browser to a desktop; `desktops` are the account's desktops not linked yet (null while loading). */
  | { s: "link"; desktops: LinkedDevice[] | null; step: LinkStep; notice: string | null }
  | { s: "pick" }
  | { s: "ready"; desktopId: string; app: A }
  | { s: "error"; message: string };

export class WebSession<A extends Shown> {
  readonly phase = new Store<Phase<A>>({ s: "starting" });
  /** The desktops this browser is linked with, with presence. */
  readonly desktops = new Store<DesktopView[]>([]);
  private account: Account | null = null;
  private client: RemoteClient | null = null;
  private sessions: RemoteSessions | null = null;
  private shown: { desktopId: string; app: A } | null = null;
  private offs: (() => void)[] = [];
  private releaseLock: (() => void) | null = null;
  private readonly vault: TokenVault;
  private readonly store: KvStore;
  private readonly keyDb: KvKeyDb;
  /** Bumped on every change of course, so a late answer from an abandoned step is ignored. */
  private epoch = 0;
  /** The relay removed this device; the client is still forgetting its keys. */
  private removed = false;
  private unlinking = false;

  constructor(
    private readonly env: WebEnv,
    private readonly open: (transport: RelayTransport, desktopId: string) => A,
  ) {
    this.vault = new TokenVault(env.kv);
    this.store = new KvStore(env.kv);
    this.keyDb = new KvKeyDb(env.kv);
  }

  get email(): string | null {
    return this.account?.email ?? null;
  }

  get deviceId(): string | null {
    return this.client?.deviceId ?? null;
  }

  /** Boots the page: support check, this tab's lock, the sign-in callback or a saved session. */
  async start(): Promise<void> {
    if (!(await this.env.supported())) return this.set({ s: "unsupported" });
    if (!(await this.lock(false))) return this.set({ s: "elsewhere" });
    await this.boot();
  }

  /** Takes over from another tab, which then says it was opened elsewhere. */
  async useHere(): Promise<void> {
    await this.lock(true);
    await this.boot();
  }

  private async lock(steal: boolean): Promise<boolean> {
    const locks = this.env.locks;
    if (!locks) return true;
    return new Promise<boolean>((resolve) => {
      const held = locks.request("homerun-tab", steal ? { steal: true } : { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        return new Promise<void>((release) => (this.releaseLock = release));
      });
      // Stolen by another tab: let it have the device.
      held.catch(() => {
        this.releaseLock = null;
        this.teardown();
        this.set({ s: "elsewhere" });
      });
    });
  }

  private async boot(): Promise<void> {
    this.set({ s: "starting" });
    const epoch = ++this.epoch;
    try {
      const account = await this.newAccount();
      if (epoch !== this.epoch) return;
      const url = new URL(this.env.href());
      if (url.pathname === CALLBACK_PATH) {
        const raw = this.env.session.getItem(PENDING);
        this.env.session.removeItem(PENDING);
        this.env.replaceUrl("/");
        if (!raw) return this.set({ s: "signed_out", notice: "That sign-in had expired. Sign in again.", tone: "warn" });
        try {
          await account.completeRedirect(JSON.parse(raw) as PendingAuthorization, url);
        } catch (e) {
          return this.set({ s: "signed_out", notice: `Sign-in didn’t finish: ${errorMessage(e)}`, tone: "warn" });
        }
      } else {
        const saved = await this.vault.load();
        if (!saved) return this.set({ s: "signed_out", notice: null, tone: "info" });
        try {
          await account.resume(saved.refreshToken, saved.subject ?? undefined);
        } catch (e) {
          if (e instanceof OidcError && e.code === "invalid_grant") {
            await this.vault.clear();
            return this.set({ s: "signed_out", notice: "Your session ended. Sign in again.", tone: "warn" });
          }
          throw e;
        }
      }
      if (epoch !== this.epoch) return;
      this.account = account;
      await this.connect(epoch);
    } catch (e) {
      if (epoch === this.epoch) this.set({ s: "error", message: errorMessage(e) });
    }
  }

  private newAccount(): Promise<Account> {
    const c = this.env.config;
    let account: Account | null = null;
    const created = Account.create({
      issuer: c.issuer,
      clientId: c.clientId,
      redirectUri: this.env.origin + CALLBACK_PATH,
      ...(c.authParams ? { authParams: c.authParams } : {}),
      allowInsecureLoopback: c.dev,
      ...(this.env.fetch ? { fetch: this.env.fetch } : {}),
      onRefreshToken: (token) => (token ? this.vault.save({ refreshToken: token, subject: account?.subject ?? null }) : this.vault.clear()),
    });
    return created.then((a) => (account = a));
  }

  /** Registers this browser (a new device after a different person signed in here) and connects. */
  private async connect(epoch: number, notice: string | null = null): Promise<void> {
    this.set({ s: "connecting" });
    const account = this.account!;
    const subject = account.subject;
    if (subject) {
      const owner = await this.store.owner();
      if (owner !== null && owner !== subject) {
        await this.store.clear();
        await this.keyDb.clear();
        this.env.local.removeItem(CHOSEN);
      }
      await this.store.setOwner(subject);
    }
    const client = await RemoteClient.create({
      relayUrl: this.env.config.relayUrl,
      account,
      store: this.store,
      keys: new WebCryptoKeys(this.keyDb),
      kind: "web",
      name: deviceName(this.env.userAgent),
      ...(this.env.fetch ? { fetch: this.env.fetch } : {}),
    });
    if (epoch !== this.epoch) return client.close();
    this.client = client;
    this.sessions = new RemoteSessions({ client, clientInfo: { name: "homerun-web", version: this.env.config.version } });
    this.offs.push(
      client.onDesktops(() => this.desktopsChanged()),
      client.conn.onState((s) => this.connectionChanged(s)),
    );
    await client.register();
    await client.connect();
    if (epoch !== this.epoch) return;
    this.desktopsChanged();
    await this.route(notice);
  }

  private connectionChanged(s: string): void {
    if (s === "replaced") {
      this.teardown();
      this.set({ s: "elsewhere" });
    } else if (s === "removed" && !this.unlinking) {
      // Unlinked by its last desktop: the client forgets its keys, then says its desktops changed.
      this.removed = true;
    } else if (s === "closed" && this.account && !this.account.signedIn) {
      this.teardown();
      this.set({ s: "signed_out", notice: "Your session ended. Sign in again.", tone: "warn" });
    }
  }

  private desktopsChanged(): void {
    const list = this.client?.desktops() ?? [];
    if (this.removed && list.length === 0) {
      this.removed = false;
      void this.renew("This browser was unlinked.");
      return;
    }
    this.desktops.set(list);
    const shown = this.shown;
    if (shown && !list.some((d) => d.device_id === shown.desktopId)) {
      this.hide();
      void this.route();
    }
  }

  /** Starts again as a new device, still signed in. */
  private async renew(notice: string): Promise<void> {
    const epoch = ++this.epoch;
    this.teardown(false);
    try {
      await this.connect(epoch, notice);
    } catch (e) {
      if (epoch === this.epoch) this.set({ s: "error", message: errorMessage(e) });
    }
  }

  /** Opens the desktop chosen last, the only one, or asks; with none, links one. */
  private async route(notice: string | null = null): Promise<void> {
    const list = this.client?.desktops() ?? [];
    if (list.length === 0) return this.linkAnother(notice);
    const chosen = this.env.local.getItem(CHOSEN);
    const pick = list.find((d) => d.device_id === chosen) ?? (list.length === 1 ? list[0] : undefined);
    if (pick) this.show(pick.device_id);
    else this.set({ s: "pick" });
  }

  /** Shows a linked desktop. */
  show(desktopId: string): void {
    if (!this.sessions) return;
    if (this.shown?.desktopId !== desktopId) {
      this.hide();
      const app = this.open(this.sessions.transport(desktopId), desktopId);
      app.client.start();
      this.shown = { desktopId, app };
    }
    this.env.local.setItem(CHOSEN, desktopId);
    this.set({ s: "ready", desktopId, app: this.shown!.app });
  }

  private hide(): void {
    const shown = this.shown;
    this.shown = null;
    if (!shown) return;
    shown.app.client.stop();
    this.sessions?.release(shown.desktopId);
  }

  /** Back to the open desktop, from linking another. */
  back(): void {
    if (this.shown) this.set({ s: "ready", desktopId: this.shown.desktopId, app: this.shown.app });
    else void this.route();
  }

  /** Starts linking a desktop: lists the account's desktops this browser isn't linked with. */
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

  /**
   * Links with a desktop by matching codes (§10.5): this page shows six digits, the desktop
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
      await client.linkByCode(desktop.device_id, (code) => step({ k: "linking", desktopId: desktop.device_id, name: desktop.name, code }));
      if (epoch === this.epoch) this.show(desktop.device_id);
    } catch (e) {
      if (e instanceof LinkDeclinedError) step({ k: "declined", name: desktop.name });
      else step({ k: "choose", error: errorMessage(e) });
    }
  }

  /** Stops waiting for a link (the desktop's prompt times out by itself). */
  cancelLink(): void {
    const p = this.phase.get();
    if (p.s !== "link") return;
    ++this.epoch;
    this.set({ ...p, step: { k: "choose", error: null } });
  }

  /** Unlinks a desktop. The last one unlinked, the relay forgets this browser, and it starts afresh. */
  async unlink(desktopId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    const last = client.desktops().length <= 1;
    if (this.shown?.desktopId === desktopId) this.hide();
    if (this.env.local.getItem(CHOSEN) === desktopId) this.env.local.removeItem(CHOSEN);
    this.unlinking = last;
    try {
      await client.unpair(desktopId);
    } finally {
      this.unlinking = false;
    }
    // The last one: the relay forgot this device and the client its keys.
    if (last) return this.renew("This browser was unlinked.");
    this.desktopsChanged();
    await this.route();
  }

  async signIn(): Promise<void> {
    const epoch = ++this.epoch;
    this.set({ s: "redirecting" });
    try {
      const account = this.account ?? (await this.newAccount());
      const pending = await account.beginRedirect();
      if (epoch !== this.epoch) return;
      this.env.session.setItem(PENDING, JSON.stringify(pending));
      this.env.navigate(pending.url);
    } catch (e) {
      if (epoch === this.epoch) this.set({ s: "signed_out", notice: `Couldn’t start signing in: ${errorMessage(e)}`, tone: "warn" });
    }
  }

  /** Signs out. This browser stays linked, and reconnects when the same person signs in again. */
  async signOut(): Promise<void> {
    ++this.epoch;
    const account = this.account;
    this.teardown();
    if (account) await account.signOut();
    else await this.vault.clear();
    this.set({ s: "signed_out", notice: null, tone: "info" });
  }

  /** Deletes the account everywhere (§10.9); this browser forgets its keys and links. */
  async deleteAccount(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const provider = await client.deleteAccount();
    ++this.epoch;
    this.teardown();
    await this.vault.clear();
    this.env.local.removeItem(CHOSEN);
    this.set({ s: "signed_out", notice: deletedText(provider), tone: provider === "deleted" ? "info" : "warn" });
  }

  /** Tries again after an error. */
  retry(): void {
    this.teardown();
    void this.boot();
  }

  /** Closes everything; the page is going away. */
  close(): void {
    ++this.epoch;
    this.teardown();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  private teardown(dropAccount = true): void {
    this.hide();
    for (const off of this.offs.splice(0)) off();
    this.sessions?.closeAll();
    this.sessions = null;
    this.client?.close();
    this.client = null;
    this.removed = false;
    this.desktops.set([]);
    if (dropAccount) this.account = null;
  }

  private set(p: Phase<A>): void {
    this.phase.set(p);
  }
}

/** The browser this page runs in, as the session needs it. */
export function browserEnv(config: WebConfig, kv: Kv): WebEnv {
  return {
    config,
    kv,
    origin: location.origin,
    href: () => location.href,
    replaceUrl: (path) => history.replaceState(null, "", path),
    navigate: (url) => location.assign(url),
    session: sessionStorage,
    local: localStorage,
    userAgent: navigator.userAgent,
    locks: navigator.locks ?? null,
    supported: async () => typeof indexedDB !== "undefined" && !!navigator.locks && typeof WebSocket !== "undefined" && (await supportsWebCryptoKeys()),
  };
}

export { SignedOutError };
