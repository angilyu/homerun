import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONCURRENCY, type BuildChannel } from "@homerun/core";

/** macOS bundle identifier; also names the Application Support folder. */
export const APP_ID = "com.angilyu.homerun";

export const RUNTIME_VERSION: string = typeof HOMERUND_VERSION === "string" ? HOMERUND_VERSION : "0.2.0-dev";
/** Release builds are compiled with `--define HOMERUND_BUILD='"release"'`. Everything else is development. */
export const BUILD_CHANNEL: BuildChannel = typeof HOMERUND_BUILD === "string" && HOMERUND_BUILD === "release" ? "release" : "development";

/** True when running as a `bun build --compile` executable. */
export const isCompiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

/** `sun_path` is 104 bytes on macOS (§5.2). */
export const SUN_PATH_MAX = 104;

export interface Limits {
  session: number;
  monitor: number;
}

/** A development-only replacement for how a stdio MCP package is launched (plan Q3). */
export interface McpOverride {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Config {
  build: BuildChannel;
  dataDir: string;
  runDir: string;
  socketPath: string;
  dbPath: string;
  backupDir: string;
  /** Homerun-private CLAUDE_CONFIG_DIR (§5.3). A cache, never ~/.claude. */
  claudeConfigDir: string;
  /** HOME for the Bash tool's clean shell (§5.3, F9). */
  shellHome: string;
  /** Scratch working directories for chats (plan Q16). */
  workspacesDir: string;
  /** TMPDIR for homerund itself: the SDK puts its `claude-resume-*` dirs here (F5). */
  tmpDir: string;
  logsDir: string;
  claudePath: string;
  limits: Limits;
  /** The user's real home, passed to tools as HOMERUN_USER_HOME. */
  userHome: string;
  /** Development only: point `claude` at a replay or recording server. */
  anthropicBaseUrl: string | null;
  /** Development only: auto-allow calls that need approval (plan Q2). */
  devAutoApprove: boolean;
  /** Development only: `package@version` → command, for local MCP fixtures (plan Q3). */
  devMcpOverrides: Record<string, McpOverride>;
  /** Default model for one-off chats (plan Q4). */
  chatModel: string;
  chatFallbackModel: string | null;
  chatMaxBudgetUsd: number;
  /** Test hook: how long a graceful shutdown waits for in-flight tool calls. */
  shutdownGraceMs: number;
}

export interface ConfigInput {
  env?: Record<string, string | undefined>;
  argv?: string[];
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

function ensureDir(d: string): string {
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

/** `<data>/run/homerund.sock`, or `$TMPDIR/hr-<uid>/homerund.sock` when that exceeds `sun_path` (§5.2). */
export function chooseRunDir(dataDir: string, tmp = tmpdir(), uid = userInfo().uid): { runDir: string; socketPath: string } {
  const primary = join(dataDir, "run");
  if (Buffer.byteLength(join(primary, "homerund.sock")) < SUN_PATH_MAX) return { runDir: primary, socketPath: join(primary, "homerund.sock") };
  const fallback = join(tmp, `hr-${uid}`);
  const sock = join(fallback, "homerund.sock");
  if (Buffer.byteLength(sock) >= SUN_PATH_MAX) throw new Error(`socket path too long even in the fallback: ${sock}`);
  return { runDir: fallback, socketPath: sock };
}

/** Locate the bundled `claude` (§5.1). In development it comes from the SDK's platform package. */
export function findClaude(env: Record<string, string | undefined>): string {
  if (env.HOMERUN_CLAUDE_PATH) return env.HOMERUN_CLAUDE_PATH;
  const besideExe = join(dirname(process.execPath), "claude");
  if (isCompiled && existsSync(besideExe)) return besideExe;
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  let dir = resolve(import.meta.dir);
  for (let i = 0; i < 8; i++) {
    for (const suffix of ["", "-musl"]) {
      const p = join(dir, "node_modules", "@anthropic-ai", pkg + suffix, "claude");
      if (existsSync(p)) return p;
    }
    const pnpmDir = join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      const hit = [...new Bun.Glob(`@anthropic-ai+${pkg}@*/node_modules/@anthropic-ai/*/claude`).scanSync({ cwd: pnpmDir })][0];
      if (hit) return join(pnpmDir, hit);
    }
    dir = dirname(dir);
  }
  throw new Error("bundled claude not found (set HOMERUN_CLAUDE_PATH)");
}

export function loadConfig(input: ConfigInput = {}): Config {
  const env = input.env ?? process.env;
  const argv = input.argv ?? [];
  const build = BUILD_CHANNEL;
  const dev = build === "development";
  const dataDir = ensureDir(resolve(env.HOMERUN_DATA_DIR ?? join(homedir(), "Library", "Application Support", APP_ID)));
  const { runDir, socketPath } = chooseRunDir(dataDir);
  ensureDir(runDir);

  const devOnly = (what: string, v: unknown) => {
    if (!dev && v) throw new Error(`${what} is only available in development builds`);
    return v;
  };
  const overridesFile = devOnly("--dev-mcp-overrides", option(argv, "dev-mcp-overrides") ?? env.HOMERUN_DEV_MCP_OVERRIDES) as string | undefined;
  const baseUrl = devOnly("HOMERUN_ANTHROPIC_BASE_URL", env.HOMERUN_ANTHROPIC_BASE_URL) as string | undefined;
  const autoApprove = devOnly("--dev-auto-approve", flag(argv, "dev-auto-approve") || env.HOMERUN_DEV_AUTO_APPROVE === "1") as boolean;

  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    build,
    dataDir,
    runDir,
    socketPath,
    dbPath: join(dataDir, "homerun.db"),
    backupDir: ensureDir(join(dataDir, "backups")),
    claudeConfigDir: ensureDir(join(dataDir, "claude-config")),
    shellHome: ensureDir(join(dataDir, "shell-home")),
    workspacesDir: ensureDir(join(dataDir, "workspaces")),
    tmpDir: ensureDir(join(dataDir, "tmp")),
    logsDir: ensureDir(join(dataDir, "logs")),
    claudePath: findClaude(env),
    limits: {
      session: num(env.HOMERUN_MAX_SESSIONS, DEFAULT_CONCURRENCY.session),
      monitor: num(env.HOMERUN_MAX_MONITORS, DEFAULT_CONCURRENCY.monitor),
    },
    userHome: env.HOME ?? homedir(),
    anthropicBaseUrl: baseUrl ?? null,
    devAutoApprove: autoApprove,
    devMcpOverrides: overridesFile ? (JSON.parse(readFileSync(overridesFile, "utf8")) as Record<string, McpOverride>) : {},
    chatModel: (dev && env.HOMERUN_CHAT_MODEL) || "opus",
    chatFallbackModel: dev && env.HOMERUN_CHAT_MODEL ? null : "sonnet",
    chatMaxBudgetUsd: num(dev ? env.HOMERUN_CHAT_MAX_BUDGET_USD : undefined, 2),
    shutdownGraceMs: num(dev ? env.HOMERUN_SHUTDOWN_GRACE_MS : undefined, 10_000),
  };
}
