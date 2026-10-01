import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApnsMock, OidcIssuer } from "@homerun/testkit";
import { appAttestRoot } from "../helpers";
import { type Ctx, sharedScenarios } from "../scenarios";
import { startWorkerd } from "./host";

/** The same scenarios as on Bun, against the real Worker and Durable Object in workerd. */

let issuer: OidcIssuer;
let apns: ApnsMock;
let host: Awaited<ReturnType<typeof startWorkerd>>;

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  apns = await ApnsMock.start();
  host = await startWorkerd({
    OIDC_ISSUER: issuer.url,
    OIDC_CLIENT_ID: issuer.clientId,
    APNS_KEY_P8: apns.p8,
    APNS_KEY_ID: apns.keyId,
    APNS_TEAM_ID: apns.teamId,
    APNS_TOPIC: apns.topic,
    APNS_ENDPOINT: apns.url,
    APP_ATTEST_TEST_ROOT: appAttestRoot,
  });
}, 60_000);
afterAll(async () => {
  await host?.stop();
  await apns?.stop();
  await issuer?.stop();
});

describe("workerd", () => {
  test("is up", async () => {
    expect((await fetch(`${host.url}/v1/health`)).status).toBe(200);
  });
});

sharedScenarios((): Ctx => ({ t: { url: host.url, wsUrl: `${host.url.replace(/^http/, "ws")}/v1/connect`, now: Date.now }, issuer, apns }));
