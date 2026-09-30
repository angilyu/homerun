import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, chooseRunDir } from "@homerun/client";

/**
 * The release CLI as it ships (§5.2), against the app it ships in: `HOMERUN_TEST_APP` is a
 * packaged Homerun.app (scripts/macos/package.sh; the nightly passes the ad-hoc one). Skipped
 * otherwise. Nothing is approved, so nothing is written to the login keychain.
 */

const APP = process.env.HOMERUN_TEST_APP;
const MACOS = APP ? join(APP, "Contents", "MacOS") : "";
const CLI = join(MACOS, "homerun-cli");
const HOMERUND = join(MACOS, "homerund");
const LAUNCH_TOKEN = "e".repeat(64);

const sh = (args: string[]) => {
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

let dirs: string[] = [];
const scratch = () => {
  // Short: the socket path must fit in sun_path.
  const d = mkdtempSync(join("/tmp", "hr-b-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function runCli(dataDir: string, args: string[]) {
  const p = Bun.spawn([CLI, ...args], {
    // The real HOME, so the login keychain is the user's; the account is keyed by the data dir.
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? dataDir, TMPDIR: tmpdir(), HOMERUN_DATA_DIR: dataDir, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

describe.skipIf(!APP || process.platform !== "darwin")("the bundled release CLI", () => {
  test("is signed as its own identity, hardened, with allow-jit only", () => {
    const info = sh(["codesign", "-dvv", CLI]).out;
    expect(info).toContain("Identifier=com.angilyu.homerun.cli");
    expect(info).toMatch(/flags=0x[0-9a-f]+\([^)]*\bruntime\b/);
    const ents = JSON.parse(sh(["sh", "-c", `codesign -d --entitlements - --xml "${CLI}" 2>/dev/null | plutil -convert json -o - -`]).out);
    expect(ents).toEqual({ "com.apple.security.cs.allow-jit": true });
    expect(sh(["codesign", "--verify", "--strict", CLI]).code).toBe(0);
  });

  test("refuses every development switch", async () => {
    const d = scratch();
    for (const args of [["status", "--socket", "/tmp/x.sock"], ["status", "--dev-skip-peer-check"], ["status", "--dev-role", "cli_dev"], ["login", "--dev-token-store", "/tmp/t"]]) {
      const r = await runCli(d, args);
      expect(r.code, args.join(" ")).toBe(64);
    }
  });

  test("answers questions only: approve is refused before connecting", async () => {
    const r = await runCli(scratch(), ["approve", "abcd1234"]);
    expect(r.code).toBe(77);
    expect(r.stderr).toContain("the release CLI answers questions only");
  });

  describe("against the bundled homerund", () => {
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let shell: RpcClient | null = null;
    afterEach(async () => {
      shell?.close();
      shell = null;
      if (proc) {
        (proc.stdin as import("bun").FileSink).end();
        const t = setTimeout(() => proc?.kill("SIGKILL"), 10_000);
        await proc.exited;
        clearTimeout(t);
        proc = null;
      }
    });

    test("the peer check passes: the request reaches the app, which denies it", async () => {
      const dataDir = scratch();
      let stderr = "";
      const p = Bun.spawn([HOMERUND, "serve"], {
        env: { PATH: "/usr/bin:/bin", HOME: dataDir, TMPDIR: tmpdir(), HOMERUN_DATA_DIR: dataDir },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "pipe",
      });
      proc = p;
      p.stdin.write(`${LAUNCH_TOKEN}\n`);
      p.stdin.flush();
      void (async () => {
        for await (const c of p.stderr) stderr += new TextDecoder().decode(c);
      })();
      const deadline = Date.now() + 20_000;
      while (!stderr.includes('"msg":"ready"')) {
        if (p.exitCode !== null || Date.now() > deadline) throw new Error(`homerund didn't start:\n${stderr}`);
        await Bun.sleep(50);
      }
      const s = await RpcClient.open(chooseRunDir(dataDir).socketPath, "shell", { kind: "launch_token", token: LAUNCH_TOKEN });
      shell = s;
      const asked: string[] = [];
      s.onNotification((m, params) => {
        if (m !== "cli.access_requested") return;
        const id = (params as { request_id: string }).request_id;
        asked.push(id);
        void s.call("cli.deny", { request_id: id });
      });
      const r = await runCli(dataDir, ["login"]);
      expect(asked.length, r.stderr).toBe(1);
      expect(r.code).toBe(77);
      expect(r.stderr).toContain("access was denied");
    }, 60_000);
  });

  test("a listener that isn't Homerun's homerund gets nothing: exit 77 before any byte is sent", async () => {
    const dataDir = scratch();
    const { runDir, socketPath } = chooseRunDir(dataDir);
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    let received = 0;
    // This process is bun, not the bundled homerund, so it fails the compiled-in requirement.
    const listener = Bun.listen({ unix: socketPath, socket: { data: (_s, d) => void (received += d.byteLength) } });
    try {
      for (const cmd of [["status"], ["login"]]) {
        const r = await runCli(dataDir, cmd);
        expect(r.code, r.stderr).toBe(77);
        expect(r.stderr).toContain("is not Homerun's homerund");
      }
      await Bun.sleep(100);
      expect(received).toBe(0);
    } finally {
      listener.stop(true);
    }
  });
});

beforeAll(() => {
  if (APP) expect(Bun.file(CLI).size).toBeGreaterThan(0);
});
