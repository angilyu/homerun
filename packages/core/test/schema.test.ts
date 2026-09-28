import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../scripts/gen";
import { namedSchemas } from "../src/index";
import { PKG, loadBundle } from "./helpers";

describe("generated artifacts", () => {
  const files = generate();

  // The snapshot: any change to a schema, allowlist or vector changes these files. Regenerate
  // with `pnpm --filter @homerun/core gen` and review the diff as a protocol change.
  test.each([...files.keys()])("%s is up to date", (path) => {
    expect(readFileSync(join(PKG, path), "utf8")).toBe(files.get(path)!);
  });

  test("every named schema is in the bundle", () => {
    const defs = Object.keys(loadBundle().$defs);
    expect(defs.sort()).toEqual([...namedSchemas().keys()].sort());
  });

  test("bundle refs all resolve", () => {
    const text = files.get("schema/homerun.schema.json")!;
    const defs = new Set(Object.keys(JSON.parse(text).$defs));
    for (const [, ref] of text.matchAll(/"\$ref": "#\/\$defs\/([^"]+)"/g)) expect(defs.has(ref!)).toBe(true);
    expect(text).not.toMatch(/"\$ref": "(?!#\/\$defs\/)/);
  });
});
