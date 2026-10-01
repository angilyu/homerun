/**
 * Where the web client finds the relay and the identity provider, fixed when it is built
 * (scripts/build.ts): the page's Content-Security-Policy names exactly these origins.
 */
export interface WebConfig {
  relayUrl: string;
  issuer: string;
  clientId: string;
  /** Extra authorization parameters the provider needs (WorkOS: `provider=authkit`). */
  authParams?: Record<string, string>;
  /** A development build: plain http on 127.0.0.1 for the local issuer and relay. */
  dev: boolean;
  version: string;
}

declare const HOMERUN_WEB_RELAY_URL: string | undefined;
declare const HOMERUN_WEB_OIDC_ISSUER: string | undefined;
declare const HOMERUN_WEB_OIDC_CLIENT_ID: string | undefined;
declare const HOMERUN_WEB_AUTH_PARAMS: string | undefined;
declare const HOMERUN_WEB_DEV: string | undefined;
declare const HOMERUN_WEB_VERSION: string | undefined;

/** The built-in configuration, or null in a build without one. */
export function builtInConfig(): WebConfig | null {
  const relayUrl = typeof HOMERUN_WEB_RELAY_URL === "string" ? HOMERUN_WEB_RELAY_URL : "";
  const issuer = typeof HOMERUN_WEB_OIDC_ISSUER === "string" ? HOMERUN_WEB_OIDC_ISSUER : "";
  const clientId = typeof HOMERUN_WEB_OIDC_CLIENT_ID === "string" ? HOMERUN_WEB_OIDC_CLIENT_ID : "";
  if (!relayUrl || !issuer || !clientId) return null;
  const params = typeof HOMERUN_WEB_AUTH_PARAMS === "string" && HOMERUN_WEB_AUTH_PARAMS ? (JSON.parse(HOMERUN_WEB_AUTH_PARAMS) as Record<string, string>) : undefined;
  return {
    relayUrl,
    issuer,
    clientId,
    ...(params ? { authParams: params } : {}),
    dev: typeof HOMERUN_WEB_DEV === "string" && HOMERUN_WEB_DEV === "1",
    version: typeof HOMERUN_WEB_VERSION === "string" ? HOMERUN_WEB_VERSION : "0.0.0",
  };
}
