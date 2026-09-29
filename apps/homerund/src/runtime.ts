import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Device } from "@homerun/core";
import { ClaudeEngine } from "./agent/claude/engine";
import { prepareShellHome } from "./agent/claude/env";
import { McpLauncher } from "./agent/claude/mcp";
import type { AgentEngine } from "./agent/engine";
import { Bus } from "./bus";
import { RUNTIME_VERSION, type Config } from "./config";
import { log } from "./log";
import { Authenticator, newDevToken, writeDevToken } from "./rpc/auth";
import { makeHandlers } from "./rpc/handlers";
import { RpcServer } from "./rpc/server";
import type { RunContext } from "./runs/context";
import { InputTimeouts } from "./runs/input-timeouts";
import { RunManager } from "./runs/manager";
import { pidAlive } from "./agent/claude/spawn";
import { bootTime, killEscapedTools, killStaleGroup, sweepTemp } from "./runs/process-groups";
import { recoverRun, type RecoveryOutcome } from "./runs/recovery";
import { Scheduler } from "./runs/scheduler";
import { SecretStore } from "./secrets";
import { openDb } from "./store/db";
import { migrate, type MigrateOutcome } from "./store/migrate";
import { ensureDevice, getRunRow, runsInState, setRunState, updateRun, type RunRow } from "./store/rows";
import { DigestScheduler } from "./monitors/digest";
import { platformAssertions, type PowerAssertions } from "./power/power";
import { deviceTimezone, systemClock, type Clock } from "./schedule/clock";
import { FireScheduler } from "./schedule/fire-scheduler";
import { SqliteSessionStore } from "./store/session-store";
import { Store } from "./store/store";

export interface RuntimeOptions {
  config: Config;
  /** The shell's launch token (64 hex); null when started without a shell (tests, dev). */
  launchToken: string | null;
  /** Defaults to the real `claude` engine. */
  engine?: (store: Store) => AgentEngine;
  /** Check every RPC result against its core schema (tests). */
  checkResults?: boolean;
  now?: () => number;
  /** Wall time and timers for the scheduler (§8); a fake clock in tests. Overrides `now`. */
  clock?: Clock;
  /** Defaults to caffeinate on macOS (§8.1). */
  power?: PowerAssertions;
  /** The device's IANA zone; defaults to the system's. */
  deviceZone?: () => string;
  /** Point this process's TMPDIR at `<data>/tmp` (default). In-process tests turn it off. */
  setTmpdir?: boolean;
}

export interface StartupReport {
  migration: MigrateOutcome;
  killedGroups: number[];
  /** Tool processes that escaped their claude group (F8). */
  killedTools: number[];
  swept: string[];
  recovered: Array<{ run_id: string; outcome: RecoveryOutcome }>;
}

export interface Runtime {
  config: Config;
  store: Store;
  device: Device;
  secrets: SecretStore;
  scheduler: Scheduler;
  manager: RunManager;
  server: RpcServer;
  fires: FireScheduler;
  digest: DigestScheduler;
  timeouts: InputTimeouts;
  clock: Clock;
  devToken: string | null;
  report: StartupReport;
  /** Graceful shutdown (stdin EOF): runs stay `running` and resume at the next start (§5.4). */
  shutdown(): Promise<void>;
}

export class AlreadyRunningLockError extends Error {
  constructor(readonly pid: number) {
    super(`another homerund (pid ${pid}) holds the lock`);
  }
}

/**
 * Start the runtime (plan §5): lock, migrate, kill stale process groups, sweep caches, recover
 * interrupted runs, then serve and schedule. Nothing runs an agent before recovery finishes.
 */
