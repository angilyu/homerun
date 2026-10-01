import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { OidcClient, OidcError } from "@homerun/protocol";
import { OidcIssuer } from "../src";

let issuer: OidcIssuer;
const redirect = (port: number) => `http://127.0.0.1:${port}/callback`;

beforeAll(async () => {
  issuer = await OidcIssuer.start();
});
afterAll(() => issuer.stop());

const client = () => OidcClient.discover({ issuer: issuer.url, clientId: issuer.clientId, allowInsecureLoopback: true });

async function signIn(c: OidcClient, port = 53123) {
  const pending = await c.begin(redirect(port));
  return c.complete(pending, await issuer.browse(pending.url));
}

describe("the OIDC client against the local issuer", () => {
  test("refuses a plain-http issuer unless it is loopback and allowed", async () => {
    await expect(OidcClient.discover({ issuer: issuer.url, clientId: issuer.clientId })).rejects.toThrow(OidcError);
  });

  test("sign-in with PKCE; the access token verifies against the JWKS", async () => {
    const c = await client();
    const t = await signIn(c);
    expect(t.subject).toBe("user_01TESTUSER000000000000000");
    expect(t.email).toBe("tester@example.com");
    expect(t.refreshToken).toBeTruthy();
    expect(t.expiresAt).toBeGreaterThan(Date.now());
    const { payload } = await jwtVerify(t.accessToken, createRemoteJWKSet(new URL(`${issuer.url}/jwks`)), { issuer: issuer.url });
    expect(payload.sub).toBe(t.subject);
    expect(payload.client_id).toBe(issuer.clientId);
  });

  test("the loopback redirect may use any port", async () => {
    const c = await client();
    expect((await signIn(c, 61001)).subject).toBeTruthy();
  });

  test("a callback with the wrong state is refused", async () => {
    const c = await client();
    const pending = await c.begin(redirect(50000));
    const cb = await issuer.browse(pending.url);
    cb.searchParams.set("state", "forged");
    await expect(c.complete(pending, cb)).rejects.toThrow(OidcError);
  });

  test("a code can't be redeemed with another verifier, and only once", async () => {
    const c = await client();
    const a = await c.begin(redirect(50000));
    const b = await c.begin(redirect(50000));
    const cb = await issuer.browse(a.url);
    await expect(c.complete({ ...a, verifier: b.verifier }, cb)).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(c.complete(a, cb)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("an unregistered redirect gets an error page, never a redirect", async () => {
    const c = await client();
    const pending = await c.begin("https://evil.example/callback");
    await expect(issuer.browse(pending.url)).rejects.toThrow(/400/);
  });

  test("denied consent comes back as access_denied", async () => {
    const c = await client();
    const saved = issuer.consent;
    issuer.consent = "deny";
    try {
      const pending = await c.begin(redirect(50000));
      await expect(c.complete(pending, await issuer.browse(pending.url))).rejects.toMatchObject({ code: "access_denied" });
    } finally {
      issuer.consent = saved;
    }
  });

  test("refresh rotates; reusing a rotated-out token kills the family", async () => {
    const c = await client();
    const t0 = await signIn(c);
    const t1 = await c.refresh(t0.refreshToken!, t0);
    expect(t1.refreshToken).not.toBe(t0.refreshToken);
    expect(t1.subject).toBe(t0.subject);
    await expect(c.refresh(t0.refreshToken!, t0)).rejects.toMatchObject({ code: "invalid_grant" });
    expect(issuer.stats.reuseDetected).toBeGreaterThan(0);
    // The legitimate holder is now signed out too.
    await expect(c.refresh(t1.refreshToken!, t1)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("revocation ends the refresh token", async () => {
    const c = await client();
    const t = await signIn(c);
    await c.revoke(t.refreshToken!);
    await expect(c.refresh(t.refreshToken!, t)).rejects.toMatchObject({ code: "invalid_grant" });
  });

  test("a refresh that returns another account is refused", async () => {
    const c = await client();
    const t = await signIn(c);
    await expect(c.refresh(t.refreshToken!, { subject: "user_someone_else", email: undefined })).rejects.toThrow(/different account/);
  });

  test("a server error is not invalid_grant (the runtime keeps the token and retries)", async () => {
    const c = await client();
    const t = await signIn(c);
    issuer.failNextToken = { status: 503, error: "temporarily_unavailable" };
    const err = await c.refresh(t.refreshToken!, t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcError);
    expect((err as OidcError).code).not.toBe("invalid_grant");
    expect((await c.refresh(t.refreshToken!, t)).subject).toBe(t.subject);
  });
});

describe("minted tokens", () => {
  test("carry the configured claims and can be made invalid on purpose", async () => {
    const jwks = createRemoteJWKSet(new URL(`${issuer.url}/jwks`));
    const good = await issuer.mint({ sub: "user_x" });
    expect((await jwtVerify(good, jwks, { issuer: issuer.url })).payload.sub).toBe("user_x");
    await expect(jwtVerify(await issuer.mint({ skewSec: -3600, ttlSec: 60 }), jwks, { issuer: issuer.url })).rejects.toThrow();
    await expect(jwtVerify(await issuer.mint({ foreignKey: true }), jwks, { issuer: issuer.url })).rejects.toThrow();
    await expect(jwtVerify(await issuer.mint({ iss: "https://other.example" }), jwks, { issuer: issuer.url })).rejects.toThrow();
  });

  test("rotated keys: new tokens use the new kid, old ones verify until the key is dropped", async () => {
    const before = await issuer.mint();
    await issuer.rotateKeys();
    const after = await issuer.mint();
    const jwks = createRemoteJWKSet(new URL(`${issuer.url}/jwks`));
    await jwtVerify(before, jwks);
    await jwtVerify(after, jwks);
    await issuer.rotateKeys(true);
    const fresh = createRemoteJWKSet(new URL(`${issuer.url}/jwks`));
    await expect(jwtVerify(before, fresh)).rejects.toThrow();
  });
});

describe("the management API", () => {
  test("deletes a user with the admin key, once, and ends its refresh tokens", async () => {
    const c = await client();
    issuer.consent = { user: { sub: "user_to_delete", email: "gone@example.com" } };
    const t = await signIn(c);
    const del = (key: string) => fetch(`${issuer.url}/user_management/users/user_to_delete`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } });
    expect((await del("sk_test_wrong")).status).toBe(401);
    expect(issuer.deletedUsers.has("user_to_delete")).toBe(false);
    issuer.failAdmin = [503];
    expect((await del(issuer.adminKey)).status).toBe(503);
    expect((await del(issuer.adminKey)).status).toBe(202);
    expect(issuer.deletedUsers.has("user_to_delete")).toBe(true);
    expect((await del(issuer.adminKey)).status).toBe(404);
    await expect(c.refresh(t.refreshToken!, t)).rejects.toThrow(OidcError);
    issuer.consent = { user: { sub: "user_01TESTUSER000000000000000", email: "tester@example.com" } };
  });
});
