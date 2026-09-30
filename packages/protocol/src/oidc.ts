import * as oauth from "oauth4webapi";

/**
 * Sign-in (§10.3, §10.4): standard OpenID Connect only — Authorization Code with PKCE (S256),
 * `state` and `nonce`, refresh-token rotation and revocation — so the provider (WorkOS AuthKit)
 * stays swappable. A thin layer over oauth4webapi, shared by the runtime and the reference client.
 * Uses only Web-standard APIs (fetch, URL, WebCrypto).
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
  scope?: string;
  /** Extra authorization parameters a provider needs (e.g. WorkOS's `provider=authkit`). */
  authParams?: Record<string, string>;
  /** Plain http, for a local test issuer on 127.0.0.1 or localhost only. */
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
}

export interface OidcTokens {
  accessToken: string;
  /** Absent when the provider didn't rotate it; keep the old one then. */
  refreshToken: string | undefined;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  subject: string;
  email: string | undefined;
}

export interface PendingAuthorization {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
}

export class OidcError extends Error {
  override name = "OidcError";
  constructor(
    message: string,
    /** `invalid_grant` means the refresh token is dead: sign in again. */
    readonly code?: string,
  ) {
    super(message);
  }
}

const isLoopback = (u: URL) => u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";

export class OidcClient {
  private constructor(
    private readonly cfg: OidcConfig,
    private readonly as: oauth.AuthorizationServer,
    private readonly client: oauth.Client,
  ) {}

  static async discover(cfg: OidcConfig): Promise<OidcClient> {
    const issuer = new URL(cfg.issuer);
    if (issuer.protocol !== "https:" && !(cfg.allowInsecureLoopback && isLoopback(issuer))) {
      throw new OidcError("the issuer must use https");
    }
    const res = await oauth.discoveryRequest(issuer, { algorithm: "oidc", ...OidcClient.opts(cfg) });
    const as = await oauth.processDiscoveryResponse(issuer, res);
    return new OidcClient(cfg, as, { client_id: cfg.clientId });
  }

  private static opts(cfg: OidcConfig) {
    const o: Record<symbol, unknown> = {};
    if (cfg.allowInsecureLoopback && isLoopback(new URL(cfg.issuer))) o[oauth.allowInsecureRequests] = true;
    if (cfg.fetch) o[oauth.customFetch] = cfg.fetch;
    return o;
  }

  get issuer(): string {
    return this.as.issuer;
  }

  get revocable(): boolean {
    return typeof this.as.revocation_endpoint === "string";
  }

  async begin(redirectUri: string): Promise<PendingAuthorization> {
    if (!this.as.authorization_endpoint) throw new OidcError("the issuer has no authorization endpoint");
    const verifier = oauth.generateRandomCodeVerifier();
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const url = new URL(this.as.authorization_endpoint);
    const p = url.searchParams;
    p.set("client_id", this.cfg.clientId);
    p.set("redirect_uri", redirectUri);
    p.set("response_type", "code");
    p.set("scope", this.cfg.scope ?? "openid email offline_access");
    p.set("code_challenge", await oauth.calculatePKCECodeChallenge(verifier));
    p.set("code_challenge_method", "S256");
    p.set("state", state);
    p.set("nonce", nonce);
    for (const [k, v] of Object.entries(this.cfg.authParams ?? {})) p.set(k, v);
    return { url: url.href, state, nonce, verifier, redirectUri };
  }

  /** Completes sign-in from the redirect the browser delivered. */
  async complete(pending: PendingAuthorization, callback: URL): Promise<OidcTokens> {
    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(this.as, this.client, callback, pending.state);
    } catch (e) {
      throw wrap(e);
    }
    try {
      const res = await oauth.authorizationCodeGrantRequest(
        this.as,
        this.client,
        oauth.None(),
        params,
        pending.redirectUri,
        pending.verifier,
        OidcClient.opts(this.cfg),
      );
      const r = await oauth.processAuthorizationCodeResponse(this.as, this.client, res, {
        expectedNonce: pending.nonce,
        requireIdToken: true,
      });
      return tokens(r, undefined);
    } catch (e) {
      throw wrap(e);
    }
  }

  async refresh(refreshToken: string, previous?: Pick<OidcTokens, "subject" | "email">): Promise<OidcTokens> {
    try {
      const res = await oauth.refreshTokenGrantRequest(this.as, this.client, oauth.None(), refreshToken, OidcClient.opts(this.cfg));
      const r = await oauth.processRefreshTokenResponse(this.as, this.client, res);
      return tokens(r, previous);
    } catch (e) {
      throw wrap(e);
    }
  }

  async revoke(refreshToken: string): Promise<void> {
    if (!this.revocable) return;
    try {
      const res = await oauth.revocationRequest(this.as, this.client, oauth.None(), refreshToken, {
        ...OidcClient.opts(this.cfg),
        additionalParameters: { token_type_hint: "refresh_token" },
      });
      await oauth.processRevocationResponse(res);
    } catch (e) {
      throw wrap(e);
    }
  }
}

function tokens(r: oauth.TokenEndpointResponse, previous: Pick<OidcTokens, "subject" | "email"> | undefined): OidcTokens {
  const claims = oauth.getValidatedIdTokenClaims(r);
  const subject = claims?.sub ?? previous?.subject ?? subjectOf(r.access_token);
  if (!subject) throw new OidcError("no subject in the tokens");
  if (previous && subject !== previous.subject) throw new OidcError("the refreshed tokens are for a different account");
  const email = typeof claims?.email === "string" ? claims.email : previous?.email;
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: Date.now() + (r.expires_in ?? 300) * 1000,
    subject,
    email,
  };
}

/** The `sub` of a JWT access token, unverified (only to fill a gap; the relay verifies it). */
function subjectOf(jwt: string): string | undefined {
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: unknown };
    return typeof json.sub === "string" ? json.sub : undefined;
  } catch {
    return undefined;
  }
}

function wrap(e: unknown): OidcError {
  if (e instanceof OidcError) return e;
  if (e instanceof oauth.ResponseBodyError) return new OidcError(e.error_description ?? e.error, e.error);
  if (e instanceof oauth.AuthorizationResponseError) return new OidcError(e.error_description ?? e.error, e.error);
  return new OidcError(e instanceof Error ? e.message : String(e));
}
