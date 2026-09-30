import { expect, test, type APIRequestContext } from "@playwright/test";
import { fakeScene } from "./support";

/**
 * Command-line access (§5.2) through the production Settings view: `homerun login` asks, the
 * bridge's stand-in for the shell's prompt answers, and the token then shows in Settings, where
 * Revoke signs it out. The real NSAlert is a manual check (apps/desktop/README.md).
 */
type CliResult = { code: number; stdout: string; stderr: string };

async function post<T>(request: APIRequestContext, path: string, data: unknown = {}): Promise<T> {
  const r = await request.post(path, { data });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()) as T;
}

async function prompt(request: APIRequestContext): Promise<{ request_id: string; hostname: string; client: { name: string } }> {
  let got: Array<{ request_id: string; hostname: string; client: { name: string } }> = [];
  await expect
    .poll(async () => {
      const r = (await (await request.get("/__e2e/cli/prompts")).json()) as { prompts: typeof got; exited: { code: number; stderr: string } | null };
      if (r.exited) throw new Error(`the CLI exited ${r.exited.code} before it asked: ${r.exited.stderr}`);
      got = r.prompts;
      return got.length;
    })
    .toBe(1);
  return got[0]!;
}

const cli = async (request: APIRequestContext, args: string[]) => {
  await post(request, "/__e2e/cli/start", { args });
  return post<CliResult>(request, "/__e2e/cli/wait");
};

test("login is approved from the app's prompt, shows in Settings, and Revoke signs it out", async ({ page, request }) => {
  await fakeScene(page, request);
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const section = page.getByRole("region", { name: "Command-line access" });
  await expect(section.getByText("No command-line clients are signed in.")).toBeVisible();
  // Not in an app bundle: the shell explains, and there is nothing to install.
  await expect(section.getByText(/this is a development build/)).toBeVisible();
  await expect(section.getByRole("button", { name: "Install command-line tool" })).toHaveCount(0);

  // Don't Allow first: the CLI is refused and stores nothing.
  await post(request, "/__e2e/cli/start", { args: ["login"] });
  const denied = await prompt(request);
  expect(denied.client.name).toBe("homerun-cli");
  await post(request, "/__e2e/cli/answer", { request_id: denied.request_id, allow: false });
  const d = await post<CliResult>(request, "/__e2e/cli/wait");
  expect(d.code, d.stderr).toBe(77);

  await post(request, "/__e2e/cli/start", { args: ["login"] });
  const req = await prompt(request);
  await post(request, "/__e2e/cli/answer", { request_id: req.request_id, allow: true });
  const ok = await post<CliResult>(request, "/__e2e/cli/wait");
  expect(ok.code, ok.stderr).toBe(0);
  expect((await cli(request, ["status"])).code).toBe(0);

  // Settings re-reads on focus; a reload is the simplest way here.
  await page.reload();
  await page.getByRole("navigation").getByRole("button", { name: "Settings" }).click();
  const row = section.getByRole("listitem").filter({ hasText: `on ${req.hostname}` });
  await expect(row).toContainText("homerun-cli");
  await expect(row).toContainText(/used/);
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("group").getByRole("button", { name: "Revoke" }).click();
  await expect(section.getByText("No command-line clients are signed in.")).toBeVisible();

  const after = await cli(request, ["status"]);
  expect(after.code).toBe(77);
  expect(after.stderr).toContain("access was revoked in the Homerun app");
});
