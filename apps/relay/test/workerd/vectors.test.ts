import { afterAll, beforeAll, expect, test } from "bun:test";
import { startWorkerd } from "./host";

let host: Awaited<ReturnType<typeof startWorkerd>>;
beforeAll(async () => {
  host = await startWorkerd({}, "test/workerd/wrangler.vectors.jsonc");
}, 60_000);
afterAll(async () => {
  await host?.stop();
});

test("every protocol vector passes inside workerd", async () => {
  const results = (await (await fetch(host.url)).json()) as { file: string; name: string; ok: boolean; error?: string }[];
  expect(results.length).toBeGreaterThan(50);
  expect(results.filter((r) => !r.ok)).toEqual([]);
});
