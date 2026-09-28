/**
 * §5.5 / §16.1 item 10: launch a stdio MCP server with the *bundled* Node (via npm's
 * npx-cli.js) or the *bundled* uv (`uv tool run`), under a scrubbed environment with
 * Homerun-private caches, and complete an MCP handshake + one tools/call.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, helperPath, isCompiled } from "./paths";

export interface McpProbeSpec {
  runner: "npx" | "uvx";
  /** npx: package spec or tarball path; uvx: requirement, e.g. "mcp-server-time==2026.8.18". */
  pkg: string;
  /** Executable to run from `pkg` (needed for tarballs / multi-bin packages). */
  bin?: string;
  args?: string[];
  tool: string;
  toolArgs?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface McpProbeResult {
  ok: boolean;
  command: string[];
  serverInfo?: unknown;
  tools?: string[];
  callResult?: unknown;
  error?: string;
  stderrTail: string;
  ms: number;
}

/** npm ships as a resource: Contents/Resources/npm (bundle) or $HOMERUN_NPM_DIR. */
function npmDir(): string {
  if (process.env.HOMERUN_NPM_DIR) return process.env.HOMERUN_NPM_DIR;
  const inBundle = join(dirname(process.execPath), "..", "Resources", "npm");
  if (isCompiled && existsSync(inBundle)) return inBundle;
  throw new Error("bundled npm not found (set HOMERUN_NPM_DIR)");
}

export function mcpCommand(spec: McpProbeSpec): { cmd: string[]; env: Record<string, string> } {
  const root = join(dataDir(), "toolchains");
  const node = helperPath("node");
  const uv = helperPath("uv");
  // Only the bundled toolchain dir + system basics: no Homebrew, nvm, pyenv, ~/.local/bin.
  const PATH = [dirname(node), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const base: Record<string, string> = {
    PATH,
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "en_US.UTF-8",
  };
  if (spec.runner === "npx") {
    const npmrc = join(root, "npmrc");
    const globalrc = join(root, "npmrc-global");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Private npm config: never read the user's ~/.npmrc (tokens, private registries).
    writeFileSync(npmrc, `registry=${process.env.HOMERUN_NPM_REGISTRY ?? "https://registry.npmjs.org/"}\n`);
    writeFileSync(globalrc, "");
    return {
      cmd: [
        node,
        join(npmDir(), "bin", "npx-cli.js"),
        "--yes",
        ...(spec.bin ? [`--package=${spec.pkg}`, spec.bin] : [spec.pkg]),
        ...(spec.args ?? []),
      ],
      env: {
        ...base,
        npm_config_userconfig: npmrc,
        npm_config_globalconfig: globalrc,
        npm_config_cache: join(root, "npm-cache"),
        npm_config_prefix: join(root, "npm-prefix"),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        npm_config_loglevel: "warn",
      },
    };
  }
  return {
    cmd: [uv, "tool", "run", "--from", spec.pkg, spec.pkg.split(/[=<>~! ]/)[0]!, ...(spec.args ?? [])],
    env: {
      ...base,
      UV_NO_CONFIG: "1",
      UV_CACHE_DIR: join(root, "uv-cache"),
      UV_TOOL_DIR: join(root, "uv-tools"),
      UV_PYTHON_INSTALL_DIR: join(root, "uv-python"),
      // Never pick up /usr/bin/python3 (a CLT-install stub on a clean Mac) or Homebrew Python.
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_PYTHON_DOWNLOADS: "automatic",
      ...(process.env.HOMERUN_UV_INDEX_URL ? { UV_INDEX_URL: process.env.HOMERUN_UV_INDEX_URL } : {}),
    },
  };
}

export async function mcpProbe(spec: McpProbeSpec): Promise<McpProbeResult> {
  const t0 = Date.now();
  const { cmd, env } = mcpCommand(spec);
  const child = spawn(cmd[0]!, cmd.slice(1), { env, stdio: ["pipe", "pipe", "pipe"], cwd: env.TMPDIR });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d.toString()).slice(-4000)));
  const pending = new Map<number, (m: any) => void>();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (typeof m.id === "number" && pending.has(m.id)) pending.get(m.id)!(m);
      } catch {
        /* non-JSON noise on stdout */
      }
    }
  });
  const exited = new Promise<string>((r) => child.on("exit", (c, s) => r(`server exited code=${c} signal=${s}`)));
  let nextId = 1;
  const rpc = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), spec.timeoutMs ?? 180_000),
  );
  const race = <T>(p: Promise<T>) =>
    Promise.race([p, timeout, exited.then((e) => Promise.reject(new Error(e)))]);
  try {
    const init = await race(
      rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "homerund", version: "0.0.0-spike" },
      }),
    );
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await race(rpc("tools/list", {}));
    const call = await race(rpc("tools/call", { name: spec.tool, arguments: spec.toolArgs ?? {} }));
    return {
      ok: !call?.isError,
      command: cmd,
      serverInfo: init?.serverInfo,
      tools: (list?.tools ?? []).map((t: any) => t.name),
      callResult: call,
      stderrTail: stderr,
      ms: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, command: cmd, error: String(e), stderrTail: stderr, ms: Date.now() - t0 };
  } finally {
    child.kill("SIGTERM");
  }
}
