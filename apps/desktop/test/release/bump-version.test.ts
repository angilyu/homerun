import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PLACES, current, parseVersion, readAll, setAll } from "../../scripts/release/bump-version";

const repo = resolve(import.meta.dir, "../../../..");

function copyRepoFiles(): string {
  const root = mkdtempSync(join(tmpdir(), "homerun-version-"));
  for (const f of new Set(PLACES.map((p) => p.file))) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    cpSync(join(repo, f), join(root, f));
  }
  return root;
}

describe("bump-version", () => {
  test("the repository's files agree", () => {
    expect(parseVersion(current(repo))).not.toBeNull();
  });

  test("parses versions and v-tags", () => {
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseVersion("0.10.0-beta.2")).toBe("0.10.0-beta.2");
    for (const bad of ["1.2", "01.2.3", "v1.2.3.4", "1.2.3+build", "latest", "vv1.2.3", ""]) expect(parseVersion(bad)).toBeNull();
  });

  test("sets every place and nothing else", () => {
    const root = copyRepoFiles();
    const before = new Map([...new Set(PLACES.map((p) => p.file))].map((f) => [f, readFileSync(join(root, f), "utf8")]));
    setAll(root, "7.8.9-rc.1");
    expect(readAll(root).map((x) => x.version)).toEqual(PLACES.map(() => "7.8.9-rc.1"));
    for (const [f, text] of before) {
      const after = readFileSync(join(root, f), "utf8");
      const changed = after.split("\n").filter((line, i) => line !== text.split("\n")[i]);
      expect(changed.length).toBe(f.endsWith("Cargo.lock") ? 2 : 1);
      expect(changed.every((line) => line.includes("7.8.9-rc.1"))).toBe(true);
    }
    // Only the shell's own lock entries move, not a dependency that happens to share the number.
    expect(readFileSync(join(root, "apps/desktop/src-tauri/Cargo.lock"), "utf8").match(/7\.8\.9-rc\.1/g)?.length).toBe(2);
  });

  test("names the file that disagrees", () => {
    const root = copyRepoFiles();
    setAll(root, "1.0.0");
    const f = join(root, "apps/desktop/package.json");
    writeFileSync(f, readFileSync(f, "utf8").replace('"version": "1.0.0"', '"version": "1.0.1"'));
    expect(() => current(root)).toThrow("apps/desktop/package.json 1.0.1");
  });

  test("refuses a version that isn't semver", () => {
    expect(() => setAll(copyRepoFiles(), "v1.0.0")).toThrow("not a semantic version");
  });
});
