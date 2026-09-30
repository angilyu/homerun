import type { AccountState } from "@homerun/core";
import { OidcClient, OidcError } from "@homerun/protocol";
import { log } from "../log";
import type { SecretStore } from "../secrets";
import type { ShellSecrets } from "../shell-secrets";
import { getSetting, putSetting } from "../store/schedule-rows";
import type { Store } from "../store/store";
import type { RemoteConfig } from "./config";
import { openLoopback, type Loopback } from "./loopback";

/**
 * The desktop's account (§10.4, §10.10): OpenID Connect Authorization Code with PKCE through the
 * system browser and a loopback redirect (RFC 8252). The shell opens the browser (`browser.open`);
 * the runtime holds the access token in memory only, and the refresh token in memory with the
 * shell keeping it in the Keychain or Credential Manager (`secrets.persist`, §5.2).
 *
 * Who is signed in (the provider's `sub` and email) is kept in the database, so the app can say
 * so before the token arrives from the shell and can tell when someone else signs in (their
 * pairings are then forgotten). Signing out keeps it: signing back in as the same person resumes.
 */

export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60 * 1000;
/** After the shell connects, how long to wait for it to hand over a stored refresh token. */
export const TOKEN_HANDOVER_MS = 10 * 1000;
const META_KEY = "remote.account";

interface Meta {
  sub: string;
  email: string | null;
}

export class SignedOutError extends Error {
  override name = "SignedOutError";
}

export interface AccountDeps {
  config: RemoteConfig | null;
  store: Store;
  secrets: SecretStore;
  shellSecrets: ShellSecrets;
  /** `browser.open` to the shell. */
  openBrowser: (url: string) => void;
  now: () => number;
  /** Someone else signed in on this desktop: forget what the previous account paired. */
  accountSwitched?: (from: string, to: string) => void;
  signInTimeoutMs?: number;
  /** See TOKEN_HANDOVER_MS. */
  handoverMs?: number;
  fetch?: typeof fetch;
}

export interface AccountView {
  state: AccountState;
  email: string | null;
  error: string | null;
}

export class RemoteAccount {
  private state: AccountState;
  private meta: Meta | null;
  private error: string | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private client: Promise<OidcClient> | null = null;
  private attempt: { cancel: () => void } | null = null;
  /** Bumped by every sign-in and sign-out, so a superseded attempt changes nothing. */
  private generation = 0;
  private handoverTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private offSecrets: () => void;

  constructor(private d: AccountDeps) {
    this.meta = getSetting<Meta>(d.store, META_KEY);
    this.state = !d.config ? "not_configured" : this.meta ? "signed_in" : "signed_out";
    this.offSecrets = d.secrets.onChange((name) => {
      if (name !== "refresh_token" || !d.secrets.has("refresh_token")) return;
      if (this.handoverTimer) clearTimeout(this.handoverTimer);
      this.handoverTimer = null;
      this.emit();
    });
  }

  get configured(): boolean {
    return this.d.config !== null;
  }

  /** The provider's subject: the account id in link statements and at the relay (§10.7). */
  get subject(): string | null {
    return this.state === "signed_in" ? (this.meta?.sub ?? null) : null;
  }

  /** Signed in with a refresh token to use: the relay link may run. */
  get usable(): boolean {
    return this.state === "signed_in" && this.d.secrets.has("refresh_token");
  }

  view(): AccountView {
    const showEmail = this.state === "signed_in" || this.state === "needs_sign_in";
    return { state: this.state, email: showEmail ? (this.meta?.email ?? null) : null, error: this.error };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * The shell connected. If we think we're signed in but it hands over no refresh token (the
   * Keychain item was removed), ask the user to sign in again.
   */
  shellConnected(): void {
    if (this.state !== "signed_in" || this.d.secrets.has("refresh_token") || this.handoverTimer) return;
    this.handoverTimer = setTimeout(() => {
      this.handoverTimer = null;
      if (this.state === "signed_in" && !this.d.secrets.has("refresh_token")) this.lose("Sign in again to keep using Homerun from other devices.");
    }, this.d.handoverMs ?? TOKEN_HANDOVER_MS);
  }

  // ---------------------------------------------------------------- sign-in

  /** Starts signing in; the outcome arrives as a change. Returns at once. */
  signIn(): void {
    if (!this.d.config) throw new SignedOutError("This build of Homerun has no account service.");
    if (this.state === "signing_in" || this.state === "signed_in") return;
    const before = this.state;
    const gen = ++this.generation;
    this.state = "signing_in";
    this.error = null;
    this.emit();
    void this.flow(before, gen);
  }

  cancelSignIn(): void {
    if (this.state !== "signing_in") return;
    this.attempt?.cancel();
  }

