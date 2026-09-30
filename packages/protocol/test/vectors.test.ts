import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERIFIERS, verifyAllVectors } from "../src/vectors/verify";
import { buildAll } from "../src/vectors/build";

const DIR = join(import.meta.dir, "..", "vectors");
const files = Object.fromEntries(readdirSync(DIR).map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8"))]));

describe("every vector file has a verifier", () => {
  test("no unverified files", () => {
    expect(Object.keys(files).sort()).toEqual(Object.keys(VERIFIERS).sort());
  });
});

const results = await verifyAllVectors(files);
for (const file of new Set(results.map((r) => r.file))) {
  describe(file, () => {
    for (const r of results.filter((x) => x.file === file)) {
      test(r.name, () => {
        expect(r.error ?? null).toBeNull();
        expect(r.ok).toBe(true);
      });
    }
  });
}

test("the generator reproduces the committed files", async () => {
  for (const [name, value] of Object.entries(await buildAll())) expect(value).toEqual(files[name]);
});

test("the sealed vectors cover every reject reason but replay-free success", async () => {
  const { SEALED_REJECT_REASONS } = await import("../src/sealed");
  const covered = new Set((files["sealed.json"].open as { expect: { reason?: string } }[]).map((c) => c.expect.reason).filter(Boolean));
  const missing = SEALED_REJECT_REASONS.filter((r) => !covered.has(r) && r !== "too_large");
  expect(missing).toEqual([]);
});
