import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RELAY_PATHS } from "@homerun/protocol";
import { OidcIssuer } from "@homerun/testkit";
import { type LocalRelay, startLocalRelay } from "../../src/local";
import { VERSION_POLICY } from "../helpers";

/** Publishing and unpublishing the version policy (§11); the shared scenarios cover serving it. */

let issuer: OidcIssuer;
let relay: LocalRelay;
let published: string | null = null;

beforeAll(async () => {
  issuer = await OidcIssuer.start();
  relay = await startLocalRelay({ issuer: issuer.url, clientId: issuer.clientId, apns: null, versionPolicy: () => published });
});
afterAll(async () => {
  await relay.stop();
  await issuer.stop();
});

describe("GET /v1/version-policy", () => {
  test("nothing published: 404, cached briefly, so clients fail open", async () => {
    published = null;
    const r = await fetch(relay.url + RELAY_PATHS.versionPolicy);
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("a new publication is served on the next request", async () => {
    published = VERSION_POLICY.published;
    expect(await (await fetch(relay.url + RELAY_PATHS.versionPolicy)).text()).toBe(VERSION_POLICY.published);
    const head = await fetch(relay.url + RELAY_PATHS.versionPolicy, { method: "HEAD" });
    expect(head.status).toBe(200);
  });

  test("a malformed publication is refused, not served", async () => {
    for (const bad of ["not json", JSON.stringify({ body: "{}", key_id: "x", signature: "short" }), JSON.stringify({ ...JSON.parse(VERSION_POLICY.published), extra: 1 })]) {
      published = bad;
      const r = await fetch(relay.url + RELAY_PATHS.versionPolicy);
      expect(r.status).toBe(502);
      expect(await r.text()).not.toContain(bad);
    }
  });
});
