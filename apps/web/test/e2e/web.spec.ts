import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * The web client end to end (§9.9): the production bundle under its own CSP, signed in with the
 * local issuer by redirect (PKCE), linked to a real desktop by the 6-digit code, chatting over the
 * relay with a browser's reduced authority. server.ts plays the desktop's person for the prompt.
 */

interface Scene {
  task_name: string;
  thread_id: string;
}

/** Records CSP and Trusted Types violations, and console errors, for the whole page's life. */
async function watch(page: Page): Promise<{ violations: () => Promise<string[]>; errors: string[] }> {
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => w.__violations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}:${e.columnNumber} ${e.sample}`));
  });
  return { errors, violations: () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations) };
}

async function scene(request: APIRequestContext): Promise<Scene> {
  const r = await request.post("/__e2e/scene");
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as Scene;
}

/** Signs in through the issuer and links to the scene's desktop by its code. */
async function signInAndLink(page: Page, request: APIRequestContext): Promise<void> {
  const res = await page.goto("/");
  expect(res?.headers()["content-security-policy"]).toContain("require-trusted-types-for 'script'");
  await expect(page.getByRole("heading", { name: "Homerun on the web" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  // Back from the issuer on /auth/callback, then the address is "/" again.
  await expect(page.getByRole("heading", { name: "Link this browser" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
  await page.getByRole("list", { name: "Your computers" }).getByRole("button").first().click();
  const code = page.getByLabel("Link code");
  await expect(code).toHaveText(/^\d{3} \d{3}$/);
  const shown = (await code.textContent())!.replace(" ", "");
  const decided = (await (await request.post("/__e2e/link", { data: { approve: true } })).json()) as { code: string; name: string; platform: string };
  expect(decided.platform).toBe("web");
  expect(decided.name).toMatch(/^Chrome on /);
  expect(shown).toBe(decided.code);
  await expect(page.getByRole("navigation")).toBeVisible();
}

async function send(page: Page, text: string, button: "Send" | "Steer" = "Send"): Promise<void> {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: button, exact: true }).click();
}

test("signs in by redirect, links by code, chats and steers; approvals stay on a phone or Mac", async ({ page, request }) => {
  const seen = await watch(page);
  const { task_name } = await scene(request);
  await signInAndLink(page, request);

  // A new chat: streamed, steered and stopped, over the relay.
  await page.getByRole("button", { name: "New chat" }).click();
  await send(page, "Say hi");
  const log = page.getByRole("log");
  await expect(page.locator("[aria-busy=true]").filter({ hasText: "Hello!" })).toBeVisible();
  await send(page, "and then stop", "Steer");
  await expect(log.getByText("Sent to the running task")).toBeVisible();
  await expect(page.locator("[aria-busy=true]").filter({ hasText: 'said "and then stop"' })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(log.getByText(/Stopped/)).toBeVisible({ timeout: 15_000 });

  // A question can be answered here.
  await page.getByRole("region", { name: "Recent" }).getByRole("button", { name: new RegExp(`^${task_name}`) }).click();
  await send(page, "ask me");
  const question = page.getByRole("region", { name: "Question from Claude" });
  await question.getByRole("radio", { name: "Blue" }).check();
  await question.getByRole("button", { name: "Send answer" }).click();
  await expect(log.getByText("You chose Blue.")).toBeVisible();

  // An approval can't: it says where to answer, and offers no buttons (§9.9).
  await send(page, "run the tests");
  const approval = page.getByRole("region", { name: "Approve Bash" });
  await expect(approval.getByRole("note")).toHaveText("Approve on your phone or Mac");
  await expect(approval.getByRole("button")).toHaveCount(0);

  // A browser doesn't create tasks.
  await page.getByRole("navigation").getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);

  // The device keys and the vault key can't be read out of the page.
  const keys = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open("homerun");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    const all = (area: string) =>
      new Promise<unknown[]>((ok, no) => {
        const r = db.transaction(area).objectStore(area).getAll();
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
      });
    const found = [...(await all("keys")), ...(await all("vault"))].flatMap((v) => (v instanceof CryptoKey ? [v] : v && typeof v === "object" ? Object.values(v).filter((x) => x instanceof CryptoKey) : []));
    return found.map((k) => ({ type: k.type, extractable: k.extractable, alg: k.algorithm.name }));
  });
  // A public key is always extractable; every private and secret key must not be.
  const held = keys.filter((k) => k.type !== "public");
  expect(held.filter((k) => k.type === "private").length).toBeGreaterThanOrEqual(1);
  expect(held.filter((k) => k.type === "secret").map((k) => k.alg)).toEqual(["AES-GCM"]);
  expect(held.every((k) => !k.extractable)).toBe(true);

  // A reload resumes: no sign-in, no linking, the same chats.
  await page.reload();
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^Say hi/ })).toBeVisible();

  expect(await seen.violations()).toEqual([]);
  expect(seen.errors.filter((e) => /Content Security Policy|TrustedHTML|TrustedScript/i.test(e))).toEqual([]);
});

test("Settings: this browser's computers, unlinking, signing out and deleting the account", async ({ page, request }) => {
  const seen = await watch(page);
  await scene(request);
  await signInAndLink(page, request);
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const here = page.getByRole("region", { name: "This browser" });
  await expect(here).toContainText(/Signed in as ada@example\.com/);
  const computers = here.getByRole("group", { name: "Computers" });
  await expect(computers.getByRole("listitem")).toHaveCount(1);

  // Unlinking the only computer starts again as a new device, still signed in.
  await computers.getByRole("button", { name: "Unlink" }).click();
  await page.getByRole("group", { name: /^Unlink it\?/ }).getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByRole("heading", { name: "Link this browser" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "This browser was unlinked." })).toBeVisible();

  // Linked again, then signed out: the next visit asks to sign in, and comes back linked.
  await page.getByRole("list", { name: "Your computers" }).getByRole("button").first().click();
  await expect(page.getByLabel("Link code")).toBeVisible();
  await request.post("/__e2e/link", { data: { approve: true } });
  await expect(page.getByRole("navigation")).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await here.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("group", { name: /^Sign out\?/ }).getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Homerun on the web" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();

  // Deleting the account: everything goes, and it says so.
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  await here.getByRole("button", { name: "Delete account" }).click();
  await page.getByRole("group", { name: /^Delete your account\?/ }).getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByRole("heading", { name: "Homerun on the web" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(/deleted/i);

  expect(await seen.violations()).toEqual([]);
});

test("the security headers are on every page and asset", async ({ request }) => {
  for (const path of ["/", "/auth/callback"]) {
    const r = await request.get(path);
    const h = r.headers();
    expect(h["content-security-policy"]).toMatch(/default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["cache-control"]).toMatch(/no-(cache|store)/);
  }
  const html = await (await request.get("/")).text();
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)![1]!;
  expect((await request.get(asset)).headers()["cache-control"]).toContain("immutable");
  expect((await request.get("/_headers")).status()).toBe(404);
});
