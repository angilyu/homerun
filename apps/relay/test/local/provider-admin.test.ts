import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OidcIssuer } from "@homerun/testkit";
import { ProviderAdminError, providerAdminFrom, WorkosAdmin } from "../../src/core/provider-admin";

let issuer: OidcIssuer;
beforeAll(async () => {
  issuer = await OidcIssuer.start();
});
afterAll(() => issuer.stop());

describe("PROVIDER_ADMIN", () => {
  test("none by default; workos needs its key; anything else is a mistake", () => {
    expect(providerAdminFrom({})).toBeNull();
    expect(providerAdminFrom({ PROVIDER_ADMIN: "none", WORKOS_API_KEY: "sk_x" })).toBeNull();
    expect(providerAdminFrom({ PROVIDER_ADMIN: "workos", WORKOS_API_KEY: "sk_x" })?.name).toBe("workos");
    expect(() => providerAdminFrom({ PROVIDER_ADMIN: "workos" })).toThrow(/WORKOS_API_KEY/);
    expect(() => providerAdminFrom({ PROVIDER_ADMIN: "auth0" })).toThrow(/unknown provider/);
  });
});

describe("WorkosAdmin", () => {
  test("deleted, or already gone, is done; a wrong key or an outage throws to be retried", async () => {
    const admin = new WorkosAdmin(issuer.adminKey, `${issuer.url}/`);
    await admin.deleteUser("user_a");
    expect(issuer.deletedUsers.has("user_a")).toBe(true);
    await admin.deleteUser("user_a");
    const wrong = new WorkosAdmin("sk_test_wrong", issuer.url);
    await expect(wrong.deleteUser("user_b")).rejects.toMatchObject({ status: 401 });
    issuer.failAdmin = [503];
    await expect(admin.deleteUser("user_b")).rejects.toBeInstanceOf(ProviderAdminError);
    await expect(new WorkosAdmin("k", "http://127.0.0.1:9").deleteUser("user_b")).rejects.toMatchObject({ status: null });
  });
});