  private async flow(before: AccountState, gen: number): Promise<void> {
    let cancelled = false;
    let loopback: Loopback | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cancel = new Promise<never>((_, reject) => {
      const stop = (why: string) => {
        cancelled = true;
        reject(new SignedOutError(why));
      };
      timer = setTimeout(() => stop("Sign-in timed out. Try again."), this.d.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS);
      this.attempt = { cancel: () => stop("Sign-in was cancelled.") };
    });
    cancel.catch(() => {});
    try {
      const client = await Promise.race([this.oidc(), cancel]);
      loopback = openLoopback();
      const pending = await client.begin(loopback.redirectUri);
      const callback = loopback.callback(pending.state);
      this.d.openBrowser(pending.url);
      const url = await Promise.race([callback, cancel]);
      const tokens = await Promise.race([client.complete(pending, url), cancel]);
      if (cancelled || gen !== this.generation) return;
      const previous = this.meta?.sub;
      if (previous && previous !== tokens.subject) this.d.accountSwitched?.(previous, tokens.subject);
      this.meta = { sub: tokens.subject, email: tokens.email ?? null };
      putSetting(this.d.store, META_KEY, this.meta);
      this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
      if (tokens.refreshToken) this.d.shellSecrets.persist("refresh_token", tokens.refreshToken);
      else log.warn("the provider issued no refresh token; this sign-in lasts until the access token expires");
      this.state = "signed_in";
      this.error = null;
      log.info("signed in");
    } catch (e) {
      if (gen !== this.generation) return;
      this.state = before === "needs_sign_in" ? "needs_sign_in" : "signed_out";
      this.error = describe(e);
      log.info("sign-in didn't finish", { error: this.error });
    } finally {
      if (timer) clearTimeout(timer);
      loopback?.close();
      if (gen === this.generation) this.attempt = null;
    }
    this.emit();
  }

  // ---------------------------------------------------------------- tokens

  /** A valid access token, refreshed (one refresh at a time) when it is about to expire. */
  async accessToken(): Promise<string> {
    if (!this.usable && !this.access) throw new SignedOutError("signed out");
    const a = this.access;
    if (a && a.expiresAt - this.d.now() > REFRESH_MARGIN_MS) return a.token;
    return this.refresh();
  }

  /** A new access token even if the current one looks valid (the relay said it expired). */
  refresh(): Promise<string> {
    this.refreshing ??= (async () => {
      const rt = this.d.secrets.get("refresh_token");
      if (this.state !== "signed_in" || !rt) throw new SignedOutError("signed out");
      const client = await this.oidc();
      let t;
      try {
        t = await client.refresh(rt, this.meta ? { subject: this.meta.sub, email: this.meta.email ?? undefined } : undefined);
      } catch (e) {
        // Only a rejected token ends the sign-in; an unreachable provider is retried later.
        if (e instanceof OidcError && e.code === "invalid_grant") {
          if (this.d.secrets.get("refresh_token") === rt) this.lose("Sign in again to keep using Homerun from other devices.");
          throw new SignedOutError("the sign-in ended");
        }
        throw e;
      }
      this.access = { token: t.accessToken, expiresAt: t.expiresAt };
      if (t.refreshToken && t.refreshToken !== rt) this.d.shellSecrets.persist("refresh_token", t.refreshToken);
      if (t.email && this.meta && t.email !== this.meta.email) {
        this.meta = { ...this.meta, email: t.email };
        putSetting(this.d.store, META_KEY, this.meta);
        this.emit();
      }
      return t.accessToken;
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private lose(why: string): void {
    this.access = null;
    this.state = "needs_sign_in";
    this.error = why;
    if (this.d.secrets.has("refresh_token")) this.d.shellSecrets.delete("refresh_token");
    log.info("sign-in lost");
    this.emit();
  }

  // ---------------------------------------------------------------- sign-out

  /**
   * Revokes the refresh token at the provider when it can, and forgets it here and in the
   * Keychain. `forgetAccount` also drops who was signed in (account deletion).
   */
  async signOut(o: { forgetAccount?: boolean } = {}): Promise<void> {
    if (!this.d.config) return;
    this.generation++;
    this.attempt?.cancel();
    this.attempt = null;
    const rt = this.d.secrets.get("refresh_token");
    this.access = null;
    if (rt) this.d.shellSecrets.delete("refresh_token");
    if (o.forgetAccount) {
      this.meta = null;
      putSetting(this.d.store, META_KEY, null);
    }
    this.state = "signed_out";
    this.error = null;
    this.emit();
    if (rt) {
      try {
        const client = await this.oidc();
        await client.revoke(rt);
      } catch (e) {
        log.info("couldn't revoke the refresh token", { error: (e as Error).message });
      }
    }
  }

  stop(): void {
    this.offSecrets();
    if (this.handoverTimer) clearTimeout(this.handoverTimer);
    this.attempt?.cancel();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  private oidc(): Promise<OidcClient> {
    const c = this.d.config!;
    this.client ??= OidcClient.discover({
      issuer: c.issuer,
      clientId: c.clientId,
      allowInsecureLoopback: c.insecureLoopback,
      ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
    }).catch((e) => {
      this.client = null;
      throw e;
    });
    return this.client;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

function describe(e: unknown): string {
  if (e instanceof SignedOutError) return e.message;
  if (e instanceof OidcError) {
    if (e.code === "access_denied") return "Sign-in was declined.";
    return `Sign-in failed: ${e.message}`.slice(0, 500);
  }
  if (e instanceof TypeError) return "Couldn't reach the sign-in service. Check your connection and try again.";
  return `Sign-in failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
}
