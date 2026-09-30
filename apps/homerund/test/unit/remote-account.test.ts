import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR, type AccountStatus } from "@homerun/core";
import { OidcIssuer } from "@homerun/testkit";
import { RpcCallError, RpcClient } from "../../src/rpc/client";
import { LAUNCH_TOKEN, socketRuntime, until, type SocketRuntime } from "../helpers";
import { remoteConfig } from "../../src/remote/config";
import { DevOnlyError } from "../../src/config";

let issuer: OidcIssuer;
beforeAll(async () => {
  issuer = await OidcIssuer.start({ user: { sub: "user_ada", email: "ada@example.com" } });
});
afterAll(async () => {
  await issuer.stop();
});

let srt: SocketRuntime | null = null;
afterEach(async () => {
  await srt?.close();
  srt = null;
  issuer.consent = { user: { sub: "user_ada", email: "ada@example.com" } };
});

const env = () => ({ HOMERUN_RELAY_URL: "http://127.0.0.1:9", HOMERUN_OIDC_ISSUER: issuer.url, HOMERUN_OIDC_CLIENT_ID: issuer.clientId });

/**
 * The shell, as far as sign-in goes: stores what the runtime persists and opens the browser.
 * `browse: "auto"` plays the user signing in at once; "manual" records the URL for the test.
 */
async function shellFor(s: SocketRuntime, o: { browse?: "auto" | "manual"; keychain?: Map<string, string>; hand?: boolean; hang?: boolean } = {}) {
  const keychain = o.keychain ?? new Map<string, string>();
  const opened: string[] = [];
  const statuses: AccountStatus[] = [];
  const c = await RpcClient.connect(s.rt.config.socketPath);
  c.onRequest((method, params) => {
    const p = params as { name: string; value?: string };
    if (o.hang) return new Promise(() => {});
    if (method === "secrets.persist") keychain.set(p.name, p.value!);
    else if (method === "secrets.delete") keychain.delete(p.name);
    return method === "secrets.persist" ? { stored: true } : { deleted: true };
  });
  c.onNotification((method, params) => {
    if (method === "account.changed") statuses.push((params as { status: AccountStatus }).status);
    if (method !== "browser.open") return;
    const url = (params as { url: string }).url;
    opened.push(url);
    if ((o.browse ?? "auto") === "auto") void issuer.browse(url).then((cb) => fetch(cb)).catch(() => {});
  });
  await c.handshake("shell", { kind: "launch_token", token: LAUNCH_TOKEN });
  // The Rust shell hands over whatever the keychain holds right after hello.
  if (o.hand !== false) for (const [name, value] of keychain) await c.call("secrets.set", { name: name as "refresh_token", value });
  const status = async () => (await c.call("account.status", {})).status;
  return { c, keychain, opened, statuses, status };
}

const settled = (sh: { statuses: AccountStatus[] }, state: AccountStatus["state"]) => until(() => sh.statuses.at(-1)?.state === state, 5000, state);

describe("configuration", () => {
  test("all three settings or none; release builds refuse environment overrides", () => {
    const devOnly = (release: boolean) => (what: string, v: unknown) => {
      if (release && v) throw new DevOnlyError(what);
      return v;
    };
    const none = { relayUrl: undefined, issuer: undefined, clientId: undefined };
    expect(remoteConfig({}, true, devOnly(false), none)).toBeNull();
    expect(() => remoteConfig({ HOMERUN_RELAY_URL: "https://r.example" }, true, devOnly(false), none)).toThrow(/together/);
    expect(() => remoteConfig({ HOMERUN_RELAY_URL: "https://r.example" }, false, devOnly(true), none)).toThrow(DevOnlyError);
    const built = { relayUrl: "https://relay.example/", issuer: "https://auth.example/", clientId: "client_1" };
    expect(remoteConfig({}, false, devOnly(true), built)).toEqual({ relayUrl: "https://relay.example", issuer: "https://auth.example/", clientId: "client_1", insecureLoopback: false });
    // Plain http only for a local issuer or relay, and only in development builds.
    expect(() => remoteConfig({}, false, devOnly(true), { ...built, issuer: "http://127.0.0.1:1" })).toThrow(/https/);
    expect(() => remoteConfig({ HOMERUN_RELAY_URL: "http://relay.example", HOMERUN_OIDC_ISSUER: "https://a", HOMERUN_OIDC_CLIENT_ID: "c" }, true, devOnly(false), none)).toThrow(/https/);
    expect(remoteConfig({ HOMERUN_RELAY_URL: "http://127.0.0.1:8787", HOMERUN_OIDC_ISSUER: "http://localhost:1", HOMERUN_OIDC_CLIENT_ID: "c" }, true, devOnly(false), none)!.insecureLoopback).toBe(true);
  });

  test("without a relay or provider, remote access is not configured", async () => {
    srt = await socketRuntime();
    const sh = await shellFor(srt);
    expect((await sh.status()).state).toBe("not_configured");
    const e = (await sh.c.call("account.sign_in", {}).catch((x) => x)) as RpcCallError;
    expect(e.code).toBe(RPC_ERROR.UNAVAILABLE);
  });
});

