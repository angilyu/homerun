import { expect, type APIRequestContext, type Page, test } from "@playwright/test";

/**
 * Remote access (§10) through the production Settings view, all local: the runtime signs in
 * against a local OIDC issuer when the bridge "opens the browser", connects to the relay's Bun
 * adapter, and a reference-client iPhone scans the QR code the page shows (§9.6), is listed,
 * and is unpaired. The native link prompt and a real browser are manual checks
 * (apps/desktop/README.md).
 */

async function signIn(page: Page, request: APIRequestContext, trustTestAttest: boolean) {
  const r = await request.post("/__e2e/scene", { data: { mode: "fake", remote: true, trustTestAttest } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/");
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Remote access" });
  await section.getByRole("button", { name: "Sign in" }).click();
  await expect(section.getByText(/Signed in as ada@example.com/)).toBeVisible();
  await expect(section.locator("[data-relay]")).toHaveText("Connected");
  return section;
}

async function pairByQr(section: ReturnType<Page["getByRole"]>, request: APIRequestContext) {
  await section.getByRole("button", { name: "Pair a phone" }).click();
  const panel = section.getByRole("dialog", { name: "Pair a phone" });
  await expect(panel.getByRole("img", { name: "Pairing QR code" })).toBeVisible();
  await expect(panel.getByRole("timer")).toHaveText(/^Expires in [45]:\d\d$/);
  const scan = await request.post("/__e2e/remote/scan", { data: { name: "Ada's iPhone" } });
  expect(scan.ok(), await scan.text()).toBe(true);
  await expect(panel.getByText("Paired with Ada's iPhone.")).toBeVisible();
  await panel.getByRole("button", { name: "Done" }).click();
  const devices = section.getByRole("group", { name: "Paired devices" });
  return { devices, row: devices.getByRole("listitem").filter({ hasText: "Ada's iPhone" }) };
}

test("sign in, pair an iPhone this Mac can't verify by QR, see it online, unpair it, sign out", async ({ page, request }) => {
  // The relay vouches for the phone's App Attest, this Mac (Apple's root only) can't: it pairs,
  // with a browser's authority, rather than being refused (§18 row 102).
  const section = await signIn(page, request, false);
  const browsed = (await (await request.get("/__e2e/remote/browsed")).json()) as { browsed: string[] };
  expect(browsed.browsed).toHaveLength(1);
  expect(browsed.browsed[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize$/);

  const { devices, row } = await pairByQr(section, request);
  await expect(row.locator(".badge")).toHaveText("Unverified iPhone");
  await expect(row).toContainText("Online");
  await row.getByRole("button", { name: "Unpair" }).click();
  await row.getByRole("group").getByRole("button", { name: "Unpair" }).click();
  await expect(devices.getByText("No phones or browsers are paired.")).toBeVisible();

  await section.getByRole("button", { name: "Sign out" }).click();
  await section.getByRole("group", { name: /^Sign out\?/ }).getByRole("button", { name: "Sign out" }).click();
  await expect(section.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("an iPhone attested by a root this Mac trusts pairs as a verified iPhone", async ({ page, request }) => {
  const section = await signIn(page, request, true);
  const { row } = await pairByQr(section, request);
  await expect(row.locator(".badge")).toHaveText("iPhone");
  await expect(row).toContainText("Online");
});
