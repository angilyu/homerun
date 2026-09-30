import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@homerun/client";
import { until, type SocketRuntime } from "../../../homerund/test/helpers";
import { macosInspector, verifyPeer } from "../../src/peer";
import { KeychainTokenStore, keychainAccount } from "../../src/token-store";
import { cli, runtime, spawnCli } from "../e2e/support";

/**
 * The real system calls behind the release CLI (§5.2): the keychain through Security.framework,
 * and the socket peer check. macOS only; run nightly (`pnpm --filter @homerun/cli test:macos`)
 * and by hand. A throwaway keychain file stands in for the login keychain, so no real keychain
 * is read or written, and a locked screen doesn't matter. What needs the real login keychain or
 * a person is listed as manual checks in apps/desktop/README.md.
 */

const mac = process.platform === "darwin";
const work = mkdtempSync(join(tmpdir(), "hr-cli-mac-"));
const keychain = join(work, "test.keychain-db");
const NOBODY = 'cdhash H"0000000000000000000000000000000000000000"';

const sh = (args: string[]) => {
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

/** The designated requirement of the binary running these tests (and so of homerund, in process), if it is signed. */
function ownRequirement(): string | null {
  const r = sh(["codesign", "-d", "-r-", process.execPath]);
  const m = /designated => (.+)/.exec(r.out);
  return r.code === 0 && m ? m[1]!.trim() : null;
}

beforeAll(() => {
  if (!mac) return;
  expect(sh(["security", "create-keychain", "-p", "homerun-test", keychain]).code).toBe(0);
  expect(sh(["security", "unlock-keychain", "-p", "homerun-test", keychain]).code).toBe(0);
});
afterAll(() => {
  if (mac) sh(["security", "delete-keychain", keychain]);
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!mac)("the keychain (Security.framework)", () => {
  test("round trip, replace and delete, in the given keychain only", () => {
    const s = new KeychainTokenStore("test", keychain);
    expect(s.read()).toBeNull();
    s.write("A".repeat(43));
    expect(s.read()).toBe("A".repeat(43));
    s.write("B".repeat(43));
    expect(s.read()).toBe("B".repeat(43));
    const found = sh(["security", "find-generic-password", "-s", "com.angilyu.homerun.cli", "-a", "test", "-l", "Homerun command-line tool", keychain]);
    expect(found.code).toBe(0);
    expect(new KeychainTokenStore("other", keychain).read()).toBeNull();
    expect(s.delete()).toBe(true);
    expect(s.delete()).toBe(false);
    expect(s.read()).toBeNull();
  });
});

describe.skipIf(!mac)("tagged-pointer CFStrings (regression)", () => {
  // Short CFStrings are tagged pointers whose high bits are set with a per-process random key,
  // so a CF reference carried as a double was rounded in some processes: the account was
  // silently a different string, or Security crashed. Only fresh processes show it.
  test("short accounts survive in fresh processes", () => {
    const script = join(work, "tagged.ts");
    writeFileSync(script, `import { KeychainTokenStore } from ${JSON.stringify(join(import.meta.dir, "../../src/token-store"))};
new KeychainTokenStore("t", process.argv[2]).write("D".repeat(43));`);
    for (let i = 0; i < 12; i++) {
      const r = Bun.spawnSync([process.execPath, script, keychain], { stdout: "pipe", stderr: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(sh(["security", "find-generic-password", "-s", "com.angilyu.homerun.cli", "-a", "t", keychain]).code).toBe(0);
    }
    expect(new KeychainTokenStore("t", keychain).delete()).toBe(true);
  }, 30_000);
});

describe.skipIf(!mac)("the peer check (LOCAL_PEERPID, LOCAL_PEERTOKEN, SecCode)", () => {
  let srt: SocketRuntime;
  beforeAll(async () => {
    srt = await runtime();
  });
  afterAll(async () => {
    await srt?.close();
  });

  test("a listener that doesn't satisfy the requirement fails; its own requirement passes", async () => {
    const c = await RpcClient.connect(srt.rt.config.socketPath);
    try {
      expect(await verifyPeer(c.fd, NOBODY, "darwin", macosInspector)).toEqual({ ok: false, why: `process ${process.pid} is not Homerun's homerund` });
      const req = ownRequirement();
      if (req) expect(await verifyPeer(c.fd, req, "darwin", macosInspector)).toEqual({ ok: true, pid: process.pid });
    } finally {
      c.close();
    }
  });

  test("login, use and logout end to end with the real keychain and peer check", async () => {
    const req = ownRequirement();
    if (!req) return console.warn("skipped: the test runner is not signed, so it has no designated requirement");
    const flags = ["--dev-role", "cli", "--dev-keychain", keychain, "--dev-peer-requirement", req];
    const shell = await srt.shell();
    const asked: string[] = [];
    shell.onNotification((m, p) => void (m === "cli.access_requested" && asked.push((p as { request_id: string }).request_id)));
    const login = spawnCli(srt.dir, ["login", ...flags]);
    await until(() => asked.length === 1, 10_000, "the prompt");
    await shell.call("cli.approve", { request_id: asked[0]! });
    expect((await login.done).code).toBe(0);
    const stored = new KeychainTokenStore(keychainAccount({ HOMERUN_DATA_DIR: srt.dir }), keychain);
    expect(stored.read()).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const st = await cli(srt.dir, ["status", "--json", ...flags]);
    expect(st.code).toBe(0);
    expect(JSON.parse(st.stdout)).toMatchObject({ role: "cli" });
    const wrong = await cli(srt.dir, ["status", ...flags.slice(0, 4), "--dev-peer-requirement", NOBODY]);
    expect(wrong.code).toBe(77);
    expect(wrong.stderr).toContain("is not Homerun's homerund");

    expect((await cli(srt.dir, ["logout", ...flags])).code).toBe(0);
    expect(stored.read()).toBeNull();
  }, 30_000);
});
