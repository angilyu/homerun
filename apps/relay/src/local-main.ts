import { productionAppAttestPolicy } from "@homerun/protocol";
import { parseWebOrigins } from "./core/cors";
import { providerAdminFrom } from "./core/provider-admin";
import { startLocalRelay } from "./local";

/**
 * `bun run dev`: the relay on Bun for local development. Configuration from the environment:
 * OIDC_ISSUER (required), OIDC_AUDIENCE, OIDC_CLIENT_ID, RELAY_PORT (default 8787) and
 * RELAY_DATA_DIR. Push is off unless APNS_KEY_P8_FILE, APNS_KEY_ID, APNS_TEAM_ID and
 * APNS_TOPIC are set. APP_ATTEST_ALLOW_DEVELOP=1 accepts development-signed iPhone builds. WEB_ORIGINS lists
 * the web client's origins (comma-separated), e.g. http://127.0.0.1:5173 for its dev server.
 */

const env = process.env;
if (!env.OIDC_ISSUER) {
  console.error("set OIDC_ISSUER (and OIDC_CLIENT_ID or OIDC_AUDIENCE)");
  process.exit(2);
}
const apns =
  env.APNS_KEY_P8_FILE && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_TOPIC
    ? { keyP8: await Bun.file(env.APNS_KEY_P8_FILE).text(), keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC }
    : null;
const relay = await startLocalRelay({
  issuer: env.OIDC_ISSUER,
  ...(env.OIDC_AUDIENCE ? { audience: env.OIDC_AUDIENCE } : {}),
  ...(env.OIDC_CLIENT_ID ? { clientId: env.OIDC_CLIENT_ID } : {}),
  port: Number(env.RELAY_PORT ?? 8787),
  ...(env.RELAY_DATA_DIR ? { dataDir: env.RELAY_DATA_DIR } : {}),
  apns,
  appAttest: productionAppAttestPolicy(env.APP_ATTEST_ALLOW_DEVELOP === "1"),
  ...(env.WEB_ORIGINS ? { webOrigins: parseWebOrigins(env.WEB_ORIGINS) } : {}),
  providerAdmin: providerAdminFrom({ PROVIDER_ADMIN: env.PROVIDER_ADMIN, WORKOS_API_KEY: env.WORKOS_API_KEY, WORKOS_API_BASE: env.WORKOS_API_BASE }),
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});
console.log(`relay listening on ${relay.url}`);
