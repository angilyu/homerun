import { afterAll, beforeAll } from "bun:test";
import { ApnsMock, OidcIssuer } from "@homerun/testkit";
import { type LocalRelay, startLocalRelay } from "../../src/local";
import { appAttest } from "../helpers";
import { type Ctx, sharedScenarios } from "../scenarios";

let issuer: OidcIssuer;
let apns: ApnsMock;
let relay: LocalRelay;

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  apns = await ApnsMock.start();
  relay = await startLocalRelay({
    issuer: issuer.url,
    clientId: issuer.clientId,
    apns: { keyP8: apns.p8, keyId: apns.keyId, teamId: apns.teamId, topic: apns.topic, endpoint: apns.url },
    appAttest: appAttest.policy(),
  });
});
afterAll(async () => {
  await relay.stop();
  await apns.stop();
  await issuer.stop();
});

sharedScenarios((): Ctx => ({ t: { url: relay.url, wsUrl: relay.wsUrl, now: Date.now }, issuer, apns }));
