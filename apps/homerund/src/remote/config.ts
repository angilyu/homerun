/**
 * Where remote access lives (§9, §10.4): the relay's https URL and the identity provider (an
 * OpenID Connect issuer and this app's public client id). Release builds take them from build
 * defines only (`bun build --define HOMERUND_RELAY_URL=...`); a release built without them shows
 * remote access as not configured. Development builds may override them from the environment,
 * like the other base-URL switches (§18), and may use a plain-http issuer or relay on 127.0.0.1
 * for the local test issuer and relay.
 */

export interface RemoteConfig {
  relayUrl: string;
  issuer: string;
  clientId: string;
  /** Development only: http on 127.0.0.1 / localhost. */
  insecureLoopback: boolean;
}

const defined = (v: string | undefined): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export const BUILT_IN = {
  relayUrl: defined(typeof HOMERUND_RELAY_URL === "string" ? HOMERUND_RELAY_URL : undefined),
  issuer: defined(typeof HOMERUND_OIDC_ISSUER === "string" ? HOMERUND_OIDC_ISSUER : undefined),
  clientId: defined(typeof HOMERUND_OIDC_CLIENT_ID === "string" ? HOMERUND_OIDC_CLIENT_ID : undefined),
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function checkUrl(what: string, raw: string, dev: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  const ok = u.protocol === "https:" || (dev && u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!ok) throw new Error(`${what} must be https${dev ? " (or http on 127.0.0.1)" : ""}`);
  return raw;
}

/**
 * `env` overrides are development-only; `devOnly` throws DevOnlyError when one is set in a release
 * build. All three settings are needed; with none, remote access is not configured.
 */
export function remoteConfig(
  env: Record<string, string | undefined>,
  dev: boolean,
  devOnly: (what: string, v: unknown) => unknown,
  builtIn: typeof BUILT_IN = BUILT_IN,
): RemoteConfig | null {
  const pick = (name: string, fallback: string | undefined) => (devOnly(name, env[name]) as string | undefined) || fallback;
  const relayUrl = pick("HOMERUN_RELAY_URL", builtIn.relayUrl);
  const issuer = pick("HOMERUN_OIDC_ISSUER", builtIn.issuer);
  const clientId = pick("HOMERUN_OIDC_CLIENT_ID", builtIn.clientId);
  if (!relayUrl && !issuer && !clientId) return null;
  if (!relayUrl || !issuer || !clientId) throw new Error("remote access needs HOMERUN_RELAY_URL, HOMERUN_OIDC_ISSUER and HOMERUN_OIDC_CLIENT_ID together");
  return {
    relayUrl: checkUrl("HOMERUN_RELAY_URL", relayUrl, dev).replace(/\/+$/, ""),
    // Exactly as given: an issuer identifier must match the provider's discovery document.
    issuer: checkUrl("HOMERUN_OIDC_ISSUER", issuer, dev),
    clientId,
    insecureLoopback: dev,
  };
}