export async function startRuntime(o: RuntimeOptions): Promise<Runtime> {
  const { config } = o;
  const releaseLock = takeLock(config.runDir);
  let db: Database | null = null;
  try {
    db = openDb(config.dbPath);
    const migration = migrate(db, { backupDir: config.backupDir, runtimeVersion: RUNTIME_VERSION });
    if (migration.status === "migrated") log.info("migrated", { ...migration });
    const store = new Store(db, new Bus());
    const device = ensureDevice(store);
    const boot = bootTime();

    // 1. Stale groups first: a claude still running from the last runtime could finish a call
    //    after we decide it is ambiguous (§5.4 step 1).
    const markers = [config.claudePath, "/bin/bash", ...Object.values(config.devMcpOverrides).map((m) => m.command)];
    const killedGroups: number[] = [];
    // A run in its short wait for an answer had a live process (§5.6): it recovers like a
    // running one, so an answer that never reached the call is applied.
    const shortWaits = store.db.query<{ run_id: string }, []>("SELECT run_id FROM runs WHERE state = 'waiting_input' AND claude_pid IS NOT NULL").all().map((r) => r.run_id);
    const withGroups = store.db
      .query<RunRow, []>("SELECT * FROM runs WHERE claude_pid IS NOT NULL OR reap_pgid IS NOT NULL")
      .all();
    for (const r of withGroups) {
      for (const pgid of new Set([r.claude_pid, r.reap_pgid].filter((p): p is number => p !== null))) {
        if (await killStaleGroup(pgid, r.claude_boot, boot, markers, config.claudePath)) killedGroups.push(pgid);
      }
      updateRun(store, r.run_id, { claude_pid: null, reap_pgid: null });
    }
    const killedTools = await killEscapedTools(config.claudeConfigDir);

    // 2. Caches a killed claude leaves behind (F1, F5). The SDK puts claude-resume-* in TMPDIR.
    if (o.setTmpdir !== false) process.env.TMPDIR = config.tmpDir;
    const { removed: swept } = sweepTemp(config.claudeConfigDir, config.tmpDir);
    prepareShellHome(config.shellHome);

    // 3. Recover every run that was running (§5.4). A monitor's check only read, so it simply
    //    runs again (§8.3); its act step recovers like any run.
    const recovered: StartupReport["recovered"] = [];
    const clock: Clock = o.clock ?? (o.now ? { now: o.now, setTimer: systemClock.setTimer } : systemClock);
    const t = () => clock.now();
    for (const r of runsInState(store, ["running"])) {
      if (r.monitor_phase !== "rule_check" && r.monitor_phase !== "model_check") continue;
      setRunState(store, r.run_id, "pending", { claude_pid: null, stop_requested_at: null, stop_by: null });
      recovered.push({ run_id: r.run_id, outcome: { kind: "requeued", retried: [] } });
    }
    for (const r of [...runsInState(store, ["running"]), ...shortWaits.map((id) => getRunRow(store, id)!)]) {
      const outcome = recoverRun(store, r.run_id, "runtime_restart", t());
      recovered.push({ run_id: r.run_id, outcome });
      log.info("recovered run", { run_id: r.run_id, outcome: outcome.kind });
    }

    const secrets = new SecretStore();
    const engine = o.engine ? o.engine(store) : new ClaudeEngine({ claudePath: config.claudePath, claudeConfigDir: config.claudeConfigDir, sessionStore: new SqliteSessionStore(store) });
    const ctx: RunContext = {
      store,
      config,
      device,
      secrets,
      engine,
      mcp: new McpLauncher(config.devMcpOverrides),
      bootTime: boot,
      now: t,
    };
    const deviceZone = o.deviceZone ?? deviceTimezone;
    const scheduler = new Scheduler(ctx, { power: o.power ?? platformAssertions() });
    const manager = new RunManager(ctx, scheduler);
    const timeouts = new InputTimeouts(ctx, clock, manager.gateResolver, scheduler);
    let server: RpcServer | null = null;
    const digest = new DigestScheduler(store, deviceZone, (d) => server?.broadcast("health.digest_ready", { digest: d }));
    const fires = new FireScheduler(
      store,
      clock,
      {
        kick: () => scheduler.kick(),
        onTick: (n) => {
          digest.tick(n);
        },
        nextWake: () => digest.nextAt(clock.now()),
      },
      deviceZone,
    );
    scheduler.setHooks({ beforePump: () => fires.promoteAll() });
    manager.setHooks({ schedulesChanged: () => fires.run(), deviceZone });

    const devToken = config.build === "development" ? newDevToken() : null;
    if (devToken) writeDevToken(config.runDir, devToken);
    const auth = new Authenticator(config.build, o.launchToken, devToken);
    server = new RpcServer({
      socketPath: config.socketPath,
      handlers: makeHandlers({ ctx, manager, auth, digest, settingsChanged: () => fires.run() }),
      ...(o.checkResults ? { checkResults: true } : {}),
      onNotification: (method, params) => {
        if (method === "power.will_sleep") fires.willSleep((params as { at: number }).at);
        else if (method === "power.did_wake") {
          const p = params as { at: number; slept_at: number | null };
          fires.didWake(p.at, p.slept_at);
        }
      },
    });
    await server.start();
    fires.start();
    timeouts.start();
    scheduler.kick();
    const srv = server;

    let stopping: Promise<void> | null = null;
    const openDbRef = db;
    return {
      config,
      store,
      device,
      secrets,
      scheduler,
      manager,
      server: srv,
      fires,
      digest,
      timeouts,
      clock,
      devToken,
      report: { migration, killedGroups, killedTools, swept, recovered },
      shutdown: () =>
        (stopping ??= (async () => {
          srv.stop();
          fires.stop();
          timeouts.stop();
          await scheduler.shutdown(config.shutdownGraceMs);
          openDbRef.close();
          if (devToken) rmSync(join(config.runDir, "dev-token"), { force: true });
          releaseLock();
          log.info("stopped");
        })()),
    };
  } catch (e) {
    db?.close();
    releaseLock();
    throw e;
  }
}

/**
 * One runtime per data dir: `<run dir>/homerund.lock` holds the owner's pid. A lock whose pid is
 * dead (the runtime was killed) is taken over; a live one means another runtime is serving.
 */
export function takeLock(runDir: string): () => void {
  const path = join(runDir, "homerund.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path, { force: true });
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) throw new AlreadyRunningLockError(pid);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`could not take ${path}`);
}

function alive(pid: number): boolean {
  return pidAlive(pid);
}
