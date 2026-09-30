declare module "*.sql" {
  const text: string;
  export default text;
}

/** Defined at compile time for release builds (`bun build --define`). */
declare const HOMERUND_VERSION: string | undefined;
declare const HOMERUND_BUILD: string | undefined;
/** Remote access (§9, §10.4): release builds get the relay and identity provider from build defines. */
declare const HOMERUND_RELAY_URL: string | undefined;
declare const HOMERUND_OIDC_ISSUER: string | undefined;
declare const HOMERUND_OIDC_CLIENT_ID: string | undefined;
