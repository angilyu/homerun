import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { json, serve, type RunningServer } from "./http";

/**
 * A local OpenID Connect issuer we control, standing in for WorkOS AuthKit in every test (§18).
 * Standard endpoints only: discovery, JWKS, authorize (consent is scripted, not clicked), token
 * (authorization code with PKCE S256; refresh with rotation and reuse detection) and revocation.
 * Tokens are RS256 JWTs signed with keys generated per run. Switches make it fail on demand.
 */

export interface IssuerUser {
  sub: string;
  email?: string;
}

export interface IssuerOptions {
  clientId?: string;
  /** Redirect URIs the client registered. Loopback URIs match on any port (RFC 8252 §7.3). */
  redirectUris?: string[];
  /** When set, access tokens carry this `aud`; they always carry `client_id`. */
  audience?: string;
  accessTtlSec?: number;
  /** Rotate refresh tokens on use (the default, as WorkOS does). */
  rotateRefresh?: boolean;
  user?: IssuerUser;
  port?: number;
  /**
   * Browser origins allowed to call discovery, JWKS, token and revocation (CORS), as a provider
   * allows a public web client's registered origin. Exact matches; none by default.
   */
  corsOrigins?: string[];
}

interface Key {
  kid: string;
  privateKey: CryptoKey;
  jwk: JWK;
}

interface Family {
  user: IssuerUser;
  revoked: boolean;
  sid: string;
}

interface CodeGrant {
  user: IssuerUser;
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | undefined;
  expiresAt: number;
}

export interface MintOptions {
  sub?: string;
  email?: string;
  ttlSec?: number;
  /** Seconds added to "now" for iat/exp (negative makes an already-expired token). */
  skewSec?: number;
  iss?: string;
  aud?: string | null;
  clientId?: string | null;
  /** Sign with a key that is not in the JWKS. */
  foreignKey?: boolean;
  alg?: "RS256" | "ES256";
  kid?: string;
  extra?: Record<string, unknown>;
}

export type Consent = { user: IssuerUser } | "deny";

export class OidcIssuer {
  readonly clientId: string;
  readonly redirectUris: string[];
  readonly corsOrigins: string[];
  audience: string | undefined;
  accessTtlSec: number;
  rotateRefresh: boolean;
  /** Who "signs in" at the authorize endpoint next, or "deny" to refuse consent. */
  consent: Consent;
  /** Every endpoint returns 503 while true. */
  down = false;
  /** The next token response fails with this OAuth error (then clears). */
  failNextToken: { status: number; error: string } | null = null;
  readonly stats = { authorize: 0, codeGrants: 0, refreshes: 0, revocations: 0, jwks: 0, reuseDetected: 0, adminDeletes: 0 };
  /**
   * The management API's key (WorkOS's `sk_...`): `DELETE /user_management/users/{id}` with it
   * deletes a user, as the relay does when the account is deleted (§10.9). Test-only.
   */
  readonly adminKey = `sk_test_${randomToken()}`;
  /** Users deleted through the management API. */
  readonly deletedUsers = new Set<string>();
  /** The next management API calls fail with these statuses, in order. */
  failAdmin: number[] = [];

  private keys: Key[] = [];
  private foreign: Key | null = null;
  private codes = new Map<string, CodeGrant>();
  private refresh = new Map<string, { family: Family; used: boolean }>();
  private server: RunningServer | null = null;

  private constructor(o: IssuerOptions) {
    this.clientId = o.clientId ?? "client_homerun_test";
    this.redirectUris = o.redirectUris ?? ["http://127.0.0.1/callback"];
    this.corsOrigins = o.corsOrigins ?? [];
    this.audience = o.audience;
    this.accessTtlSec = o.accessTtlSec ?? 300;
    this.rotateRefresh = o.rotateRefresh ?? true;
    this.consent = { user: o.user ?? { sub: "user_01TESTUSER000000000000000", email: "tester@example.com" } };
  }

  static async start(o: IssuerOptions = {}): Promise<OidcIssuer> {
    const issuer = new OidcIssuer(o);
    await issuer.rotateKeys();
    issuer.server = await serve((r) => issuer.handle(r), o.port);
    return issuer;
  }

  get url(): string {
    if (!this.server) throw new Error("issuer not started");
    return this.server.url;
  }

