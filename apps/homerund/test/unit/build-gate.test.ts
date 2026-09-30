import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR } from "@homerun/core";
import { pidAlive, processCreationTime, processSnapshot, terminateProcess } from "@homerun/win32";
import { findClaude, resolveBuildChannel } from "../../src/config";
import { treeBelow } from "../../src/platform/windows-processes";
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
const WINDOWS = process.platform === "win32";
const EXE = WINDOWS ? ".exe" : "";
const bins = { plain: join(work, `homerund-plain${EXE}`), dev: join(work, `homerund-dev${EXE}`) };
const claudePath = findClaude(process.env);

function compile(out: string, define?: string): void {
  const r = Bun.spawnSync([process.execPath, "build", "--compile", MAIN, "--outfile", out, ...(define ? ["--define", define] : [])], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bun build failed: ${r.stderr.toString()}`);
}

beforeAll(() => {
  compile(bins.plain);
  compile(bins.dev, `HOMERUND_BUILD="development"`);
}, 120_000);

/** Every runtime these tests start: each is killed and awaited before its files are removed. */
const live = new Set<Subprocess>();
function track<P extends Subprocess>(p: P): P {
  live.add(p);
  void p.exited.then(() => live.delete(p));
  return p;
}
/**
 * Kill a runtime and wait for it, and on Windows for everything below it, which its kill-on-close
 * job takes down (a runtime at rest starts nothing, so normally there is nothing). Anything still
 * running after that is a leak: it is killed, and the test fails.
 */
async function stop(p: Subprocess): Promise<void> {
  const tree = WINDOWS && p.exitCode === null ? treeBelow(processSnapshot(), p.pid, createdOf) : [];
  const born = new Map(tree.map((pid) => [pid, createdOf(pid)]));
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  await p.exited;
  const alive = () => tree.filter((pid) => pidAlive(pid, born.get(pid) ?? undefined));
  for (let i = 0; i < 100 && alive().length; i++) await Bun.sleep(50);
  const leaked = alive();
  for (const pid of leaked) terminateProcess(pid);
  expect(leaked).toEqual([]);
}

function createdOf(pid: number): bigint | null {
  try {
    return processCreationTime(pid);
  } catch {
    return null;
  }
}

/**
 * Windows can't remove an executable, or a directory holding one, while a process runs it. With
 * every runtime already exited, a short bounded retry covers the loader releasing the image.
 */
async function removeTree(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= 40 || (e as NodeJS.ErrnoException).code !== "EPERM" && (e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
      await Bun.sleep(100);
    }
  }
}

afterAll(async () => {
  const left = [...live];
  await Promise.all(left.map(stop));
  expect(left.map((p) => p.pid)).toEqual([]);
  await removeTree(work);
});

function envFor(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  // Windows can't start much of Win32 (sockets among it) without SystemRoot.
  const system: Record<string, string> = WINDOWS && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dataDir, HOMERUN_DATA_DIR: dataDir, HOMERUN_CLAUDE_PATH: claudePath, ...system, ...extra };
}

/** Run a binary with stdin closed after `stdin`; returns exit code and stderr. */
async function runOnce(bin: string, args: string[], extra: Record<string, string> = {}, stdin = `${LAUNCH}\n`): Promise<{ code: number; stderr: string }> {
  const dataDir = mkdtempSync(join(work, "d-"));
  const p = track(Bun.spawn([bin, ...args], { env: envFor(dataDir, extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
  p.stdin.write(stdin);
  // Keep stdin open: a runtime that wrongly started would wait here, and the timeout catches it.
  const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
  const code = await p.exited;
  clearTimeout(timer);
  p.stdin.end();
  return { code, stderr: await new Response(p.stderr).text() };
}

/** Where the runtime in `dataDir` listens, once it does: its socket, or on Windows its published pipe. */
async function endpoint(dataDir: string): Promise<string> {
  if (!WINDOWS) {
    await waitFor(join(dataDir, "run", "homerund.sock"));
    return join(dataDir, "run", "homerund.sock");
  }
  await waitFor(join(dataDir, "run", "endpoint"));
  return (await Bun.file(join(dataDir, "run", "endpoint")).text()).trim();
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
    const p = track(Bun.spawn([bins.plain, "serve"], { env: envFor(dataDir), stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
    try {
      p.stdin.write(`${LAUNCH}\n`);
      p.stdin.flush();
      const sock = await endpoint(dataDir);
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
      await stop(p);
      await removeTree(dataDir);
    }
  }, 30_000);
});

describe("a compiled homerund built with HOMERUND_BUILD=development", () => {
  test("accepts the development switches and the dev-token hello", async () => {
    const dataDir = mkdtempSync(join(work, "d-"));
    const p = track(
      Bun.spawn([bins.dev, "serve", "--no-launch-token", "--dev-auto-approve"], {
        env: envFor(dataDir, { HOMERUN_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    try {
      const tokenFile = join(dataDir, "run", "dev-token");
      await waitFor(tokenFile);
      const sock = await endpoint(dataDir);
      const token = (await Bun.file(tokenFile).text()).trim();
      const dev = await RpcClient.open(sock, "cli_dev", { kind: "dev_token", token });
      expect(await dev.call("ping", {})).toMatchObject({ pong: true });
      dev.close();
      // Windows has no SIGTERM to deliver (kill terminates); the stdin case above covers a clean exit.
      if (!WINDOWS) {
        p.kill("SIGTERM");
        expect(await p.exited).toBe(0);
      }
    } finally {
      await stop(p);
      await removeTree(dataDir);
    }
  }, 30_000);
});
