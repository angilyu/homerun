import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTPayload } from "jose";
import { WS_BEARER_PREFIX, WS_SUBPROTOCOL } from "@homerun/protocol";

/**
 * Verifies the provider's access tokens at the edge (§10.3): a JWT checked against the issuer's
 * JWKS, which is fetched once and cached (a new `kid` triggers a refetch, rate-limited), so no
 * request calls the provider. Standard claims only, so the provider stays swappable.
 */

export interface AuthConfig {
  issuer: string;
  /** Required `aud`, when the provider sets one. */
  audience?: string;
  /** Required `client_id` claim (or `aud` entry) when there is no audience: WorkOS's shape. */
  clientId?: string;
  /** Defaults to the issuer's discovery document's `jwks_uri`. */
  jwksUrl?: string;
  leewaySec?: number;
  /** Minimum time between JWKS refetches for an unknown `kid` (default 30 s). */
  jwksCooldownMs?: number;
  fetch?: typeof fetch;
  /** The clock tokens are checked against (tests use a fake one). */
  now?: () => number;
}

export interface VerifiedToken {
  sub: string;
  /** Milliseconds since the epoch. */
  exp: number;
}

export class AuthError extends Error {
  override name = "AuthError";
  constructor(
    readonly code: "unauthenticated" | "token_expired" | "internal",
    message: string,
  ) {
    super(message);
  }
}

const ALGORITHMS = ["RS256", "ES256"];

export class TokenVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksLoading: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

  constructor(private readonly cfg: AuthConfig) {
    if (!cfg.issuer) throw new Error("OIDC_ISSUER is not configured");
  }

  async verify(token: string): Promise<VerifiedToken> {
    const jwks = await this.keys();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, {
        issuer: this.cfg.issuer,
        audience: this.cfg.audience || undefined,
        algorithms: ALGORITHMS,
        clockTolerance: this.cfg.leewaySec ?? 60,
        requiredClaims: ["sub", "exp"],
        ...(this.cfg.now ? { currentDate: new Date(this.cfg.now()) } : {}),
      }));
    } catch (e) {
      if (e instanceof errors.JWTExpired) throw new AuthError("token_expired", "the access token has expired");
      if (e instanceof errors.JWKSTimeout) throw new AuthError("internal", "the issuer's keys could not be fetched");
      throw new AuthError("unauthenticated", "the access token is not valid");
    }
    if (!this.cfg.audience && this.cfg.clientId) {
      const aud = typeof payload.aud === "string" ? [payload.aud] : (payload.aud ?? []);
      if (payload.client_id !== this.cfg.clientId && !aud.includes(this.cfg.clientId)) {
        throw new AuthError("unauthenticated", "the access token is for another client");
      }
    }
    return { sub: payload.sub!, exp: payload.exp! * 1000 };
  }

  private async keys() {
    if (this.jwks) return this.jwks;
    this.jwksLoading ??= this.load().finally(() => (this.jwksLoading = null));
    return this.jwksLoading;
  }

  private async load() {
    const f = this.cfg.fetch ?? fetch;
    let url = this.cfg.jwksUrl;
    if (!url) {
      try {
        const res = await f(new URL(".well-known/openid-configuration", this.cfg.issuer.endsWith("/") ? this.cfg.issuer : `${this.cfg.issuer}/`));
        const doc = (await res.json()) as { jwks_uri?: unknown; issuer?: unknown };
        if (!res.ok || typeof doc.jwks_uri !== "string" || doc.issuer !== this.cfg.issuer) throw new Error("bad discovery document");
        url = doc.jwks_uri;
      } catch {
        throw new AuthError("internal", "the issuer's discovery document could not be fetched");
      }
    }
    this.jwks = createRemoteJWKSet(new URL(url), {
      cooldownDuration: this.cfg.jwksCooldownMs ?? 30_000,
      cacheMaxAge: 10 * 60_000,
      ...(this.cfg.fetch ? { [customFetch]: this.cfg.fetch } : {}),
    });
    return this.jwks;
  }
}

/**
 * The bearer token of a request: the `Authorization` header, or, for a browser's WebSocket, a
 * `bearer.<token>` subprotocol offered next to `homerun.v1`.
 */
export function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
    if (!offered.includes(WS_SUBPROTOCOL)) return null;
    const b = offered.find((p) => p.startsWith(WS_BEARER_PREFIX));
    return b ? b.slice(WS_BEARER_PREFIX.length) || null : null;
  }
  return null;
}
