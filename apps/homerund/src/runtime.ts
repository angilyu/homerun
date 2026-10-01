import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Device } from "@homerun/core";
import { productionAppAttestPolicy } from "@homerun/protocol";
import { ClaudeEngine } from "./agent/claude/engine";
import { prepareShellHome } from "./agent/claude/env";
import { McpLauncher } from "./agent/claude/mcp";
import type { AgentEngine } from "./agent/engine";
import { Bus } from "./bus";
import { RUNTIME_VERSION, type Config } from "./config";
import { log } from "./log";
import { Authenticator, newDevToken, writeDevToken } from "./rpc/auth";
import { CliAccess } from "./rpc/cli-access";
import { makeHandlers } from "./rpc/handlers";
import { RpcServer } from "./rpc/server";
import type { RunContext } from "./runs/context";
import { InputTimeouts } from "./runs/input-timeouts";
import { RunManager } from "./runs/manager";
import { processes } from "./platform/processes";
import { sweepTemp } from "./runs/process-groups";
import { recoverRun, type RecoveryOutcome } from "./runs/recovery";
import { Scheduler } from "./runs/scheduler";
import { SecretStore } from "./secrets";
import { useCliToken } from "./store/cli-tokens";
import { openDb } from "./store/db";
import { migrate, type MigrateOutcome } from "./store/migrate";
import { ensureDevice, getInputRequest, getRunRow, runsInState, setRunState, updateRun, type RunRow } from "./store/rows";
import { DigestScheduler } from "./monitors/digest";
import { platformAssertions, type PowerAssertions } from "./power/power";
import { deviceTimezone, systemClock, type Clock } from "./schedule/clock";
import { FireScheduler } from "./schedule/fire-scheduler";
import { SqliteSessionStore } from "./store/session-store";
import { Store } from "./store/store";
import { verifyAnthropicKey, type KeyCheck } from "./secrets/verify";
import { ThreadChanges } from "./threads/changes";
import { Notifier } from "./notify/notifier";
import { ShellSecrets } from "./shell-secrets";
import { RemoteService, type RemoteTuning } from "./remote/service";

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
  /** secrets.verify; defaults to asking the Anthropic API (§7.2). Tests answer themselves. */
  verifyKey?: (key: string) => Promise<KeyCheck>;
  /** How long missed-check notifications from one wake are coalesced (§8.2). */
  notifyCoalesceMs?: number;
  /** How long a connection may wait before `hello` (tests shorten it). */
  helloTimeoutMs?: number;
  /** Remote access timings and fetch, for tests. */
  remote?: RemoteTuning;
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
  shellSecrets: ShellSecrets;
  remote: RemoteService;
  scheduler: Scheduler;
  manager: RunManager;
  server: RpcServer;
  cliAccess: CliAccess;
  fires: FireScheduler;
  digest: DigestScheduler;
  timeouts: InputTimeouts;
  changes: ThreadChanges;
  notifier: Notifier;
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
    // Before anything is spawned: on Windows, what the runtime starts dies with it.
    processes.adoptTree();
    const boot = processes.bootTime();

    // 1. Stale groups first: a claude still running from the last runtime could finish a call
    //    after we decide it is ambiguous (§5.4 step 1).
    const markers = [config.claudePath, "/bin/bash", ...Object.values(config.devMcpOverrides).map((m) => m.command)];
    const killedGroups: number[] = [];
    // A run in its short wait for an answer had a live process (§5.6): it recovers like a
    // running one, so an answer that never reached the call is applied. Its `claude_pid` is
    // what marks it, so recovery clears it in the same commit, not this loop.
    const shortWaits = store.db.query<{ run_id: string }, []>("SELECT run_id FROM runs WHERE state = 'waiting_input' AND claude_pid IS NOT NULL").all().map((r) => r.run_id);
    const withGroups = store.db
      .query<RunRow, []>("SELECT * FROM runs WHERE claude_pid IS NOT NULL OR reap_pgid IS NOT NULL")
      .all();
    for (const r of withGroups) {
      for (const pgid of new Set([r.claude_pid, r.reap_pgid].filter((p): p is number => p !== null))) {
        if (await processes.killStaleGroup(pgid, r.claude_boot, boot, markers, config.claudePath)) killedGroups.push(pgid);
      }
      updateRun(store, r.run_id, shortWaits.includes(r.run_id) ? { reap_pgid: null } : { claude_pid: null, reap_pgid: null });
    }
    const killedTools = await processes.killEscapedTools(config.claudeConfigDir);

    // 2. Caches a killed claude leaves behind (F1, F5). The SDK puts claude-resume-* in TMPDIR.
    if (o.setTmpdir !== false) {
      process.env.TMPDIR = config.tmpDir;
      // Windows reads TEMP and TMP, not TMPDIR (os.tmpdir(), GetTempPath).
      if (process.platform === "win32") process.env.TEMP = process.env.TMP = config.tmpDir;
    }
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
    // Local notifications go to the shell connection only: `notification.*` lists no other recipient (§8.2, §9.7).
    // …and, as sealed pushes, to paired iPhones (§9.7).
    let remoteOut: Pick<RemoteService, "push" | "withdraw"> | null = null;
    const notifier = new Notifier(
      store,
      (m, p) => {
        server?.broadcast(m, p);
        if (m === "notification.requested") remoteOut?.push(p as Parameters<RemoteService["push"]>[0]);
        else if (m === "notification.withdrawn") remoteOut?.withdraw((p as { key: string }).key);
      },
      o.notifyCoalesceMs,
    );
    const digest = new DigestScheduler(store, deviceZone, (d) => {
      server?.broadcast("health.digest_ready", { digest: d });
      notifier.digestReady(d);
    });
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
    const auth = new Authenticator(config.build, o.launchToken, devToken, (token) => useCliToken(store, token, clock.now()));
    const cliAccess = new CliAccess({
      store,
      clock,
      toShell: (m, p) => server?.broadcast(m, p),
      closeTokenConnections: (tokenId) => server?.closeTokenConnections(tokenId),
    });
    const shellSecrets = new ShellSecrets(secrets, () => server?.shell() ?? null);
    const changes = new ThreadChanges(store, device.device_id, (summary) => server?.broadcast("threads.changed", { summary }));
    const remote = new RemoteService({
      config: config.remote,
      store,
      secrets,
      shellSecrets,
      now: t,
      broadcast: (m, p) => server?.broadcast(m, p),
      adopt: (sink, peer) => {
        if (!server) throw new Error("the RPC server isn't running");
        return server.adopt(sink, peer);
      },
      hostname: device.hostname,
      // A development build also trusts the App Attest development environment (Xcode builds).
      appAttest: productionAppAttestPolicy(config.build === "development"),
      approvalKeyRenewed: (dev) => notifier.approvalKeyRenewed(dev, t()),
      effects: {
        sendMessage: (p, origin) => manager.sendMessage(p, origin),
        createThread: (title, taskId) => manager.createThread(title, taskId),
        answer: (requestId, a) => {
          const r = getInputRequest(store, requestId);
          if (!r) throw new Error("no such input request");
          return r.prompt.type === "ambiguous_tool_call" ? manager.answerAmbiguous(requestId, a) : manager.answerInput(requestId, a);
        },
        touch: (threadId) => changes.touch(threadId),
      },
      ...o.remote,
    });
    remoteOut = remote;
    server = new RpcServer({
      socketPath: config.socketPath,
      runDir: config.runDir,
      handlers: makeHandlers({
        ctx,
        manager,
        auth,
        digest,
        changes,
        settingsChanged: () => fires.run(),
        cliAccess,
        shellSecrets,
        remote,
        shellConnected: (conn) => {
          notifier.replayPending((m, p) => conn.notify(m, p));
          cliAccess.replay((m, p) => conn.notify(m, p));
          void shellSecrets.flush();
          remote.shellConnected();
        },
        verifyKey: o.verifyKey ?? ((key) => verifyAnthropicKey(key, config.anthropicBaseUrl)),
      }),
      ...(o.checkResults ? { checkResults: true } : {}),
      ...(o.helloTimeoutMs ? { helloTimeoutMs: o.helloTimeoutMs } : {}),
      onConnectionClosed: (conn) => cliAccess.cancel(conn),
      onNotification: (method, params) => {
        if (method === "power.will_sleep") fires.willSleep((params as { at: number }).at);
        else if (method === "power.did_wake") {
          const p = params as { at: number; slept_at: number | null };
          fires.didWake(p.at, p.slept_at);
          remote.wake();
        }
      },
    });
    await server.start();
    changes.start();
    notifier.start();
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
      shellSecrets,
      remote,
      scheduler,
      manager,
      server: srv,
      cliAccess,
      fires,
      digest,
      timeouts,
      changes,
      notifier,
      clock,
      devToken,
      report: { migration, killedGroups, killedTools, swept, recovered },
      shutdown: () =>
        (stopping ??= (async () => {
          cliAccess.stop();
          remote.stop();
          srv.stop();
          changes.stop();
          notifier.stop();
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
  return processes.pidAlive(pid);
}
