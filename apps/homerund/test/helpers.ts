import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Origin, PersistedThreadEvent, ThreadEvent } from "@homerun/core";
import { FakeEngine, type FakeScript } from "../src/agent/fake-engine";
import { McpLauncher } from "../src/agent/claude/mcp";
import { Bus } from "../src/bus";
import { loadConfig, type Config } from "../src/config";
import { setLogSink } from "../src/log";
import type { RunContext } from "../src/runs/context";
import { RunManager } from "../src/runs/manager";
import { Scheduler } from "../src/runs/scheduler";
import { SecretStore } from "../src/secrets";
import { openDb } from "../src/store/db";
import { eventsAfter } from "../src/store/events";
import { migrate } from "../src/store/migrate";
import { ensureDevice } from "../src/store/rows";
import { Store } from "../src/store/store";
import { RpcClient } from "../src/rpc/client";
import { startRuntime, type Runtime } from "../src/runtime";
import { NoopAssertions, type PowerAssertions } from "../src/power/power";
import type { Clock } from "../src/schedule/clock";

export const MOCK_KEY = "sk-ant-mock-not-a-real-key";

export interface TestRuntime {
  dir: string;
  config: Config;
  store: Store;
  ctx: RunContext;
  engine: FakeEngine;
  scheduler: Scheduler;
  manager: RunManager;
  live: ThreadEvent[];
  logs: string[];
  close(): void;
}

/** A runtime on a temporary data dir with the fake engine: no claude, no network. */
export function testRuntime(opts: { script?: FakeScript; env?: Record<string, string>; key?: boolean; dir?: string } = {}): TestRuntime {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "hr-test-"));
  const logs: string[] = [];
  setLogSink((l) => logs.push(l), "debug");
  const config = loadConfig({ env: { HOMERUN_DATA_DIR: dir, HOMERUN_CLAUDE_PATH: "/usr/bin/false", HOME: dir, ...opts.env } });
  const db = openDb(config.dbPath);
  migrate(db, { backupDir: config.backupDir, runtimeVersion: "test" });
  const store = new Store(db, new Bus());
  const live: ThreadEvent[] = [];
  store.bus.subscribeAll((e) => live.push(e));
  const secrets = new SecretStore();
  if (opts.key !== false) secrets.set("anthropic_api_key", MOCK_KEY);
  const engine = new FakeEngine(opts.script).attach(store);
  const ctx: RunContext = { store, config, device: ensureDevice(store), secrets, engine, mcp: new McpLauncher(config.devMcpOverrides), bootTime: 1 };
  const scheduler = new Scheduler(ctx);
  const manager = new RunManager(ctx, scheduler);
  return {
    dir,
    config,
    store,
    ctx,
    engine,
    scheduler,
    manager,
    live,
    logs,
    close() {
      db.close();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function persisted(store: Store, threadId: string): PersistedThreadEvent[] {
  return eventsAfter(store, threadId, 0);
}

export function types(store: Store, threadId: string): string[] {
  return persisted(store, threadId).map((e) => e.type);
}

export const uuid = () => crypto.randomUUID();

export async function until(pred: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

export const DESKTOP = (deviceId: string): Origin => ({ device_id: deviceId as Origin["device_id"], surface: "desktop" });

export const LAUNCH_TOKEN = "a".repeat(64);

export interface SocketRuntime {
  dir: string;
  rt: Runtime;
  engine: FakeEngine;
  shell(): Promise<RpcClient>;
  dev(): Promise<RpcClient>;
  /** Stop serving without the graceful path, like a SIGKILL of homerund (the DB stays as is). */
  crash(): void;
  close(): Promise<void>;
}

/** The whole runtime (startRuntime) on a temporary data dir with the fake engine, served on a socket. */
export async function socketRuntime(
  opts: { script?: FakeScript; env?: Record<string, string>; dir?: string; engine?: FakeEngine; clock?: Clock; power?: PowerAssertions; deviceZone?: string } = {},
): Promise<SocketRuntime> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "hr-rpc-"));
  const logs: string[] = [];
  setLogSink((l) => logs.push(l), "debug");
  const config = loadConfig({ env: { HOMERUN_DATA_DIR: dir, HOMERUN_CLAUDE_PATH: "/usr/bin/false", HOME: dir, ...opts.env } });
  const engine = opts.engine ?? new FakeEngine(opts.script);
  const rt = await startRuntime({
    config,
    launchToken: LAUNCH_TOKEN,
    engine: (store) => engine.attach(store),
    checkResults: true,
    setTmpdir: false,
    power: opts.power ?? new NoopAssertions(),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.deviceZone ? { deviceZone: () => opts.deviceZone! } : {}),
  });
  const clients: RpcClient[] = [];
  const track = async (p: Promise<RpcClient>) => {
    const c = await p;
    clients.push(c);
    return c;
  };
  let crashed = false;
  return {
    dir,
    rt,
    engine,
    shell: () => track(RpcClient.open(config.socketPath, "shell", { kind: "launch_token", token: LAUNCH_TOKEN })),
    dev: () => track(RpcClient.open(config.socketPath, "cli_dev", { kind: "dev_token", token: rt.devToken! })),
    crash() {
      crashed = true;
      for (const c of clients) c.close();
      rt.server.stop();
      rt.scheduler.halt();
      rt.fires.halt();
      rt.store.db.close();
    },
    async close() {
      for (const c of clients) c.close();
      if (!crashed) await rt.shutdown();
      if (!opts.dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A minimal valid session task spec (core TaskSpec, format 1). */
export function sessionSpec(o: { builtin?: string[]; mcp_servers?: unknown[]; name?: string; prompt?: string; roots?: unknown[]; max_run_usd?: number } = {}) {
  return {
    kind: "session" as const,
    format: 1 as const,
    name: o.name ?? "t",
    prompt: o.prompt ?? "p",
    budget: { max_run_usd: o.max_run_usd ?? 1 },
    tools: { builtin: o.builtin ?? ["Bash"], mcp_servers: o.mcp_servers ?? [], homerun: [] },
    policy: {
      roots: o.roots ?? [],
      egress: { mode: "allowlist", domains: [] },
      bash_patterns: [],
      use_shell_environment: false,
      input_timeout: { action: "wait", remind_after_ms: null },
      retention_days: 30,
    },
    model: { model: "haiku" },
  };
}

/** A minimal valid monitor spec (core MonitorSpec, format 1). */
export function monitorSpec(o: {
  name?: string;
  schedule?: unknown;
  check: unknown;
  roots?: string[];
  max_run_usd?: number;
  monthly_cap_usd?: number;
  act_instructions?: string;
}) {
  return {
    kind: "monitor" as const,
    format: 1 as const,
    name: o.name ?? "watch",
    prompt: "Watch the thing.",
    budget: { max_run_usd: o.max_run_usd ?? 1, ...(o.monthly_cap_usd !== undefined ? { monthly_cap_usd: o.monthly_cap_usd } : {}) },
    tools: { builtin: ["Read"], mcp_servers: [], homerun: [] },
    policy: {
      roots: o.roots ?? [],
      egress: { mode: "allowlist", domains: [] },
      bash_patterns: [],
      use_shell_environment: false,
      input_timeout: { action: "wait", remind_after_ms: null },
      retention_days: 30,
    },
    schedule: o.schedule ?? { kind: "cron", cron: "*/5 * * * *", timezone: "America/Los_Angeles", catchup: "run_once", max_catchup: 3 },
    check: o.check,
    act: { model: { model: "haiku" }, ...(o.act_instructions ? { instructions: o.act_instructions } : {}) },
  };
}
