/**
 * Milestone 8b probe P4 (plan §4): how does the bundled claude behave on this platform?
 * A local server stands in for the API: it records each request's tool names and answers 400,
 * so no request leaves the machine and nothing is spent. Runs claude under a few environments
 * (minimal, minimal + Git Bash, minimal without SystemRoot) and prints one JSON object.
 *
 *   bun spikes/windows-probe/claude.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const exe = process.platform === "win32" ? "claude.exe" : "claude";
const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
const store = join(root, "node_modules", ".pnpm");
const dir = readdirSync(store).find((d) => d.startsWith(`@anthropic-ai+${pkg}@`));
const claude = dir ? join(store, dir, "node_modules", "@anthropic-ai", pkg, exe) : "";
if (!claude || !existsSync(claude)) {
  console.log(JSON.stringify({ error: `no ${pkg}/${exe} in ${store}` }));
  process.exit(0);
}

const seen: Array<{ path: string; tools: string[] }> = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    let tools: string[] = [];
    try {
      const body = (await req.json()) as { tools?: Array<{ name?: string }> };
      tools = (body.tools ?? []).map((t) => t.name ?? "?").sort();
    } catch {}
    seen.push({ path: url.pathname, tools });
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "homerun probe: no API here" } }, { status: 400 });
  },
});

function baseEnv(home: string): Record<string, string> {
  const e: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    ANTHROPIC_API_KEY: "sk-ant-mock-not-a-real-key",
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (process.platform === "win32") {
    const sr = process.env.SystemRoot ?? "C:\\Windows";
    Object.assign(e, {
      SystemRoot: sr,
      windir: sr,
      ComSpec: join(sr, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: [join(sr, "System32"), sr, join(sr, "System32", "Wbem"), join(sr, "System32", "WindowsPowerShell", "v1.0")].join(";"),
      SystemDrive: process.env.SystemDrive ?? "C:",
      TEMP: home,
      TMP: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    });
  } else {
    Object.assign(e, { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: home, SHELL: "/bin/bash" });
  }
  return e;
}

function run(label: string, env: Record<string, string>): Promise<Record<string, unknown>> {
  const before = seen.length;
  const t0 = Date.now();
  return new Promise((res) => {
    const c = spawn(claude, ["-p", "say hi", "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-4-5", "--max-turns", "1"], { env, windowsHide: true, cwd: env.TEMP ?? env.TMPDIR, stdio: ["ignore", "pipe", "pipe"] });
    let so = "";
    let se = "";
    c.stdout.on("data", (d) => (so += d));
    c.stderr.on("data", (d) => (se += d));
    const timer = setTimeout(() => c.kill(), 60_000);
    c.on("exit", (code) => {
      clearTimeout(timer);
      let init: { tools?: string[]; model?: string } | undefined;
      for (const line of so.split(/\r?\n/)) {
        try {
          const m = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[] };
          if (m.type === "system" && m.subtype === "init") init = m;
        } catch {}
      }
      res({
        label,
        code,
        ms: Date.now() - t0,
        initTools: init?.tools?.slice().sort(),
        requests: seen.slice(before),
        stderr: se.slice(0, 600),
        stdoutHead: init ? undefined : so.slice(0, 600),
      });
    });
  });
}

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `hr-probe-${n}-`));
const results: Record<string, unknown>[] = [];
results.push(await new Promise((res) => {
  const c = spawn(claude, ["--version"], { env: baseEnv(tmp("v")), windowsHide: true });
  let s = "";
  c.stdout.on("data", (d) => (s += d));
  c.stderr.on("data", (d) => (s += d));
  c.on("exit", (code) => res({ label: "version", code, out: s.trim().slice(0, 200) }));
}));
results.push(await run("minimal", baseEnv(tmp("min"))));
if (process.platform === "win32") {
  const git = "C:\\Program Files\\Git";
  const withGit = baseEnv(tmp("git"));
  withGit.PATH = `${withGit.PATH};${join(git, "cmd")}`;
  withGit.CLAUDE_CODE_GIT_BASH_PATH = join(git, "bin", "bash.exe");
  results.push(await run("minimal+gitbash", withGit));
  const noRoot = baseEnv(tmp("noroot"));
  delete noRoot.SystemRoot;
  delete noRoot.windir;
  results.push(await run("minimal-SystemRoot", noRoot));
}
server.stop(true);
console.log(JSON.stringify({ claude: claude.slice(root.length), results }, null, 2));
process.exit(0);