describe("sign-in (§10.4): PKCE through the system browser and a loopback redirect", () => {
  test("signs in, keeps the access token in memory and hands the refresh token to the shell", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt);
    expect((await sh.status()).state).toBe("signed_out");
    const r = await sh.c.call("account.sign_in", {});
    expect(r.status.state).toBe("signing_in");
    await settled(sh, "signed_in");
    const url = new URL(sh.opened[0]!);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(await sh.status()).toMatchObject({ state: "signed_in", email: "ada@example.com", error: null });
    await until(() => sh.keychain.has("refresh_token"));
    expect(srt.rt.secrets.get("refresh_token")).toBe(sh.keychain.get("refresh_token")!);
    expect(srt.rt.remote.account.subject).toBe("user_ada");
    // The loopback listener is gone once the attempt is over.
    const redirect = url.searchParams.get("redirect_uri")!;
    expect(await fetch(redirect).catch(() => "closed")).toBe("closed");
    // Nothing of the tokens reaches the logs.
    const joined = srt.logs.join("\n");
    expect(joined).not.toContain(sh.keychain.get("refresh_token")!);
  });

  test("declined at the provider: signed out, with the reason", async () => {
    srt = await socketRuntime({ env: env() });
    issuer.consent = "deny";
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_out");
    expect((await sh.status()).error).toBe("Sign-in was declined.");
  });

  test("a redirect with the wrong state is refused and the attempt keeps waiting", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt, { browse: "manual" });
    await sh.c.call("account.sign_in", {});
    await until(() => sh.opened.length === 1);
    const cb = await issuer.browse(sh.opened[0]!);
    const forged = new URL(cb);
    forged.searchParams.set("state", "forged");
    expect((await fetch(forged)).status).toBe(400);
    expect((await sh.status()).state).toBe("signing_in");
    expect((await fetch(cb)).status).toBe(200);
    await settled(sh, "signed_in");
  });

  test("cancel, and the timeout, end the attempt", async () => {
    srt = await socketRuntime({ env: env(), remote: { signInTimeoutMs: 300 } });
    const sh = await shellFor(srt, { browse: "manual" });
    await sh.c.call("account.sign_in", {});
    await until(() => sh.opened.length === 1);
    await sh.c.call("account.cancel_sign_in", {});
    await settled(sh, "signed_out");
    expect((await sh.status()).error).toBe("Sign-in was cancelled.");
    const cb = await issuer.browse(sh.opened[0]!);
    expect(await fetch(cb).catch(() => "closed")).toBe("closed");

    await sh.c.call("account.sign_in", {});
    await until(() => sh.opened.length === 2);
    await settled(sh, "signed_out");
    expect((await sh.status()).error).toBe("Sign-in timed out. Try again.");
  });

  test("an unreachable provider fails the attempt with words the user can act on", async () => {
    srt = await socketRuntime({ env: { ...env(), HOMERUN_OIDC_ISSUER: "http://127.0.0.1:9" } });
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_out");
    expect((await sh.status()).error).toMatch(/Couldn't reach the sign-in service|Sign-in failed/);
  });
});

