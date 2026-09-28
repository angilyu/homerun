import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime } from "./support";

/**
 * The CLI's build channel fails closed like homerund's: a compiled `homerun` is release unless it
 * was built with `--define HOMERUN_CLI_BUILD='"development"'`. These tests compile it both ways.
 */

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const work = mkdtempSync(join(tmpdir(), "hr-cli-build-"));
const bins = { plain: join(work, "homerun-plain"), dev: join(work, "homerun-dev") };

function compile(out: string, define?: string): void {
  const r = Bun.spawnSync([process.execPath, "build", "--compile", MAIN, "--outfile", out, ...(define ? ["--define", define] : [])], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bun build failed: ${r.stderr.toString()}`);
}

beforeAll(() => {
  compile(bins.plain);
  compile(bins.dev, `HOMERUN_CLI_BUILD="development"`);
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function run(bin: string, dataDir: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn([bin, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dataDir, TMPDIR: tmpdir(), HOMERUN_DATA_DIR: dataDir, NO_COLOR: "1", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

describe("a compiled homerun without a build define is release", () => {
  test("it says so, and refuses runtime commands with 77 even when a development runtime is up", async () => {
    const srt = await runtime();
    try {
      const v = await run(bins.plain, srt.dir, ["version"]);
      expect(v.code).toBe(0);
      expect(v.stdout).toContain("(release)");
      for (const args of [["status"], ["send", "--new", "hi"], ["threads", "list"]]) {
        const r = await run(bins.plain, srt.dir, args);
        expect(r.code).toBe(77);
        expect(r.stderr).toContain("needs access approved in the Homerun app");
      }
      expect((await srt.dev().then((d) => d.call("threads.list", {}))).threads).toHaveLength(0);
    } finally {
      await srt.close();
    }
  }, 30_000);

  test("it refuses --socket, --dev-token-file and HOMERUN_SOCKET with 64", async () => {
    const dir = mkdtempSync(join(work, "d-"));
    for (const [args, env, what] of [
      [["status", "--socket", "/tmp/x.sock"], {}, "--socket"],
      [["status", "--dev-token-file", "/tmp/t"], {}, "--dev-token-file"],
      [["version"], { HOMERUN_SOCKET: "/tmp/x.sock" }, "HOMERUN_SOCKET"],
    ] as const) {
      const r = await run(bins.plain, dir, [...args], { ...env });
      expect(r.code).toBe(64);
      expect(r.stderr).toContain(`${what} is only available in development builds; this is a release build`);
    }
  }, 30_000);
});

describe("a compiled homerun built with HOMERUN_CLI_BUILD=development", () => {
  test("drives a development runtime with its dev token", async () => {
    const srt = await runtime({ script: async (s) => {
      const i = (await s.nextInput())!;
      s.emit({ type: "message", messageId: "m", text: "hello from the fake engine" });
      s.result([i.uuid]);
    } });
    try {
      const v = await run(bins.dev, srt.dir, ["version"]);
      expect(v.stdout).toContain("(development)");
      const st = await run(bins.dev, srt.dir, ["status", "--json"]);
      expect(st.code).toBe(0);
      expect(JSON.parse(st.stdout)).toMatchObject({ role: "cli_dev" });
      const s = await run(bins.dev, srt.dir, ["send", "--new", "hi"]);
      expect(s.code).toBe(0);
      expect(s.stdout).toBe("hello from the fake engine\n");
      const sock = join(srt.dir, "elsewhere.sock");
      const r = await run(bins.dev, srt.dir, ["status", "--socket", sock]);
      expect(r.code).toBe(69);
    } finally {
      await srt.close();
    }
  }, 30_000);
});
