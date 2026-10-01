import { OidcClient, type OidcConfig, OidcError, type OidcTokens, type PendingAuthorization } from "@homerun/protocol";

/**
 * The signed-in account (§10.4): OIDC Authorization Code with PKCE through a browser the app
 * supplies (a system browser sheet on iOS, a redirect on the web, a scripted one in tests).
 * Access tokens are refreshed shortly before they expire, one refresh at a time; a rotated
 * refresh token replaces the old one and is handed to `onRefreshToken` to persist.
 */

export type Browser = (authorizeUrl: string) => Promise<URL>;

/** What a `RemoteClient` needs from the account: an access token for the relay, and sign-out. */
export interface TokenSource {
  readonly subject: string | null;
  accessToken(): Promise<string>;
  refresh(): Promise<{ accessToken: string }>;
  signOut(): Promise<void>;
}

export interface AccountOptions extends OidcConfig {
  redirectUri: string;
  /** Opens the authorization page and resolves with the callback URL. A page that redirects away uses `beginRedirect` instead. */
  browser?: Browser;
  /** Called with every new refresh token, and with null on sign-out. */
  onRefreshToken?: (token: string | null) => void | Promise<void>;
  /** Refresh this long before expiry. */
  refreshMarginMs?: number;
  now?: () => number;
}

export class SignedOutError extends Error {
  override name = "SignedOutError";
}

export class Account implements TokenSource {
  private tokens: OidcTokens | null = null;
  private refreshing: Promise<OidcTokens> | null = null;

  private constructor(
    private readonly o: AccountOptions,
    private readonly client: OidcClient,
  ) {}

  static async create(o: AccountOptions): Promise<Account> {
    return new Account(o, await OidcClient.discover(o));
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  get subject(): string | null {
    return this.tokens?.subject ?? null;
  }
  get email(): string | null {
    return this.tokens?.email ?? null;
  }
  get signedIn(): boolean {
    return this.tokens !== null;
  }

  async signIn(): Promise<void> {
    if (!this.o.browser) throw new Error("no browser: use beginRedirect");
    const pending = await this.beginRedirect();
    await this.completeRedirect(pending, await this.o.browser(pending.url));
  }

  /**
   * The first half of a sign-in that leaves the page (§9.9): go to `url`, and keep the rest
   * (the PKCE verifier, state and nonce) where only this tab can read it until the callback.
   */
  beginRedirect(): Promise<PendingAuthorization> {
    return this.client.begin(this.o.redirectUri);
  }

  /** The second half: checks the callback against what `beginRedirect` kept and redeems the code. */
  async completeRedirect(pending: PendingAuthorization, callback: URL): Promise<void> {
    this.tokens = await this.client.complete(pending, callback);
    await this.o.onRefreshToken?.(this.tokens.refreshToken ?? null);
  }

  /** Signs in from a stored refresh token (no browser). */
  async resume(refreshToken: string, subject?: string): Promise<void> {
    const t = await this.client.refresh(refreshToken, subject ? { subject, email: undefined } : undefined);
    this.tokens = { ...t, refreshToken: t.refreshToken ?? refreshToken };
    if (t.refreshToken) await this.o.onRefreshToken?.(t.refreshToken);
  }

  /** A valid access token, refreshed if it is about to expire. */
  async accessToken(): Promise<string> {
    const t = this.tokens;
    if (!t) throw new SignedOutError("signed out");
    if (t.expiresAt - this.now() > (this.o.refreshMarginMs ?? 60_000)) return t.accessToken;
    return (await this.refresh()).accessToken;
  }

  get accessTokenExpiresAt(): number | null {
    return this.tokens?.expiresAt ?? null;
  }

  /** Forces a refresh (after the relay said the token expired). */
  refresh(): Promise<OidcTokens> {
    this.refreshing ??= (async () => {
      const t = this.tokens;
      if (!t?.refreshToken) throw new SignedOutError("no refresh token");
      try {
        const next = await this.client.refresh(t.refreshToken, t);
        this.tokens = { ...next, refreshToken: next.refreshToken ?? t.refreshToken };
        if (next.refreshToken) await this.o.onRefreshToken?.(next.refreshToken);
        return this.tokens;
      } catch (e) {
        if (e instanceof OidcError && e.code === "invalid_grant") {
          this.tokens = null;
          await this.o.onRefreshToken?.(null);
          throw new SignedOutError("the session ended; sign in again");
        }
        throw e;
      }
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async signOut(): Promise<void> {
    const rt = this.tokens?.refreshToken;
    this.tokens = null;
    await this.o.onRefreshToken?.(null);
    if (rt) await this.client.revoke(rt).catch(() => {});
  }
}
