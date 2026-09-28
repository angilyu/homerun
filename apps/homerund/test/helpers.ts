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
  const engine = new FakeEngine(opts.script);
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
