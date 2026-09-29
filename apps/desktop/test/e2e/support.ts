import { expect, type APIRequestContext, type Page } from "@playwright/test";

export interface SceneInfo {
  work: string;
  task_id?: string;
  thread_id?: string;
  task_name?: string;
}

/** Start a fresh runtime behind the bridge, then load the app. `key: null` starts with no key. */
export async function fakeScene(page: Page, request: APIRequestContext, o: { key?: string | null } = {}): Promise<SceneInfo> {
  const r = await request.post("/__e2e/scene", { data: { mode: "fake", ...o } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/");
  return (await r.json()) as SceneInfo;
}

export async function replayScene(page: Page, request: APIRequestContext, scenario: string): Promise<SceneInfo> {
  const r = await request.post("/__e2e/scene", { data: { mode: "replay", scenario } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/");
  return (await r.json()) as SceneInfo;
}

/** Replay only: every cassette entry was used, and nothing unexpected was asked of the API. */
export async function finishScene(request: APIRequestContext): Promise<void> {
  const r = await request.post("/__e2e/finish");
  expect(((await r.json()) as { errors: string[] }).errors).toEqual([]);
}

/** Type into the composer and send; its button reads "Steer" while a run is active (§5.7). */
export async function send(page: Page, text: string, button: "Send" | "Steer" | "either" = "Send"): Promise<void> {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.getByRole("button", { name: button === "either" ? /^(Send|Steer)$/ : button, exact: button !== "either" }).click();
}
