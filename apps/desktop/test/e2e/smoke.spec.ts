import { expect, test } from "@playwright/test";
import { fakeScene, send } from "./support";

/**
 * The fake-engine smoke test (plan §9): the production views, the bridge in place of the Rust
 * shell, and a real homerund whose engine is scripted (fake-script.ts).
 */
test("onboarding, then a streamed chat that is steered and stopped (§7.2, §5.3, §5.7)", async ({ page, request }) => {
  await fakeScene(page, request, { key: null });
  await expect(page.getByRole("heading", { name: "Connect your Anthropic API key" })).toBeVisible();
  const field = page.getByLabel("API key");
  await expect(field).toHaveAttribute("type", "password");
  await field.fill("sk-ant-e2e-bad-000000000000000");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("alert")).toContainText("didn't accept this key");
  await field.fill("sk-ant-e2e-good-000000000009999");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("navigation")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();
  await send(page, "Say hi");
  // Streaming: the reply grows in place, then settles (§5.3).
  const reply = page.locator("[aria-busy=true]").filter({ hasText: "Hello!" });
  await expect(reply).toBeVisible();
  await send(page, "and then stop", "Steer");
  const log = page.getByRole("log");
  await expect(log.getByText("Sent to the running task")).toBeVisible();
  await expect(log.getByText(/while you watch\./)).toBeVisible({ timeout: 20_000 });
  // The steer was taken as the next turn; stop it partway.
  await expect(page.locator("[aria-busy=true]").filter({ hasText: 'said "and then stop"' })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 15_000 });
  await expect(log.getByText(/Stopped/)).toBeVisible();
  // Titled by its first message in the sidebar; the history survives a reload.
  await page.reload();
  await expect(page.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^Say hi/ })).toBeVisible();
  await page.getByRole("region", { name: "Recent" }).getByRole("button", { name: /^Say hi/ }).click();
  await expect(page.getByRole("heading", { name: "Say hi" })).toBeVisible();
  await expect(log.getByText(/while you watch\./)).toBeVisible();
});

test("a task: approval with an edited Always allow, the grant revoked, a question, a held message (§5.6, §5.7)", async ({ page, request }) => {
  const { work } = await fakeScene(page, request);
  const nav = page.getByRole("navigation");
  await nav.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Repo helper");
  await page.getByLabel("Instructions").fill("Help with the repo.");
  await page.getByLabel(/Folders it may use/).fill(work);
  await page.getByRole("checkbox", { name: /^Bash/ }).check();
  await page.getByRole("checkbox", { name: /^AskUserQuestion/ }).check();
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(page.getByRole("heading", { name: "Repo helper", level: 1 })).toBeVisible();
  await page.getByRole("region", { name: "Chats" }).getByRole("button", { name: "Repo helper" }).click();

  // Approval: Always allow shows the suggested pattern; an edit is checked against the call.
  await send(page, "run the tests");
  const approval = page.getByRole("region", { name: "Approve Bash" });
  await expect(approval).toContainText("npm test -- --silent");
  await approval.getByRole("button", { name: "Always allow…" }).click();
  const pattern = approval.getByLabel(/Command pattern/);
  await pattern.fill("git *");
  await expect(approval.getByText(/doesn't cover the call/)).toBeVisible();
  await pattern.fill("npm test *");
  await approval.getByRole("button", { name: "Save and allow" }).click();
  const log = page.getByRole("log");
  await expect(log.getByText("All 12 tests passed.")).toBeVisible();
  await expect(approval).toHaveCount(0);

  // The grant is on the task page, and can be revoked (§5.6).
  await page.getByRole("button", { name: "Task: Repo helper" }).click();
  const grants = page.getByRole("region", { name: "Always allowed" });
  await expect(grants.getByText("Bash · npm test *")).toBeVisible();
  await grants.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("group", { name: "Ask again next time?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(grants.getByText("Bash · npm test *")).toHaveCount(0);
  await page.getByRole("region", { name: "Chats" }).getByRole("button", { name: "Repo helper" }).click();

  // A question: single choice.
  await send(page, "ask me");
  const question = page.getByRole("region", { name: "Question from Claude" });
  await question.getByRole("radio", { name: "Green" }).check();
  await question.getByRole("button", { name: "Send answer" }).click();
  await expect(log.getByText("You chose Green.")).toBeVisible();

  // Asked again now the grant is gone; a message meanwhile is held, and a stop leaves it undelivered (§5.7).
  await send(page, "run the tests");
  await expect(page.getByRole("region", { name: "Approve Bash" })).toBeVisible();
  await send(page, "also check the docs");
  await expect(log.getByText(/Held until you answer/)).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(log.getByText(/Not delivered/)).toBeVisible({ timeout: 15_000 });
  await expect(log.getByRole("button", { name: "Send again" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Approve Bash" })).toHaveCount(0);
});

test("a monitor: created in the editor, with its next check; paused and resumed (§8)", async ({ page, request }) => {
  await fakeScene(page, request);
  await page.getByRole("navigation").getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New monitor" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Status page");
  await page.getByLabel("What to do when it changes").fill("Tell me what changed.");
  await page.getByLabel("Every (minutes)").fill("30");
  await page.getByLabel("Page URL").fill("https://status.example.com/");
  await page.getByRole("button", { name: "Create monitor" }).click();
  await expect(page.getByRole("heading", { name: "Status page", level: 1 })).toBeVisible();
  const schedule = page.getByRole("region", { name: "Schedule" });
  await expect(schedule).toContainText(/Next check in (29|30) min/);
  await schedule.getByRole("button", { name: "Pause" }).click();
  await expect(schedule.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(schedule).toContainText("No check scheduled.");
  await schedule.getByRole("button", { name: "Resume" }).click();
  await expect(schedule).toContainText(/Next check in/);
  // A reply on the monitor's thread runs with the monitor's tools and instructions (M5 → M7).
  await page.getByRole("region", { name: "Chats" }).getByRole("button", { name: "Status page" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute("placeholder", "Reply to this monitor");
  await send(page, "What are you watching?");
  await expect(page.getByRole("log").getByText(/while you watch\./)).toBeVisible({ timeout: 20_000 });
  // It's listed with its schedule.
  await page.getByRole("navigation").getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: /Status page/ })).toContainText(/Every 30 minutes · next in/);
});