describe("tokens (§5.2 rotation)", () => {
  test("refreshes one at a time, and persists each rotated refresh token", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    await until(() => sh.keychain.has("refresh_token"));
    const first = sh.keychain.get("refresh_token");
    const before = issuer.stats.refreshes;
    const a = srt.rt.remote.account;
    const [t1, t2] = await Promise.all([a.refresh(), a.refresh()]);
    expect(t1).toBe(t2);
    expect(issuer.stats.refreshes).toBe(before + 1);
    await until(() => sh.keychain.get("refresh_token") !== first);
    expect(await a.accessToken()).toBe(t1);
  });

  test("a rejected refresh token asks the user to sign in again and removes it", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    issuer.revokeUser("user_ada");
    expect(await srt.rt.remote.account.refresh().catch((e) => e.name)).toBe("SignedOutError");
    await settled(sh, "needs_sign_in");
    expect(await sh.status()).toMatchObject({ state: "needs_sign_in", email: "ada@example.com" });
    await until(() => !sh.keychain.has("refresh_token"));
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
  });

  test("an unreachable provider during a refresh keeps the sign-in", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    issuer.down = true;
    try {
      expect(await srt.rt.remote.account.refresh().catch((e) => e.name)).not.toBe("SignedOutError");
      expect((await sh.status()).state).toBe("signed_in");
    } finally {
      issuer.down = false;
    }
  });

  test("after a restart the shell's stored token resumes the sign-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-acct-"));
    try {
      const keychain = new Map<string, string>();
      srt = await socketRuntime({ env: env(), dir });
      let sh = await shellFor(srt, { keychain });
      await sh.c.call("account.sign_in", {});
      await settled(sh, "signed_in");
      await until(() => keychain.has("refresh_token"));
      await srt.close();

      srt = await socketRuntime({ env: env(), dir });
      sh = await shellFor(srt, { keychain });
      expect(await sh.status()).toMatchObject({ state: "signed_in", email: "ada@example.com" });
      expect(srt.rt.remote.account.usable).toBe(true);
      expect(typeof (await srt.rt.remote.account.accessToken())).toBe("string");
    } finally {
      await srt?.close();
      srt = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a runtime that restarted before a rotated token was stored needs a new sign-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-acct-"));
    try {
      const keychain = new Map<string, string>();
      srt = await socketRuntime({ env: env(), dir });
      const sh = await shellFor(srt, { keychain });
      await sh.c.call("account.sign_in", {});
      await settled(sh, "signed_in");
      await until(() => keychain.has("refresh_token"));
      // The shell stops storing; the runtime rotates the token and is killed before it is stored.
      sh.c.close();
      await srt.rt.remote.account.refresh();
      expect(srt.rt.shellSecrets.isPending("refresh_token")).toBe(true);
      srt.crash();

      srt = await socketRuntime({ env: env(), dir });
      const again = await shellFor(srt, { keychain });
      expect(await srt.rt.remote.account.refresh().catch((e) => e.name)).toBe("SignedOutError");
      await settled(again, "needs_sign_in");
      expect(issuer.stats.reuseDetected).toBeGreaterThan(0);
    } finally {
      await srt?.close();
      srt = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("signed in but the keychain has no token: sign in again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-acct-"));
    try {
      srt = await socketRuntime({ env: env(), dir });
      const sh = await shellFor(srt);
      await sh.c.call("account.sign_in", {});
      await settled(sh, "signed_in");
      await srt.close();
      srt = await socketRuntime({ env: env(), dir, remote: { handoverMs: 50 } });
      const empty = await shellFor(srt, { keychain: new Map() });
      await settled(empty, "needs_sign_in");
    } finally {
      await srt?.close();
      srt = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sign-out", () => {
  test("revokes the refresh token at the provider and removes it everywhere", async () => {
    srt = await socketRuntime({ env: env() });
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    await until(() => sh.keychain.has("refresh_token"));
    const revocations = issuer.stats.revocations;
    const r = await sh.c.call("account.sign_out", {});
    expect(r.status).toMatchObject({ state: "signed_out", email: null });
    expect(srt.rt.secrets.has("refresh_token")).toBe(false);
    await until(() => !sh.keychain.has("refresh_token"));
    expect(issuer.stats.revocations).toBe(revocations + 1);
    expect(await srt.rt.remote.account.accessToken().catch((e) => e.name)).toBe("SignedOutError");
  });

  test("signing in as someone else reports the switch so their pairings can be forgotten", async () => {
    srt = await socketRuntime({ env: env() });
    const switched: string[] = [];
    srt.rt.remote.account["d"].accountSwitched = (from, to) => switched.push(`${from}->${to}`);
    const sh = await shellFor(srt);
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    await sh.c.call("account.sign_out", {});
    issuer.consent = { user: { sub: "user_bob", email: "bob@example.com" } };
    await sh.c.call("account.sign_in", {});
    await settled(sh, "signed_in");
    expect(switched).toEqual(["user_ada->user_bob"]);
    expect((await sh.status()).email).toBe("bob@example.com");
  });
});
