import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ALLOWED_KEYS, normalizer, redact } from "../replay/cassette";

const SCRIPT = resolve(import.meta.dir, "..", "..", "..", "..", "scripts", "check-no-secrets.sh");
// Built at runtime so this file never holds a key-shaped literal.
const FAKE = ["sk", "ant", "api03", "Zq".repeat(20)].join("-");

function scan(...files: string[]) {
  const p = Bun.spawnSync(["/bin/bash", SCRIPT, ...files], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

// The repository scripts are bash; they are checked on Linux and macOS, not Windows.
describe.skipIf(process.platform === "win32")("no secrets in the repository", () => {
  test("every tracked or committable file is clean, cassettes included", () => {
    const r = scan();
    expect(r.out).toContain("no secrets found");
    expect(r.code).toBe(0);
  });

  test("the scan catches a key, credential headers and paths in a cassette, and never prints the key", () => {
    const d = mkdtempSync(join(tmpdir(), "hr-scan-"));
    try {
      mkdirSync(join(d, "cassettes"));
      const f = join(d, "cassettes", "c.json");
      writeFileSync(f, JSON.stringify({ a: FAKE, headers: { "x-api-key": "x" }, cwd: "/Users/someone/x" }));
      const r = scan(f);
      expect(r.code).toBe(1);
      expect(r.out).toContain("shaped like an API key");
      expect(r.out).toContain("credential header");
      expect(r.out).toContain("machine-specific path");
      expect(r.out).not.toContain(FAKE);
      writeFileSync(f, JSON.stringify({ keys: ALLOWED_KEYS }));
      expect(scan(f).code).toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("cassette redaction scrubs the recording key and any other key-shaped string", () => {
    const norm = normalizer([["/private/tmp/x", "<ROOT>"]]);
    const secret = "real-key-value-123456";
    const out = redact(`${secret} ${FAKE} ${ALLOWED_KEYS[0]} /private/tmp/x/a`, [secret], norm);
    expect(out).toBe(`[REDACTED] [REDACTED] ${ALLOWED_KEYS[0]} <ROOT>/a`);
  });
});
