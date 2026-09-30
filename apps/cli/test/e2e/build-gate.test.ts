import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPipeName } from "@homerun/client";
import { closeHandle, currentUserSid, openPipe, pipeSddl, privateFileSddl, READ_CONTROL, setPathProtectedDacl, setProtectedDacl, WRITE_DAC } from "@homerun/win32";
import { childEnv, runtime, WIN } from "./support";

/**
 * The CLI's build channel fails closed like homerund's: a compiled `homerun` is release unless it
 * was built with `--define HOMERUN_CLI_BUILD='"development"'`. These tests compile it both ways.
 */

const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");
const work = mkdtempSync(join(tmpdir(), "hr-cli-build-"));
const exe = WIN ? ".exe" : "";
const bins = { plain: join(work, `homerun-plain${exe}`), dev: join(work, `homerun-dev${exe}`), pinned: join(work, `homerun-pinned${exe}`) };

/** As package.json and the packaging scripts build it: a compiled binary never reads bunfig.toml or .env from where it runs. */
const NO_AUTOLOAD = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"];
/** A requirement nothing satisfies, in each OS's form. */
const NOBODY = WIN ? `sha256:${"0".repeat(64)}` : 'cdhash H"0000000000000000000000000000000000000000"';

function compile(out: string, ...defines: string[]): void {
  const r = Bun.spawnSync([process.execPath, "build", "--compile", ...NO_AUTOLOAD, MAIN, "--outfile", out, ...defines.flatMap((d) => ["--define", d])], { stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`bun build failed: ${r.stderr.toString()}`);
}

beforeAll(() => {
  compile(bins.plain);
  compile(bins.dev, `HOMERUN_CLI_BUILD="development"`);
  compile(bins.pinned, `HOMERUN_CLI_PEER_REQUIREMENT=${JSON.stringify(NOBODY)}`);
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function run(bin: string, dataDir: string, args: string[], env: Record<string, string> = {}, cwd?: string) {
  const p = Bun.spawn([bin, ...args], {
    cwd,
    env: childEnv(dataDir, env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill("SIGKILL"), 15_000);
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/**
 * A socket that counts what it is sent. On Windows, a pipe private to this user, published in
 * `run\endpoint` as homerund publishes its own, so only the peer check can tell it apart.
 */
async function listener(dir: string) {
  mkdirSync(join(dir, "run"), { recursive: true, mode: 0o700 });
  const seen = { connections: 0, bytes: 0 };
  const at = WIN ? newPipeName() : join(dir, "run", "homerund.sock");
  const l = Bun.listen({ unix: at, socket: { open: () => void seen.connections++, data: (_s, d) => void (seen.bytes += d.length) } });
  if (WIN) {
    const me = currentUserSid();
    const h = await openPipe(at, READ_CONTROL | WRITE_DAC);
    try {
      setProtectedDacl(h, pipeSddl(me));
    } finally {
      closeHandle(h);
    }
    const endpoint = join(dir, "run", "endpoint");
    writeFileSync(endpoint, at);
    setPathProtectedDacl(endpoint, privateFileSddl(me));
    // The connection that set the DACL is not the CLI's.
    await Bun.sleep(100);
    seen.connections = 0;
  }
  return { seen, stop: () => l.stop(true) };
}

describe("a compiled homerun without a build define is release", () => {
  test("it says so; with no code requirement compiled in, it refuses with 77 and sends nothing", async () => {
    const dir = mkdtempSync(join(work, "d-"));
    const l = await listener(dir);
    try {
      const v = await run(bins.plain, dir, ["version"]);
      expect(v.code).toBe(0);
      expect(v.stdout).toContain("(release)");
      for (const args of [["status"], ["send", "--new", "hi"], ["threads", "list"], ["login"], ["logout"]]) {
        const r = await run(bins.plain, dir, args);
        expect(r.code).toBe(77);
        expect(r.stderr).toContain("homerund's identity could not be verified, so the token was not used: this build has no code requirement");
      }
      expect(l.seen.connections).toBeGreaterThan(0);
      expect(l.seen.bytes).toBe(0);
    } finally {
      l.stop();
    }
  }, 30_000);

  test("with a requirement compiled in, a listener that doesn't satisfy it gets nothing", async () => {
    const dir = mkdtempSync(join(work, "d-"));
    const l = await listener(dir);
    try {
      const r = await run(bins.pinned, dir, ["status"]);
      expect(r.code).toBe(77);
      expect(r.stderr).toContain(process.platform === "linux" ? "it can only be checked on macOS" : "is not Homerun's homerund");
      expect(l.seen.bytes).toBe(0);
    } finally {
      l.stop();
    }
  }, 30_000);

  test("it refuses every development switch and variable with 64", async () => {
    const dir = mkdtempSync(join(work, "d-"));
    for (const [args, env, what] of [
      [["status", "--socket", "/tmp/x.sock"], {}, "--socket"],
      [["status", "--dev-token-file", "/tmp/t"], {}, "--dev-token-file"],
      [["version"], { HOMERUN_SOCKET: "/tmp/x.sock" }, "HOMERUN_SOCKET"],
      [["status", "--dev-role", "cli"], {}, "--dev-role"],
      [["login", "--dev-token-store", "/tmp/t"], {}, "--dev-token-store"],
      [["status", "--dev-skip-peer-check"], {}, "--dev-skip-peer-check"],
      [["status", "--dev-peer-requirement", "anchor apple"], {}, "--dev-peer-requirement"],
      [["login", "--dev-keychain", "/tmp/k"], {}, "--dev-keychain"],
      [["status"], { HOMERUN_DEV_TOKEN_STORE: "/tmp/t" }, "HOMERUN_DEV_TOKEN_STORE"],
      [["status"], { HOMERUN_DEV_SKIP_PEER_CHECK: "1" }, "HOMERUN_DEV_SKIP_PEER_CHECK"],
    ] as const) {
      const r = await run(bins.plain, dir, [...args], { ...env });
      expect(r.code).toBe(64);
      expect(r.stderr).toContain(`${what} is only available in development builds; this is a release build`);
    }
  }, 30_000);

  test("it never reads bunfig.toml (a preload) or .env from the directory it runs in", async () => {
    const dir = mkdtempSync(join(work, "cwd-"));
    const marker = join(dir, "preloaded");
    writeFileSync(join(dir, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
    writeFileSync(join(dir, "bunfig.toml"), `preload = ["./evil.ts"]\n`);
    writeFileSync(join(dir, ".env"), "HOMERUN_DEV_SKIP_PEER_CHECK=1\nHOMERUN_SOCKET=/tmp/elsewhere.sock\n");
    const r = await run(bins.plain, dir, ["version"], {}, dir);
    expect(r.code).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  }, 30_000);

  test("package.json builds it the same way", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));
    for (const script of [pkg.scripts.build, pkg.scripts["build:dev"]]) for (const f of NO_AUTOLOAD) expect(script).toContain(f);
  });
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
      const sock = WIN ? newPipeName() : join(srt.dir, "elsewhere.sock");
      const r = await run(bins.dev, srt.dir, ["status", "--socket", sock]);
      expect(r.code).toBe(69);
    } finally {
      await srt.close();
    }
  }, 30_000);
});
