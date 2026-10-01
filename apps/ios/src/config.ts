/**
 * Where the iPhone app finds the relay and the identity provider, fixed when it is built:
 * `app.config.ts` reads `HOMERUN_IOS_*` and puts them in `extra.homerun`.
 */
export interface IosConfig {
  relayUrl: string;
  issuer: string;
  clientId: string;
  /** Extra authorization parameters the provider needs (WorkOS: `provider=authkit`). */
  authParams?: Record<string, string>;
  /** A development build: plain http on loopback for the local issuer and relay. */
  dev: boolean;
  version: string;
}

/** The configuration in `extra.homerun`, or null in a build without one. */
export function parseConfig(extra: unknown): IosConfig | null {
  const h = (extra as { homerun?: Record<string, unknown> } | null | undefined)?.homerun;
  if (!h) return null;
  const str = (k: string) => (typeof h[k] === "string" ? (h[k] as string) : "");
  const relayUrl = str("relayUrl");
  const issuer = str("issuer");
  const clientId = str("clientId");
  if (!relayUrl || !issuer || !clientId) return null;
  const params = h.authParams;
  const authParams =
    params && typeof params === "object" && Object.values(params).every((v) => typeof v === "string") ? (params as Record<string, string>) : undefined;
  return {
    relayUrl,
    issuer,
    clientId,
    ...(authParams && Object.keys(authParams).length ? { authParams } : {}),
    dev: h.dev === true,
    version: str("version") || "0.0.0",
  };
}
