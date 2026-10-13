import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SocketRuntime } from "../../../homerund/test/helpers";
import { policyPlatform } from "../../../homerund/src/version/target";
import { fakeRelay, POLICY_KEYS, sign } from "../../../homerund/test/version-policy";
import { cli, runtime } from "./support";

/** §11 from the CLI: the version gate in `status`, and `homerun diagnostics`. */

let srt: SocketRuntime;
afterEach(async () => {
  await srt?.close();
});

const DAY = 86_400_000;
/** A runtime at version 1.0.0 that trusts the test release key, with its relay faked. */
async function gated() {
  const relay = fakeRelay();
  srt = await runtime({
    env: { HOMERUN_VERSION_POLICY_URL: "https://relay.test.invalid/v1/version-policy", HOMERUN_DEV_POLICY_KEYS: JSON.stringify(POLICY_KEYS), HOMERUN_DEV_VERSION: "1.0.0" },
    versionFetch: relay.fetch,
  });
  const publish = async (rule: Record<string, unknown>) => {
    const now = Date.now();
    relay.body = await sign({ v: 1, issued_at: now, expires_at: now + 30 * DAY, rules: [{ platform: policyPlatform(), channel: "*", ...rule } as never] });
  };
  return { relay, publish };
}

describe("status reports the version gate (§11)", () => {
  test("allowed: one quiet line; --check fetches a policy that stops this version, and status says what's paused", async () => {
    const { publish } = await gated();
    let r = await cli(srt.dir, ["status"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("version 1.0.0 (development) may run tasks");

    await publish({ min_version: "2.0.0", message: "Version 1.0 can repeat scheduled tasks.", url: "https://homerun.test/incident" });
    r = await cli(srt.dir, ["status", "--check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Version 1.0 can repeat scheduled tasks.");
    expect(r.stdout).toContain("Scheduled tasks and monitors don't run until Homerun updates");
    expect(r.stdout).not.toContain("Chat and Run now are paused");
    expect(r.stdout).toContain("https://homerun.test/incident");

    const j = await cli(srt.dir, ["status", "--json"]);
    expect(JSON.parse(j.stdout).version_gate).toMatchObject({ version: "1.0.0", verdict: { state: "update_required", reason: "below_minimum", min_version: "2.0.0", unattended_allowed: false, interactive_allowed: true } });
  });

  test("a kill that includes chat says so", async () => {
    const { publish } = await gated();
    await publish({ kill: ["<=1.0.0"], kill_interactive: true });
    const r = await cli(srt.dir, ["status", "--check"]);
    expect(r.stdout).toContain("Chat and Run now are paused too.");
  });

  test("offline: --check fails open and says the check failed", async () => {
    const { relay } = await gated();
    relay.offline = true;
    const r = await cli(srt.dir, ["status", "--check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/may run tasks · policy .*last check failed/);
  });
});

describe("homerun diagnostics (§11)", () => {
  test("without a terminal it needs --yes, and writes nothing", async () => {
    srt = await runtime();
    mkdirSync(join(srt.dir, "Downloads"));
    const r = await cli(srt.dir, ["diagnostics"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("versions.json");
    expect(r.stderr).toContain("add --yes");
    expect(readdirSync(join(srt.dir, "Downloads"))).toEqual([]);
  });

  test("--yes lists the files on stderr and saves to Downloads; the path is the only stdout", async () => {
    srt = await runtime();
    mkdirSync(join(srt.dir, "Downloads"));
    const r = await cli(srt.dir, ["diagnostics", "--yes"]);
    expect(r.code).toBe(0);
    for (const name of ["manifest.json", "versions.json", "database.json", "scheduler.json", "relay.json", "version-policy.json"]) expect(r.stderr).toContain(name);
    expect(r.stderr).toContain("Nothing is uploaded.");
    const path = r.stdout.trim();
    expect(path).toMatch(/[\\/]Downloads[\\/]homerun-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(readFileSync(path).subarray(0, 2).toString()).toBe("PK");
  });

  test("--out: a folder gets a dated name, a .zip is used as given, an existing file is refused; --json", async () => {
    srt = await runtime();
    const out = join(srt.dir, "out");
    mkdirSync(out);
    let r = await cli(srt.dir, ["diagnostics", "--yes", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/[\\/]out[\\/]homerun-diagnostics-\d{8}-\d{6}\.zip$/);

    const named = join(out, "bug-123.zip");
    r = await cli(srt.dir, ["diagnostics", "--yes", "--json", "--out", named]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { path: string; bytes: number; files: { name: string }[] };
    expect(j.path).toBe(named);
    expect(j.files.map((f) => f.name)).toContain("versions.json");
    expect(r.stderr).toBe("");
    expect(existsSync(named)).toBe(true);

    r = await cli(srt.dir, ["diagnostics", "--yes", "--out", named]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
    expect((await cli(srt.dir, ["diagnostics", "--yes", "--out", join(out, "notes.txt")])).code).toBe(64);
  });
});
