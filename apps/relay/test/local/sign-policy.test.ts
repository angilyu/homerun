import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateVersionPolicy } from "@homerun/core";
import { RELAY_PATHS, verifySignedVersionPolicy } from "@homerun/protocol";
import { OidcIssuer } from "@homerun/testkit";
import { main, UsageError } from "../../../../scripts/release/sign-policy";
import { type LocalRelay, startLocalRelay } from "../../src/local";

/** scripts/release/sign-policy.ts (§11): make the offline key, sign, verify, and serve the result. */

const NOW = Date.parse("2026-10-01T12:00:00Z");
let dir: string;
let lines: string[];
const io = { out: (l: string) => void lines.push(l), now: () => NOW };
const run = (...argv: string[]) => {
  lines = [];
  return main(argv, io, {});
};

let issuer: OidcIssuer;
let relay: LocalRelay;
let published: string | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "homerun-policy-"));
  issuer = await OidcIssuer.start();
  relay = await startLocalRelay({ issuer: issuer.url, clientId: issuer.clientId, apns: null, versionPolicy: () => published });
});
afterAll(async () => {
  await relay.stop();
  await issuer.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("sign-policy.ts", () => {
  test("keygen, sign with ISO times, verify, and the relay serves what clients accept", async () => {
    const key = join(dir, "policy-2026-01.key");
    await run("keygen", "--out", key);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    const pub = lines.at(-1)!.split(": ").at(-1)!;
    await run("pubkey", "--key", key);
    expect(lines).toEqual([pub]);
    await expect(run("keygen", "--out", key)).rejects.toThrow("already exists");

    writeFileSync(
      join(dir, "policy.json"),
      JSON.stringify({
        v: 1,
        issued_at: "2026-10-01T12:00:00Z",
        expires_at: "2026-12-30T12:00:00Z",
        rules: [
          { platform: "macos", channel: "stable", min_version: "1.4.2", message: "This version has a scheduling bug.", url: "https://homerun.app/releases/1.4.2" },
          { platform: "windows", channel: "*", kill: [">=1.4.0 <1.4.2"] },
        ],
      }),
    );
    const out = join(dir, "signed.json");
    await run("sign", "--key", key, "--key-id", "2026-01", "--in", join(dir, "policy.json"), "--out", out);
    expect(lines).toContain("  windows/*: KILL >=1.4.0 <1.4.2");
    expect(lines.some((l) => l.includes("isn't in VERSION_POLICY_KEYS"))).toBe(true);
    // The output holds no part of the private key.
    expect(readFileSync(out, "utf8")).not.toContain(readFileSync(key, "utf8").trim());

    await run("verify", "--in", out, "--key-id", "2026-01", "--public-key", pub);
    expect(lines[0]).toBe("issued 2026-10-01T12:00:00.000Z, expires 2026-12-30T12:00:00.000Z, 2 rule(s)");
    await expect(run("verify", "--in", out)).rejects.toThrow("doesn't verify");

    published = readFileSync(out, "utf8").trim();
    const served = await (await fetch(relay.url + RELAY_PATHS.versionPolicy)).json();
    const p = verifySignedVersionPolicy(served, { "2026-01": pub });
    expect(p?.issued_at).toBe(NOW);
    expect(evaluateVersionPolicy(p, { platform: "windows", channel: "stable", version: "1.4.1", now: NOW + 1 }).state).toBe("killed");
    expect(evaluateVersionPolicy(p, { platform: "macos", channel: "stable", version: "1.4.1", now: NOW + 1 }).state).toBe("update_required");
  });

  test("refuses a key inside the repository or another git work tree", async () => {
    await expect(run("keygen", "--out", join(import.meta.dir, "leaked.key"))).rejects.toThrow("inside this repository");
    const repo = join(dir, "other-repo");
    Bun.spawnSync(["git", "init", "-q", repo]);
    await expect(run("keygen", "--out", join(repo, "secrets", "k.key"))).rejects.toThrow("inside a git work tree");
  });

  test("refuses policies the clients would refuse", async () => {
    const key = join(dir, "k2.key");
    await run("keygen", "--out", key);
    const sign = async (policy: object) => {
      writeFileSync(join(dir, "p.json"), JSON.stringify(policy));
      return run("sign", "--key", key, "--key-id", "2026-01", "--in", join(dir, "p.json"), "--out", join(dir, "s.json"));
    };
    const rules = [{ platform: "ios", channel: "*", min_version: "1.0.0" }];
    await expect(sign({ v: 1, expires_at: "2027-03-01T00:00:00Z", rules })).rejects.toThrow("at most 90 days");
    await expect(sign({ v: 1, expires_at: "2026-09-01T00:00:00Z", issued_at: "2026-08-01T00:00:00Z", rules })).rejects.toThrow("has passed");
    await expect(sign({ v: 1, issued_at: "2026-10-03T00:00:00Z", expires_at: "2026-11-01T00:00:00Z", rules })).rejects.toThrow("24 hours ahead");
    await expect(sign({ v: 1, expires_at: "2026-11-01T00:00:00Z", rules: [{ platform: "*", channel: "*", kill: ["*"] }] })).rejects.toBeInstanceOf(UsageError);
    await expect(sign({ v: 1, expires_at: "2026-11-01T00:00:00Z", rules: [{ platform: "ios", channel: "*", url: "http://insecure.test" }] })).rejects.toThrow("not a valid policy");
    // issued_at defaults to now.
    await sign({ v: 1, expires_at: "2026-11-01T00:00:00Z", rules });
    expect(lines[0]).toStartWith("issued 2026-10-01T12:00:00.000Z");
  });
});
