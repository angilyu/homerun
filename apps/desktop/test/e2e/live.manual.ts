import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { send } from "./support";

/**
 * The manual real-key check (apps/desktop/README.md): the production views over the bridge, a real
 * `homerund serve`, the real bundled `claude` and the real API, with the key from `.env.local`.
 * Never in CI: it needs a key and spends money, so the bridge caps the spend (bridge-server.ts
 * `MeteredProxy`) and this file only runs with playwright.live.config.ts. Screenshots go to
 * HOMERUN_E2E_SHOTS. The key is typed into a password field and never printed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const SHOTS = process.env.HOMERUN_E2E_SHOTS ?? join(HERE, "results", "live");

function envKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const p = join(ROOT, ".env.local");
  if (!existsSync(p)) return null;
  const m = /^\s*ANTHROPIC_API_KEY\s*=\s*"?([^"\n]+)"?\s*$/m.exec(readFileSync(p, "utf8"));
  return m ? m[1]!.trim() : null;
}

let n = 0;
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${String(++n).padStart(2, "0")}-${name}.png`) });
}

interface LiveInfo {
  pid: number | null;
  restarts: number;
  usd: number;
  requests: number;
  refused: number;
  by_model: Record<string, number>;
  threads: Array<{ thread_id: string; seqs: number[] }>;
}
async function info(request: APIRequestContext): Promise<LiveInfo> {
  return (await (await request.get("/__e2e/live")).json()) as LiveInfo;
}

/** The streaming message's text length, or -1 when nothing streams. Never waits, unlike `innerText()`. */
const streamingLength = (page: Page) => page.evaluate(() => document.querySelector("[role=log] [aria-busy=true]")?.textContent?.length ?? -1);

const done = (page: Page, count: number) => expect(page.getByRole("log").getByText(/^Done · /)).toHaveCount(count, { timeout: 90_000 });

test.setTimeout(600_000);

