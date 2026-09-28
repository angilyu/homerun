import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR } from "@homerun/core";
import { findClaude, resolveBuildChannel } from "../../src/config";
import { RpcClient } from "../../src/rpc/client";

/**
 * The build channel fails closed: a compiled homerund is release unless built with an explicit
 * `--define HOMERUND_BUILD='"development"'`. These tests compile the real binary both ways.
 */

describe("resolveBuildChannel", () => {
  test("source runs are development; compiled executables are release unless defined development", () => {
    expect(resolveBuildChannel(undefined, false)).toBe("development");
    expect(resolveBuildChannel(undefined, true)).toBe("release");
    expect(resolveBuildChannel("development", true)).toBe("development");
    expect(resolveBuildChannel("release", false)).toBe("release");
    // Anything unexpected fails closed.
    expect(resolveBuildChannel("dev", true)).toBe("release");
    expect(resolveBuildChannel("", false)).toBe("release");
  });
});

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const LAUNCH = "c".repeat(64);
const work = mkdtempSync(join(tmpdir(), "hr-build-"));
const bins = { plain: join(work, "homerund-plain"), dev: join(work, "homerund-dev") };
const claudePath = findClaude(process.env);

function compile(out: string, define?: string): void {
  const r = Bun.spawnSync([process.execPath, "build", "--compile", MAIN, "--outfile", out, ...(define ? ["--define", define] : [])], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bun build failed: ${r.stderr.toString()}`);
}

beforeAll(() => {
  compile(bins.plain);
  compile(bins.dev, `HOMERUND_BUILD="development"`);
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

function envFor(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dataDir, HOMERUN_DATA_DIR: dataDir, HOMERUN_CLAUDE_PATH: claudePath, ...extra };
}

/** Run a binary with stdin closed after `stdin`; returns exit code and stderr. */
async function runOnce(bin: string, args: string[], extra: Record<string, string> = {}, stdin = `${LAUNCH}\n`): Promise<{ code: number; stderr: string }> {
  const dataDir = mkdtempSync(join(work, "d-"));
  const p = Bun.spawn([bin, ...args], { env: envFor(dataDir, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  p.stdin.write(stdin);
  // Keep stdin open: a runtime that wrongly started would wait here, and the timeout catches it.
  const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
  const code = await p.exited;
  clearTimeout(timer);
  p.stdin.end();
  return { code, stderr: await new Response(p.stderr).text() };
}

async function waitFor(path: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(25);
  }
}

const hello = (role: string, auth: unknown) => ({ protocol: { min: 1, max: 1 }, role, auth, client: { name: "t", version: "0" }, capabilities: [] });

describe("a compiled homerund without a build define is release", () => {
  test("it refuses --dev-auto-approve", async () => {
    const r = await runOnce(bins.plain, ["serve", "--dev-auto-approve"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("--dev-auto-approve is only available in development builds");
  }, 30_000);

  test("it refuses HOMERUN_ANTHROPIC_BASE_URL", async () => {
    const r = await runOnce(bins.plain, ["serve"], { HOMERUN_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("HOMERUN_ANTHROPIC_BASE_URL is only available in development builds");
  }, 30_000);

  test("it refuses --no-launch-token, --dev-mcp-overrides and HOMERUN_DEV_AUTO_APPROVE", async () => {
    for (const [args, env, what] of [
      [["serve", "--no-launch-token"], {}, "--no-launch-token"],
      [["serve", "--dev-mcp-overrides", "/nonexistent.json"], {}, "--dev-mcp-overrides"],
      [["serve"], { HOMERUN_DEV_AUTO_APPROVE: "1" }, "--dev-auto-approve"],
    ] as const) {
      const r = await runOnce(bins.plain, [...args], { ...env });
      expect(r.code).toBe(64);
      expect(r.stderr).toContain(`${what} is only available in development builds`);
    }
  }, 60_000);

  test("it writes no dev token and refuses a dev-token hello; the launch token still works", async () => {
    const dataDir = mkdtempSync(join(work, "d-"));
    const p = Bun.spawn([bins.plain, "serve"], { env: envFor(dataDir), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    try {
      p.stdin.write(`${LAUNCH}\n`);
      p.stdin.flush();
      const sock = join(dataDir, "run", "homerund.sock");
      await waitFor(sock);
      expect(existsSync(join(dataDir, "run", "dev-token"))).toBe(false);

      const dev = await RpcClient.connect(sock);
      const e = (await dev.raw("hello", hello("cli_dev", { kind: "dev_token", token: "A".repeat(43) })).catch((x) => x)) as { code: number; message: string };
      expect(e.code).toBe(RPC_ERROR.UNAUTHENTICATED);
      expect(e.message).toContain("not available in release builds");
      await dev.closed;

      const shell = await RpcClient.open(sock, "shell", { kind: "launch_token", token: LAUNCH });
      expect(await shell.call("ping", {})).toMatchObject({ pong: true });
      shell.close();
      p.stdin.end();
      expect(await p.exited).toBe(0);
    } finally {
      p.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("a compiled homerund built with HOMERUND_BUILD=development", () => {
  test("accepts the development switches and the dev-token hello", async () => {
    const dataDir = mkdtempSync(join(work, "d-"));
    const p = Bun.spawn([bins.dev, "serve", "--no-launch-token", "--dev-auto-approve"], {
      env: envFor(dataDir, { HOMERUN_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const tokenFile = join(dataDir, "run", "dev-token");
      await waitFor(tokenFile);
      await waitFor(join(dataDir, "run", "homerund.sock"));
      const token = (await Bun.file(tokenFile).text()).trim();
      const dev = await RpcClient.open(join(dataDir, "run", "homerund.sock"), "cli_dev", { kind: "dev_token", token });
      expect(await dev.call("ping", {})).toMatchObject({ pong: true });
      dev.close();
      p.kill("SIGTERM");
      expect(await p.exited).toBe(0);
    } finally {
      p.kill("SIGKILL");
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
