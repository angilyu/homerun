import { startLocalRelay } from "./local";

/**
 * `bun run dev`: the relay on Bun for local development. Configuration from the environment:
 * OIDC_ISSUER (required), OIDC_AUDIENCE, OIDC_CLIENT_ID, RELAY_PORT (default 8787) and
 * RELAY_DATA_DIR. Push is off unless APNS_KEY_P8_FILE, APNS_KEY_ID, APNS_TEAM_ID and
 * APNS_TOPIC are set.
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
  log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
});
console.log(`relay listening on ${relay.url}`);