test("the real API: onboarding, streaming, approvals and a grant, a question, a runtime crash", async ({ page, request }) => {
  const key = envKey();
  test.skip(!key, "needs ANTHROPIC_API_KEY in .env.local");
  const r = await request.post("/__e2e/scene", { data: { mode: "live" } });
  expect(r.ok(), await r.text()).toBe(true);
  const { work } = (await r.json()) as { work: string };
  await page.goto("/");

  await test.step("onboarding: a wrong key is refused by the real API, then the real key is accepted (§7.2)", async () => {
    await expect(page.getByRole("heading", { name: "Connect your Anthropic API key" })).toBeVisible();
    await shot(page, "onboarding");
    const field = page.getByLabel("API key");
    const junk = Array.from(crypto.getRandomValues(new Uint8Array(70)), (b) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[b % 62]).join("");
    await field.fill(`sk-ant-api03-${junk}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("alert")).toContainText("didn't accept this key", { timeout: 20_000 });
    await shot(page, "wrong-key-rejected");
    await field.fill(key!);
    await page.getByRole("button", { name: "Connect" }).click();
    await expect(page.getByRole("navigation")).toBeVisible({ timeout: 20_000 });
    await shot(page, "key-accepted");
  });

  // Everything after onboarding is on one task thread, so each turn reuses the prompt cache: a
  // fresh thread costs about $0.02 on Haiku, a cached turn a fraction of that.
  await test.step("a task, and a short chat on its thread that streams on Haiku (§5.3)", async () => {
    await page.getByRole("navigation").getByRole("button", { name: "Tasks" }).click();
    await page.getByRole("button", { name: "New task" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Live check");
    await page.getByLabel("Instructions").fill("You work in the given folder. Run shell commands with Bash exactly as asked.");
    await page.getByLabel(/Folders it may use/).fill(work);
    await page.getByRole("checkbox", { name: /^Bash/ }).check();
    await page.getByRole("checkbox", { name: /^AskUserQuestion/ }).check();
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByRole("heading", { name: "Live check", level: 1 })).toBeVisible();
    await page.getByRole("region", { name: "Chats" }).getByRole("button", { name: "Live check" }).click();

    // Every text length the streaming message shows, recorded in the page as it renders.
    await page.evaluate(() => {
      const w = window as unknown as { __lengths: number[] };
      w.__lengths = [];
      new MutationObserver(() => {
        const n = document.querySelector("[role=log] [aria-busy=true]")?.textContent?.length;
        if (n) w.__lengths.push(n);
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await send(page, "In about 120 words, describe a lighthouse at dusk. Do not use any tools.");
    for (let i = 0; i < 3000; i++) {
      if ((await streamingLength(page)) > 150) {
        await shot(page, "chat-streaming");
        break;
      }
      await page.waitForTimeout(10);
    }
    await done(page, 1);
    const lengths = new Set(await page.evaluate(() => (window as unknown as { __lengths: number[] }).__lengths));
    expect(lengths.size, "partial renders while streaming").toBeGreaterThanOrEqual(3);
    await shot(page, "chat-done");
  });

  await test.step("approvals: Allow once, then Always allow with an edited pattern (§5.5, §5.6)", async () => {
    await send(page, `Run exactly this Bash command, with no cd and nothing else: touch ${work}/live-1.txt — then reply with just the word done.`);
    const approval = page.getByRole("region", { name: "Approve Bash" });
    await expect(approval).toContainText("live-1.txt", { timeout: 60_000 });
    await shot(page, "approval");
    await approval.getByRole("button", { name: "Allow once" }).click();
    await done(page, 2);
    expect(existsSync(join(work, "live-1.txt")), "the allowed command ran").toBe(true);
    await shot(page, "approval-allowed-once");

    await send(page, `Now run exactly this Bash command, with no cd and nothing else: touch ${work}/live-2.txt — then reply with just the word done.`);
    await expect(approval).toContainText("live-2.txt", { timeout: 60_000 });
    await approval.getByRole("button", { name: "Always allow…" }).click();
    const pattern = approval.getByLabel(/Command pattern/);
    await expect(pattern).toHaveValue(`touch ${work}/live-2.txt`);
    await shot(page, "always-allow-suggested");
    await pattern.fill(`touch ${work}/live-*`);
    await expect(approval.getByText(/doesn't cover the call/)).toHaveCount(0);
    await shot(page, "always-allow-edited");
    await approval.getByRole("button", { name: "Save and allow" }).click();
    await done(page, 3);
    expect(existsSync(join(work, "live-2.txt")), "the granted command ran").toBe(true);
    await expect(approval).toHaveCount(0);

    await page.getByRole("button", { name: "Task: Live check" }).click();
    const grants = page.getByRole("region", { name: "Always allowed" });
    await expect(grants.getByText(`Bash · touch ${work}/live-*`)).toBeVisible();
    await shot(page, "grant-listed");
    await grants.getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("group", { name: "Ask again next time?" }).getByRole("button", { name: "Revoke" }).click();
    await expect(grants.getByText(`Bash · touch ${work}/live-*`)).toHaveCount(0);
    await shot(page, "grant-revoked");
  });

  await test.step("a question from AskUserQuestion, answered in the card (§5.6)", async () => {
    await page.getByRole("region", { name: "Chats" }).getByRole("button", { name: "Live check" }).click();
    await send(page, "Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly three options: Red, Green and Blue. Then reply with only the colour I chose.");
    const question = page.getByRole("region", { name: "Question from Claude" });
    await expect(question.getByRole("radio", { name: /Green/ })).toBeVisible({ timeout: 60_000 });
    await shot(page, "question");
    await question.getByRole("radio", { name: /Green/ }).check();
    await question.getByRole("button", { name: "Send answer" }).click();
    await done(page, 4);
    await expect(question).toHaveCount(0);
    await expect(page.getByRole("log").locator(".msg.assistant").last()).toContainText(/green/i);
    await shot(page, "question-answered");
  });

  await test.step("kill -9 homerund mid-stream: the banner, a restart, and a thread with no gap or duplicate (§5.1, §5.4)", async () => {
    await send(page, "Write a story of about 150 words about a lighthouse keeper and a storm. Do not use any tools.");
    const log = page.getByRole("log");
    const streaming = log.locator("[aria-busy=true]");
    await expect(streaming).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => streamingLength(page), { timeout: 30_000 }).toBeGreaterThan(80);
    const before = await info(request);
    process.kill(before.pid!, "SIGKILL");
    const banner = page.getByRole("status").filter({ hasText: "Homerun stopped unexpectedly and is restarting." });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await shot(page, "crash-banner");
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await info(request)).restarts).toBe(1);
    // The interrupted run is resumed or ended (§5.4); either way the thread settles.
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, { timeout: 120_000 });
    await expect(streaming).toHaveCount(0);
    await shot(page, "after-restart");

    // What the live view built (history, events before the kill, then the resubscription on the new
    // connection) matches a fresh load from history alone: nothing missing, nothing twice.
    const live = await log.innerText();
    await page.reload();
    await page.getByRole("navigation").getByRole("button", { name: /^Live check/ }).click();
    await expect(page.getByRole("log")).toContainText("lighthouse", { timeout: 20_000 });
    const fresh = await page.getByRole("log").innerText();
    writeFileSync(join(SHOTS, "thread-live.txt"), live);
    writeFileSync(join(SHOTS, "thread-reloaded.txt"), fresh);
    expect(fresh).toBe(live);
    for (const t of (await info(request)).threads) expect(t.seqs, `seqs of ${t.thread_id}`).toEqual(t.seqs.map((_, i) => t.seqs[0]! + i));
    await shot(page, "after-reload");
  });

  const spend = await info(request);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, "spend.json"), JSON.stringify({ usd: spend.usd, requests: spend.requests, refused: spend.refused, by_model: spend.by_model, restarts: spend.restarts }, null, 2));
  console.log(`live check spend: $${spend.usd.toFixed(4)} over ${spend.requests} requests (${spend.refused} refused)`);
  expect(spend.refused, "no request hit the spend cap").toBe(0);
  await request.post("/__e2e/finish");
});
