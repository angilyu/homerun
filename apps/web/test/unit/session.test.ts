import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { AppClient } from "@homerun/app-state";
import { connected, desktop, newUser, startWorld, WORLD_START_MS, type World } from "../../../homerund/test/remote/harness";
import { until } from "../../../homerund/test/helpers";
import type { WebConfig } from "../../src/config";
import { CALLBACK_PATH, WebSession, type WebEnv } from "../../src/session";
import { MemoryKv, TokenVault, type Kv } from "../../src/storage";

/**
 * The web client's session against the real runtime, the relay's Bun adapter and the local
 * issuer: sign in by redirect, link by code, open the desktop, reload, unlink, sign out, switch
 * person, delete the account. The browser is a stand-in (storage, URL, navigation).
 */

const ORIGIN = "http://127.0.0.1:5199";
let w: World;
beforeAll(async () => {
  w = await startWorld();
  w.issuer.redirectUris.push(`http://127.0.0.1${CALLBACK_PATH}`);
}, WORLD_START_MS);
afterAll(async () => {
  await w.stop();
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

class MapStorage {
  readonly m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

/** One browser profile: its IndexedDB and localStorage outlive the page; sessionStorage is per tab. */
function browser() {
  return { kv: new MemoryKv() as Kv, local: new MapStorage(), tab: new MapStorage() };
}
type Browser = ReturnType<typeof browser>;

type Shown = { client: AppClient };

function page(b: Browser, href = `${ORIGIN}/`) {
  const config: WebConfig = { relayUrl: w.relay.url, issuer: w.issuer.url, clientId: w.issuer.clientId, dev: true, version: "0.0.0" };
  const navigated: string[] = [];
  const env: WebEnv = {
    config,
    kv: b.kv,
    origin: ORIGIN,
    href: () => href,
    replaceUrl: (path) => void (href = new URL(path, ORIGIN).href),
    navigate: (url) => void navigated.push(url),
    session: b.tab,
    local: b.local,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    locks: null,
    supported: async () => true,
  };
  const s = new WebSession<Shown>(env, (t) => ({ client: new AppClient(t, { role: "web", keepThreadMs: 0 }) }));
  cleanup.push(() => s.close());
  return { s, navigated, href: () => href };
}

const phaseIs = (s: WebSession<Shown>, p: string, ms = 8000) => until(() => s.phase.get().s === p, ms, `phase ${p} (at ${s.phase.get().s})`);

/** Signs in: the page redirects to the issuer, which comes back to the callback in a new page. */
async function signIn(b: Browser) {
  const first = page(b);
  await first.s.start();
  expect(first.s.phase.get()).toEqual({ s: "signed_out", notice: null, tone: "info" });
  await first.s.signIn();
  expect(first.s.phase.get().s).toBe("redirecting");
  const authorize = first.navigated.at(-1)!;
  expect(new URL(authorize).searchParams.get("code_challenge_method")).toBe("S256");
  first.s.close();
  const back = await w.issuer.browse(authorize);
  const second = page(b, back.href);
  await second.s.start();
  expect(second.href()).toBe(`${ORIGIN}/`);
  expect(b.tab.m.size).toBe(0);
  return second;
}

async function signedInDesktop() {
  const d = await desktop(w);
  cleanup.push(() => d.srt.close());
  await connected(d.sh);
  return d;
}

/** Links by matching codes and approves on the desktop's prompt. */
async function linkTo(s: WebSession<Shown>, d: Awaited<ReturnType<typeof signedInDesktop>>) {
  await until(() => {
    const p = s.phase.get();
    return p.s === "link" && p.desktops !== null && p.desktops.length > 0;
  }, 8000, "desktops to link");
  const p = s.phase.get() as Extract<ReturnType<typeof s.phase.get>, { s: "link" }>;
  const before = d.sh.prompts.length;
  const linking = s.link(p.desktops![0]!);
  await until(() => d.sh.prompts.length > before, 5000, "link prompt");
  const prompt = d.sh.prompts.at(-1)!;
  expect(prompt.platform).toBe("web");
  expect(prompt.name).toBe("Chrome on macOS");
  const shown = s.phase.get();
  expect(shown.s === "link" && shown.step.k === "linking" && shown.step.code).toBe(prompt.code);
  await d.sh.c.call("devices.link.decide", { request_id: prompt.request_id, approve: true });
  await linking;
  return p.desktops![0]!.device_id;
}

const app = (s: WebSession<Shown>) => {
  const p = s.phase.get();
  if (p.s !== "ready") throw new Error(`not ready: ${p.s}`);
  return p.app.client;
};

describe("the web session (§9.9)", () => {
  test("signs in by redirect, links by code, opens the desktop, and comes back after a reload", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const b = browser();
    const one = await signIn(b);
    const deskId = await linkTo(one.s, d);
    await phaseIs(one.s, "ready");
    await until(() => app(one.s).connected, 5000, "app connected");
    expect(app(one.s).may("tasks.create")).toBe(false);
    expect(app(one.s).may("tasks.list")).toBe(true);
    const deviceId = one.s.deviceId;
    expect(one.s.desktops.get().map((x) => x.device_id)).toEqual([deskId]);
    one.s.close();

    // A reload: the vault resumes the session, the same device opens the same desktop.
    const two = page(b);
    await two.s.start();
    await phaseIs(two.s, "ready");
    expect(two.s.deviceId).toBe(deviceId);
    await until(() => app(two.s).connected, 5000, "app connected again");

    // Signing out keeps the link; the next visit is signed out.
    await two.s.signOut();
    expect(two.s.phase.get().s).toBe("signed_out");
    expect(await new TokenVault(b.kv).load()).toBeNull();
    const three = page(b);
    await three.s.start();
    expect(three.s.phase.get().s).toBe("signed_out");
  }, 30_000);

  test("unlinking the last desktop starts again as a new device, still signed in", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const b = browser();
    const one = await signIn(b);
    await linkTo(one.s, d);
    await phaseIs(one.s, "ready");
    const first = one.s.deviceId;
    await one.s.unlink((one.s.phase.get() as { desktopId: string }).desktopId);
    await until(() => {
      const p = one.s.phase.get();
      return p.s === "link" && p.notice === "This browser was unlinked." && p.desktops !== null;
    }, 8000, "link again");
    expect(one.s.deviceId).not.toBe(first);
    expect(b.local.m.has("homerun.desktop")).toBe(false);
  }, 30_000);

  test("the desktop unlinking this browser starts it again as a new device", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const b = browser();
    const one = await signIn(b);
    await linkTo(one.s, d);
    await phaseIs(one.s, "ready");
    const first = one.s.deviceId!;
    await d.sh.c.call("devices.unpair", { device_id: first });
    await until(() => {
      const p = one.s.phase.get();
      return p.s === "link" && p.notice === "This browser was unlinked.";
    }, 8000, "unlinked notice");
    expect(one.s.deviceId).not.toBe(first);
  }, 30_000);

  test("a different person signing in on this browser gets a new device", async () => {
    newUser(w, "ada");
    const d = await signedInDesktop();
    const b = browser();
    const one = await signIn(b);
    await linkTo(one.s, d);
    await phaseIs(one.s, "ready");
    const ada = one.s.deviceId;
    await one.s.signOut();
    one.s.close();

    newUser(w, "bob");
    const two = await signIn(b);
    await phaseIs(two.s, "link");
    expect(two.s.deviceId).not.toBe(ada);
    expect(two.s.desktops.get()).toEqual([]);
  }, 30_000);

  test("an ended session is signed out, with a notice", async () => {
    newUser(w);
    const b = browser();
    await new TokenVault(b.kv).save({ refreshToken: "not-a-refresh-token", subject: null });
    const one = page(b);
    await one.s.start();
    expect(one.s.phase.get()).toEqual({ s: "signed_out", notice: "Your session ended. Sign in again.", tone: "warn" });
    expect(await new TokenVault(b.kv).load()).toBeNull();
  });

  test("a callback without its sign-in is refused", async () => {
    const one = page(browser(), `${ORIGIN}${CALLBACK_PATH}?code=x&state=y`);
    await one.s.start();
    expect(one.s.phase.get()).toEqual({ s: "signed_out", notice: "That sign-in had expired. Sign in again.", tone: "warn" });
    expect(one.href()).toBe(`${ORIGIN}/`);
  });

  test("deleting the account signs out and says what happened", async () => {
    newUser(w);
    const d = await signedInDesktop();
    const b = browser();
    const one = await signIn(b);
    await linkTo(one.s, d);
    await phaseIs(one.s, "ready");
    await one.s.deleteAccount();
    const p = one.s.phase.get();
    expect(p.s).toBe("signed_out");
    expect(p.s === "signed_out" && p.tone).toBe("info");
    expect(await new TokenVault(b.kv).load()).toBeNull();
    expect(b.local.m.has("homerun.desktop")).toBe(false);
  }, 30_000);
});
