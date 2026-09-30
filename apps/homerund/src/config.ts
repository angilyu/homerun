import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_CONCURRENCY, type BuildChannel } from "@homerun/core";
import { chooseRunDir, dataDir as resolveDataDir, resolveBuildChannel, runningCompiled } from "@homerun/client";
import { resolveClaudeShell, type ClaudeShell } from "./agent/claude/shell";
import { secureDir } from "./platform/secure";
import { remoteConfig, type RemoteConfig } from "./remote/config";

export { DATA_DIR_NAME, SUN_PATH_MAX, chooseRunDir, resolveBuildChannel } from "@homerun/client";

/** macOS bundle identifier. */
export const APP_ID = "com.angilyu.homerun";
export const RUNTIME_VERSION: string = typeof HOMERUND_VERSION === "string" ? HOMERUND_VERSION : "0.2.0-dev";
/** True when running as a `bun build --compile` executable. */
export const isCompiled = runningCompiled(import.meta.url);

/**
 * The build channel fails closed (`resolveBuildChannel`): a compiled executable is release unless
 * it was built with an explicit `--define HOMERUND_BUILD='"development"'`, so a binary that forgot
 * the define never gets the development switches, dev tokens or base-URL overrides.
 */
export const BUILD_CHANNEL: BuildChannel = resolveBuildChannel(typeof HOMERUND_BUILD === "string" ? HOMERUND_BUILD : undefined, isCompiled);

/** A development-only switch was used in a release build. */
export class DevOnlyError extends Error {
  constructor(what: string) {
    super(`${what} is only available in development builds; this is a release build`);
    this.name = "DevOnlyError";
  }
}

export interface Limits {
  session: number;
  monitor: number;
}

/** A development-only replacement for how a stdio MCP package is launched. */
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
  /** Scratch working directories for chats (§2.1). */
  workspacesDir: string;
  /** TMPDIR for homerund itself: the SDK puts its `claude-resume-*` dirs here (F5). */
  tmpDir: string;
  logsDir: string;
  claudePath: string;
  /** The shell behind claude's Bash tool, and so the dialect its commands are in (`shell.ts`). */
  claudeShell: ClaudeShell;
  limits: Limits;
  /** The user's real home, passed to tools as HOMERUN_USER_HOME. */
  userHome: string;
  /** Development only: point `claude` at a replay or recording server. */
  anthropicBaseUrl: string | null;
  /** Development only: auto-allow calls that need approval. */
  devAutoApprove: boolean;
  /**
   * Development only: how a "Did this happen?" answer reaches the transcript (§5.4). `inject`
   * (the default) writes it as the call's `tool_result`; `truncate` forces the fallback, resuming
   * before the call, so tests can exercise it.
   */
  devAmbiguityMode: "inject" | "truncate";
  /** Development only: `package@version` → command, for local MCP fixtures. */
  devMcpOverrides: Record<string, McpOverride>;
  /** Default model for one-off chats (§7.3). */
  chatModel: string;
  chatFallbackModel: string | null;
  chatMaxBudgetUsd: number;
  /** Test hook: how long a graceful shutdown waits for in-flight tool calls. */
  shutdownGraceMs: number;
  /**
   * How long a run waits for an answer with its process alive before the call is deferred and
   * the process exits (§5.6 short waits). Development builds may shorten it for tests.
   */
  inputGraceMs: number;
  /** The relay and identity provider (§9, §10.4); null when this build has none. */
  remote: RemoteConfig | null;
}

/** §5.6: the grace period before a waiting call is deferred. */
export const INPUT_GRACE_MS = 120_000;

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

/**
 * A directory under the data dir. POSIX: 0700. Windows: created, inheriting the data dir's
 * private DACL (`secureDir` sets that on the data and run dirs).
 */
function ensureDir(d: string): string {
  if (process.platform === "win32") {
    mkdirSync(d, { recursive: true });
    return d;
  }
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return d;
}

/** Locate the bundled `claude` (§5.1). In development it comes from the SDK's platform package. */
export function findClaude(env: Record<string, string | undefined>): string {
  if (env.HOMERUN_CLAUDE_PATH) return env.HOMERUN_CLAUDE_PATH;
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const besideExe = join(dirname(process.execPath), exe);
  if (isCompiled && existsSync(besideExe)) return besideExe;
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  let dir = resolve(import.meta.dir);
  for (let i = 0; i < 8; i++) {
    for (const suffix of ["", "-musl"]) {
      const p = join(dir, "node_modules", "@anthropic-ai", pkg + suffix, exe);
      if (existsSync(p)) return p;
    }
    const pnpmDir = join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      const hit = [...new Bun.Glob(`@anthropic-ai+${pkg}@*/node_modules/@anthropic-ai/*/${exe}`).scanSync({ cwd: pnpmDir })][0];
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
  const dataDir = secureDir(resolveDataDir(env));
  const { runDir, socketPath } = chooseRunDir(dataDir);
  secureDir(runDir);

  const devOnly = (what: string, v: unknown) => {
    if (!dev && v) throw new DevOnlyError(what);
    return v;
  };
  const overridesFile = devOnly("--dev-mcp-overrides", option(argv, "dev-mcp-overrides") ?? env.HOMERUN_DEV_MCP_OVERRIDES) as string | undefined;
  const baseUrl = devOnly("HOMERUN_ANTHROPIC_BASE_URL", env.HOMERUN_ANTHROPIC_BASE_URL) as string | undefined;
  const autoApprove = devOnly("--dev-auto-approve", flag(argv, "dev-auto-approve") || env.HOMERUN_DEV_AUTO_APPROVE === "1") as boolean;

  const ambiguityMode = devOnly("HOMERUN_DEV_AMBIGUITY_MODE", env.HOMERUN_DEV_AMBIGUITY_MODE) as string | undefined;
  if (ambiguityMode !== undefined && ambiguityMode !== "inject" && ambiguityMode !== "truncate") {
    throw new Error(`HOMERUN_DEV_AMBIGUITY_MODE must be inject or truncate, not ${ambiguityMode}`);
  }

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
    claudeShell: resolveClaudeShell(process.platform, env),
    limits: {
      session: num(env.HOMERUN_MAX_SESSIONS, DEFAULT_CONCURRENCY.session),
      monitor: num(env.HOMERUN_MAX_MONITORS, DEFAULT_CONCURRENCY.monitor),
    },
    userHome: env.HOME ?? homedir(),
    anthropicBaseUrl: baseUrl ?? null,
    devAutoApprove: autoApprove,
    devAmbiguityMode: ambiguityMode === "truncate" ? "truncate" : "inject",
    devMcpOverrides: overridesFile ? (JSON.parse(readFileSync(overridesFile, "utf8")) as Record<string, McpOverride>) : {},
    chatModel: (dev && env.HOMERUN_CHAT_MODEL) || "opus",
    chatFallbackModel: dev && env.HOMERUN_CHAT_MODEL ? null : "sonnet",
    chatMaxBudgetUsd: num(dev ? env.HOMERUN_CHAT_MAX_BUDGET_USD : undefined, 2),
    shutdownGraceMs: num(dev ? env.HOMERUN_SHUTDOWN_GRACE_MS : undefined, 10_000),
    inputGraceMs: num(dev ? env.HOMERUN_INPUT_GRACE_MS : undefined, INPUT_GRACE_MS),
    remote: remoteConfig(env, dev, devOnly),
  };
}
