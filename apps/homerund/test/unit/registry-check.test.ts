import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "..", "..", "..", "..", "scripts", "check-registry.sh");

function check(...args: string[]) {
  const p = Bun.spawnSync(["/bin/bash", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

const entry = (tarball?: string) =>
  `packages:\n\n  zod@3.25.76:\n    resolution: {integrity: sha512-AAAA${tarball ? `, tarball: ${tarball}` : ""}}\n`;

// The repository scripts are bash; they are checked on Linux and macOS, not Windows.
describe.skipIf(process.platform === "win32")("packages resolve from registry.npmjs.org only", () => {
  test("the repository's lockfile and .npmrc pass", () => {
    const r = check();
    expect(r.out).toContain("packages resolve from registry.npmjs.org only");
    expect(r.code).toBe(0);
  });

  test("a private feed or any other registry host in the lockfile or .npmrc fails", () => {
    const d = mkdtempSync(join(tmpdir(), "hr-registry-"));
    try {
      const lock = join(d, "pnpm-lock.yaml");
      const npmrc = join(d, ".npmrc");
      writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n");
      writeFileSync(lock, entry());
      expect(check(lock, npmrc).code).toBe(0);
      writeFileSync(lock, entry("https://registry.npmjs.org/zod/-/zod-3.25.76.tgz"));
      expect(check(lock, npmrc).code).toBe(0);

      writeFileSync(lock, entry("https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/zod/-/zod-3.25.76.tgz"));
      let r = check(lock, npmrc);
      expect(r.code).toBe(1);
      expect(r.out).toContain("names a private package feed (ms-feed-25.pkgs.visualstudio.com)");
      writeFileSync(lock, entry("https://registry.example.com/zod/-/zod-3.25.76.tgz"));
      r = check(lock, npmrc);
      expect(r.code).toBe(1);
      expect(r.out).toContain("resolves from registry.example.com");

      writeFileSync(lock, entry());
      writeFileSync(npmrc, "registry=https://registry.npmjs.org/\n@x:registry=https://pkgs.dev.azure.com/o/_packaging/f/npm/registry/\n");
      r = check(lock, npmrc);
      expect(r.code).toBe(1);
      expect(r.out).toContain(".npmrc:2 points a registry somewhere other than registry.npmjs.org");
      writeFileSync(npmrc, "");
      expect(check(lock, npmrc).out).toContain("must set registry=https://registry.npmjs.org/");
      rmSync(npmrc);
      expect(check(lock, npmrc).out).toContain(".npmrc is missing");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
