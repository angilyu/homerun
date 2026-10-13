import { expect, test, type APIRequestContext } from "@playwright/test";
import { fakeScene } from "./support";

/**
 * §11 against a real homerund behind the bridge: a signed version policy published to the
 * runtime's (fake) relay raises the banner and clears it again, and Settings builds a diagnostic
 * bundle after showing what goes in it. The real save panel and Finder are manual checks
 * (apps/desktop/README.md).
 */
async function publish(request: APIRequestContext, rules: unknown[] | null): Promise<void> {
  const r = await request.post("/__e2e/version-policy", { data: { rules } });
  expect(r.ok(), await r.text()).toBe(true);
}

/** The bridge signs it with the test release key, for the runtime's own platform. */
const rule = (o: Record<string, unknown>) => ({ channel: "*", ...o });

test("a signed policy above this version shows the banner; a newer one that allows it clears it", async ({ page, request }) => {
  await fakeScene(page, request);
  await expect(page.getByRole("navigation")).toBeVisible();
  const banner = page.getByRole("alert", { name: "Update required" });
  await expect(banner).toHaveCount(0);

  await publish(request, [rule({ min_version: "2.0.0", message: "This version can repeat scheduled tasks." })]);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("This version can repeat scheduled tasks.");
  // The bridge's updater is unavailable, so the button downloads instead.
  await expect(banner.getByRole("button", { name: "Download update" })).toBeVisible();

  await publish(request, [rule({ min_version: "1.0.0" })]);
  await expect(banner).toHaveCount(0);
});

test("a kill that includes chat says chat is paused too", async ({ page, request }) => {
  await fakeScene(page, request);
  await publish(request, [rule({ min_version: "1.0.0", kill: ["*"], kill_interactive: true })]);
  await expect(page.getByRole("alert", { name: "Update required" })).toContainText("Chat is paused too.");
});

test("Settings shows the bundle's files, saves it, and offers Show in Finder", async ({ page, request }) => {
  await fakeScene(page, request);
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Diagnostics" });
  // The scene's runtime has a crash-report endpoint, so the opt-in is offered, unticked.
  await expect(section.getByRole("checkbox", { name: "Send crash reports" })).not.toBeChecked();

  await section.getByRole("button", { name: "Create diagnostic bundle…" }).click();
  const list = section.getByRole("group", { name: "Bundle contents" });
  await expect(list).toBeVisible();
  for (const name of ["versions.json", "version-policy.json", "database.json", "scheduler.json", "relay.json"]) await expect(list.getByText(name, { exact: true })).toBeVisible();

  await list.getByRole("button", { name: "Save to Downloads" }).click();
  const saved = section.getByRole("status");
  await expect(saved).toContainText(/Saved homerun-diagnostics-\d{8}-\d{6}\.zip/);
  await saved.getByRole("button", { name: /Show in (Finder|Explorer)/ }).click();
  await expect
    .poll(async () => ((await (await request.get("/__e2e/diagnostics")).json()) as { bundle: string | null; revealed: string[] }).revealed.length)
    .toBe(1);
  const { bundle } = (await (await request.get("/__e2e/diagnostics")).json()) as { bundle: string };
  // In the scene's home (Downloads, or the home itself without one), never the real Downloads.
  expect(bundle).toMatch(/hr-rpc-[^\\/]+[\\/](Downloads[\\/])?homerun-diagnostics-[^\\/]+\.zip$/);
});
