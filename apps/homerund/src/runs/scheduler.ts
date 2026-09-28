import { publishLive } from "../store/events";
import { runsInState, type Pool, type RunRow } from "../store/rows";
import { log } from "../log";
import type { RunContext } from "./context";
import { RunDriver } from "./driver";

/**
 * Slot pools (§5.3): 3 sessions and 2 monitors by default. Pending runs start FIFO by
 * `created_at`. A run waiting for input holds no slot. A thread whose previous run is still
 * being reaped waits, so two `claude` processes never share a session. Nothing starts until the
 * shell has handed over the API key.
 */
export class Scheduler {
  private active = new Map<string, RunDriver>();
  private lastPosition = new Map<string, number>();
  private scheduled = false;
  private stopped = false;
  private unsubscribe: () => void;

  constructor(private ctx: RunContext) {
    this.unsubscribe = ctx.secrets.onChange(() => this.kick());
  }

  driverFor(runId: string): RunDriver | undefined {
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
    const ready = this.ctx.secrets.has("anthropic_api_key");
    const busyThreads = new Set([...this.active.values()].map((d) => d.threadId));
    const used: Record<Pool, number> = { session: 0, monitor: 0 };
    for (const d of this.active.values()) used[d.pool]++;
    const position: Record<Pool, number> = { session: 0, monitor: 0 };
    const seen = new Set<string>();

    for (const row of runsInState(this.ctx.store, ["pending"])) {
      if (this.active.has(row.run_id)) continue;
      seen.add(row.run_id);
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
    const d = new RunDriver(this.ctx, row);
    this.active.set(runId, d);
    void d.done.then(() => {
      this.active.delete(runId);
      this.kick();
    });
    try {
      d.start();
    } catch (e) {
      log.error("run driver failed to start", { run_id: runId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Graceful shutdown: stop starting runs, and let each active one wind down (§5.4). */
  async shutdown(graceMs: number): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    await Promise.all([...this.active.values()].map((d) => d.shutdown(graceMs)));
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
