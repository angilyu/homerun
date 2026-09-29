import { expect, test, type Page } from "@playwright/test";
import { finishScene, replayScene, send } from "./support";

/**
 * The views against a real `homerund serve` and the real bundled `claude`, replaying homerund's
 * recorded cassettes (§16.2): no key, no network, no spend. The prompts and task specs are the
 * cassettes' own (apps/homerund/test/replay/scenarios.test.ts), so they replay unchanged.
 */
test.afterEach(async ({ request }) => {
  await finishScene(request);
});

const done = (page: Page) => expect(page.getByRole("log").getByText(/^Done · /)).toBeVisible({ timeout: 60_000 });

async function openTaskThread(page: Page, name: string): Promise<void> {
  await page.getByRole("navigation").getByRole("button", { name: new RegExp(`^${name}`) }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("text-chat: a new chat streams claude's answer", async ({ page, request }) => {
  await replayScene(page, request, "text-chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await send(page, "In two short sentences, what is a home run in baseball? Do not use any tools.");
  await expect(page.getByRole("log").locator("[aria-busy=true]")).toBeVisible({ timeout: 30_000 });
  await done(page);
  await expect(page.getByRole("log")).toContainText(/ball|bases|hit/i);
});

test("ask-user-question: the question card's answer reaches the model", async ({ page, request }) => {
  const scene = await replayScene(page, request, "ask-user-question");
  await openTaskThread(page, scene.task_name!);
  await send(page, "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options: Blue and Green. Then reply with only the colour I chose.");
  const question = page.getByRole("region", { name: "Question from Claude" });
  await question.getByRole("radio", { name: /Green/ }).check({ timeout: 60_000 });
  await question.getByRole("button", { name: "Send answer" }).click();
  await done(page);
  await expect(question).toHaveCount(0);
});

test("approval-defer: allowed once after a held message; both reach the model", async ({ page, request }) => {
  const scene = await replayScene(page, request, "approval-defer");
  await openTaskThread(page, scene.task_name!);
  await send(page, "Run the bash command `echo approved >> side.log` exactly once, then reply with just the word done.");
  const approval = page.getByRole("region", { name: "Approve Bash" });
  await expect(approval).toContainText("echo approved >> side.log", { timeout: 60_000 });
  // A redirect is approved one call at a time, never always (§5.5).
  await expect(approval.getByRole("button", { name: "Always allow…" })).toHaveCount(0);
  await send(page, "After that, also reply with the word held.", "either");
  await expect(page.getByRole("log").getByText(/Held until you answer/)).toBeVisible();
  await approval.getByRole("button", { name: "Allow once" }).click();
  await done(page);
  await expect(page.getByRole("log").getByText(/Held until you answer|Not delivered/)).toHaveCount(0);
});