  async stop(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  /** Adds a new signing key and signs with it from now on; the old keys stay in the JWKS unless dropped. */
  async rotateKeys(dropOld = false): Promise<string> {
    const k = await newKey("RS256");
    this.keys = dropOld ? [k] : [...this.keys, k];
    return k.kid;
  }

  /** Revokes every refresh token of this subject (the "sign out everywhere" of a provider). */
  revokeUser(sub: string): void {
    for (const r of this.refresh.values()) if (r.family.user.sub === sub) r.family.revoked = true;
  }

  /** An access token, minted directly, for tests that don't need the browser flow. */
  async mint(o: MintOptions = {}): Promise<string> {
    const alg = o.alg ?? "RS256";
    let key: Key;
    if (o.foreignKey || alg !== "RS256") {
      this.foreign = this.foreign && this.foreign.jwk.alg === alg ? this.foreign : await newKey(alg);
      key = this.foreign;
    } else key = this.keys.at(-1)!;
    const now = Math.floor(Date.now() / 1000) + (o.skewSec ?? 0);
    const claims: Record<string, unknown> = { ...o.extra };
    if (o.clientId !== null) claims.client_id = o.clientId ?? this.clientId;
    if (o.email ?? this.defaultUser().email) claims.email = o.email ?? this.defaultUser().email;
    const aud = o.aud === undefined ? this.audience : o.aud;
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg, kid: o.kid ?? key.kid, typ: "JWT" })
      .setIssuer(o.iss ?? this.url)
      .setSubject(o.sub ?? this.defaultUser().sub)
      .setIssuedAt(now)
      .setExpirationTime(now + (o.ttlSec ?? this.accessTtlSec))
      .setJti(crypto.randomUUID());
    if (aud) jwt.setAudience(aud);
    return jwt.sign(key.privateKey);
  }

  /**
   * Plays the system browser: follows the authorize URL, "signs in" per `consent`, and returns the
   * redirect the browser would load (the loopback callback, with `code` and `state` or an error).
   */
  async browse(authorizeUrl: string): Promise<URL> {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status !== 302 || !loc) throw new Error(`authorize failed: ${res.status} ${await res.text()}`);
    return new URL(loc);
  }

  private defaultUser(): IssuerUser {
    return this.consent === "deny" ? { sub: "user_denied" } : this.consent.user;
  }

  private async handle(req: Request): Promise<Response> {
    const origin = req.headers.get("origin");
    const allowed = origin !== null && this.corsOrigins.includes(origin) ? origin : null;
    const res = await this.route(req, allowed);
    if (allowed && !req.url.includes("/user_management/")) {
      res.headers.set("access-control-allow-origin", allowed);
      res.headers.set("vary", "origin");
    }
    return res;
  }

  private async route(req: Request, corsOrigin: string | null): Promise<Response> {
    if (req.method === "OPTIONS") {
      if (!corsOrigin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: { "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type, dpop", "access-control-max-age": "600" },
      });
    }
    if (this.down) return json({ error: "temporarily_unavailable" }, 503);
    const url = new URL(req.url);
    switch (`${req.method} ${url.pathname}`) {
      case "GET /.well-known/openid-configuration":
        return json(this.discovery());
      case "GET /jwks":
        this.stats.jwks++;
        return json({ keys: this.keys.map((k) => k.jwk) });
      case "GET /authorize":
        return this.authorize(url.searchParams);
      case "POST /token":
        return this.token(new URLSearchParams(await req.text()));
      case "POST /revoke":
        return this.revoke(new URLSearchParams(await req.text()));
      default: {
        const del = req.method === "DELETE" && /^\/user_management\/users\/([^/]+)$/.exec(url.pathname);
        if (del) return this.deleteUser(req, decodeURIComponent(del[1]!));
        return json({ error: "not_found" }, 404);
      }
    }
  }

  private discovery() {
    const base = this.url;
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      jwks_uri: `${base}/jwks`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["openid", "email", "profile", "offline_access"],
    };
  }

  private redirectAllowed(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    return this.redirectUris.some((r) => {
      const reg = new URL(r);
      const loopback = reg.protocol === "http:" && (reg.hostname === "127.0.0.1" || reg.hostname === "[::1]");
      return loopback
        ? u.protocol === "http:" && u.hostname === reg.hostname && u.pathname === reg.pathname && u.search === ""
        : u.href === reg.href;
    });
  }

  private authorize(p: URLSearchParams): Response {
    this.stats.authorize++;
    const redirectUri = p.get("redirect_uri") ?? "";
    // Never redirect to an unregistered URI: show an error page instead (RFC 6749 §4.1.2.1).
    if (p.get("client_id") !== this.clientId || !this.redirectAllowed(redirectUri)) {
      return new Response("unknown client or redirect_uri", { status: 400 });
    }
    const back = new URL(redirectUri);
    const state = p.get("state");
    if (state) back.searchParams.set("state", state);
    back.searchParams.set("iss", this.url);
    const fail = (error: string) => {
      back.searchParams.set("error", error);
      return new Response(null, { status: 302, headers: { location: back.href } });
    };
    if (p.get("response_type") !== "code") return fail("unsupported_response_type");
    const challenge = p.get("code_challenge");
    if (!challenge || p.get("code_challenge_method") !== "S256") return fail("invalid_request");
    if (!(p.get("scope") ?? "").split(" ").includes("openid")) return fail("invalid_scope");
    if (this.consent === "deny") return fail("access_denied");
    const code = randomToken();
    this.codes.set(code, {
      user: this.consent.user,
      clientId: this.clientId,
      redirectUri,
      challenge,
      nonce: p.get("nonce") ?? undefined,
      expiresAt: Date.now() + 60_000,
    });
    back.searchParams.set("code", code);
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(p: URLSearchParams): Promise<Response> {
    if (this.failNextToken) {
      const f = this.failNextToken;
      this.failNextToken = null;
      return json({ error: f.error }, f.status);
    }
    if (p.get("client_id") !== this.clientId) return json({ error: "invalid_client" }, 401);
    switch (p.get("grant_type")) {
      case "authorization_code": {
        const code = p.get("code") ?? "";
        const g = this.codes.get(code);
        this.codes.delete(code); // one use only, even when the exchange fails
        if (!g || g.expiresAt < Date.now() || g.redirectUri !== p.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
        if ((await s256(p.get("code_verifier") ?? "")) !== g.challenge) return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        this.stats.codeGrants++;
        const family: Family = { user: g.user, revoked: false, sid: crypto.randomUUID() };
        return json(await this.issue(family, g.nonce, true));
      }
      case "refresh_token": {
        const r = this.refresh.get(p.get("refresh_token") ?? "");
        if (!r || r.family.revoked) return json({ error: "invalid_grant" }, 400);
        if (r.used) {
          // A rotated-out token came back: someone copied it. Kill the whole family.
          r.family.revoked = true;
          this.stats.reuseDetected++;
          return json({ error: "invalid_grant", error_description: "refresh token reuse" }, 400);
        }
        this.stats.refreshes++;
        if (this.rotateRefresh) r.used = true;
        return json(await this.issue(r.family, undefined, this.rotateRefresh));
      }
      default:
        return json({ error: "unsupported_grant_type" }, 400);
    }
  }

  private async issue(family: Family, nonce: string | undefined, newRefresh: boolean) {
    const key = this.keys.at(-1)!;
    const now = Math.floor(Date.now() / 1000);
    const access = await this.mint({ sub: family.user.sub, email: family.user.email, extra: { sid: family.sid } });
    const id = new SignJWT({ ...(nonce ? { nonce } : {}), ...(family.user.email ? { email: family.user.email, email_verified: true } : {}) })
      .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
      .setIssuer(this.url)
      .setSubject(family.user.sub)
      .setAudience(this.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600);
    const out: Record<string, unknown> = {
      access_token: access,
      token_type: "Bearer",
      expires_in: this.accessTtlSec,
      id_token: await id.sign(key.privateKey),
    };
    if (newRefresh) {
      const rt = randomToken();
      this.refresh.set(rt, { family, used: false });
      out.refresh_token = rt;
    }
    return out;
  }

  private deleteUser(req: Request, sub: string): Response {
    if (req.headers.get("authorization") !== `Bearer ${this.adminKey}`) return json({ message: "Unauthorized" }, 401);
    const fail = this.failAdmin.shift();
    if (fail) return json({ message: "failed" }, fail);
    if (this.deletedUsers.has(sub)) return json({ message: "User not found" }, 404);
    this.deletedUsers.add(sub);
    this.stats.adminDeletes++;
    this.revokeUser(sub);
    return new Response(null, { status: 202 });
  }

  private revoke(p: URLSearchParams): Response {
    this.stats.revocations++;
    const r = this.refresh.get(p.get("token") ?? "");
    if (r) r.family.revoked = true;
    // RFC 7009: 200 even for unknown tokens.
    return new Response(null, { status: 200 });
  }
}

async function newKey(alg: "RS256" | "ES256"): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = randomToken().slice(0, 16);
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, privateKey, jwk };
}

function randomToken(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
