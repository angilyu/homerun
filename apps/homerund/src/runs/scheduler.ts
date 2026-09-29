import { publishLive } from "../store/events";
import { runsInState, type Pool, type RunRow } from "../store/rows";
import { log } from "../log";
import { CheckRunner } from "../monitors/check-runner";
import type { PowerAssertions } from "../power/power";
import type { RunContext } from "./context";
import { RunDriver } from "./driver";

/** Rule checks run in the runtime outside the slot limits (§5.3); this bounds them anyway. */
export const MAX_RULE_CHECKS = 8;

export type Runner = RunDriver | CheckRunner;

export interface PoolHooks {
  /** Called at the start of each pass: the fire scheduler turns ready fires into runs. */
  beforePump?(): void;
  /** Held while any run is `running`, so the computer does not sleep mid-run (§8.1). */
  power?: PowerAssertions;
}

/**
 * Slot pools (§5.3): 3 sessions and 2 monitors by default. Pending runs start FIFO by
 * `created_at`. A run waiting for input holds no slot. A thread whose previous run is still
 * being reaped waits, so two `claude` processes never share a session. Nothing that needs the
 * model starts until the shell has handed over the API key; rule checks need neither a slot nor
 * the key.
 */
export class Scheduler {
  private active = new Map<string, Runner>();
  private releasePower: (() => void) | null = null;
  private lastPosition = new Map<string, number>();
  private scheduled = false;
  private stopped = false;
  private unsubscribe: () => void;

  constructor(
    private ctx: RunContext,
    private hooks: PoolHooks = {},
  ) {
    this.unsubscribe = ctx.secrets.onChange(() => this.kick());
  }

  setHooks(h: PoolHooks): void {
    this.hooks = { ...this.hooks, ...h };
  }

  driverFor(runId: string): Runner | undefined {
    return this.active.get(runId);
  }

  get activeCount(): number {
    return this.active.size;
  }

  kick(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.stopped) this.pump();
    });
  }

  /** Start what fits; tell the rest where they are in the queue. */
  pump(): void {
    try {
      this.hooks.beforePump?.();
    } catch (e) {
      log.error("promoting scheduled fires failed", { error: e instanceof Error ? e.message : String(e) });
    }
    const ready = this.ctx.secrets.has("anthropic_api_key");
    const busyThreads = new Set([...this.active.values()].map((d) => d.threadId));
    const used: Record<Pool, number> = { session: 0, monitor: 0 };
    let rules = 0;
    for (const d of this.active.values()) {
      if (d instanceof CheckRunner && d.kind === "rule") rules++;
      else used[d.pool]++;
    }
    const position: Record<Pool, number> = { session: 0, monitor: 0 };
    const seen = new Set<string>();

    for (const row of runsInState(this.ctx.store, ["pending"])) {
      if (this.active.has(row.run_id)) continue;
      seen.add(row.run_id);
      if (row.monitor_phase === "rule_check") {
        if (!busyThreads.has(row.thread_id) && rules < MAX_RULE_CHECKS) {
          rules++;
          busyThreads.add(row.thread_id);
          this.launch(row.run_id, row);
        }
        continue;
      }
      if (ready && !busyThreads.has(row.thread_id) && used[row.pool] < this.ctx.config.limits[row.pool]) {
        used[row.pool]++;
        busyThreads.add(row.thread_id);
        this.lastPosition.delete(row.run_id);
        this.launch(row.run_id, row);
        continue;
      }
      const pos = ++position[row.pool];
      if (this.lastPosition.get(row.run_id) !== pos) {
        this.lastPosition.set(row.run_id, pos);
        publishLive(this.ctx.store, row.thread_id, row.run_id, "run.status", { state: "pending", detail: "queued", queue_position: pos });
      }
    }
    for (const id of [...this.lastPosition.keys()]) if (!seen.has(id)) this.lastPosition.delete(id);
  }

  private launch(runId: string, row: RunRow): void {
    const d: Runner = row.monitor_phase === "rule_check" || row.monitor_phase === "model_check" ? new CheckRunner(this.ctx, row, () => this.kick()) : new RunDriver(this.ctx, row);
    this.active.set(runId, d);
    this.syncPower();
    void d.done.then(() => {
      this.active.delete(runId);
      this.syncPower();
      this.kick();
    });
    try {
      d.start();
    } catch (e) {
      log.error("run driver failed to start", { run_id: runId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** One power assertion while anything runs; none while idle or only waiting for input (§8.1). */
  private syncPower(): void {
    const power = this.hooks.power;
    if (!power) return;
    if (this.active.size > 0 && !this.releasePower) this.releasePower = power.acquire("Homerun is running a task");
    else if (this.active.size === 0 && this.releasePower) {
      this.releasePower();
      this.releasePower = null;
    }
  }

  /** Graceful shutdown: stop starting runs, and let each active one wind down (§5.4). */
  async shutdown(graceMs: number): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    await Promise.all([...this.active.values()].map((d) => d.shutdown(graceMs)));
    this.releasePower?.();
    this.releasePower = null;
  }

  /** Tests simulating a crash: start nothing more, and leave active runs as they are. */
  halt(): void {
    this.stopped = true;
    this.unsubscribe();
  }

  /** Tests: wait until nothing is running. */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 || this.scheduled) {
      if (Date.now() > deadline) throw new Error("scheduler did not go idle");
      await Promise.race([...[...this.active.values()].map((d) => d.done), Bun.sleep(10)]);
    }
  }
}
