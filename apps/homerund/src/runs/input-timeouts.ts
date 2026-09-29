import { log } from "../log";
import type { Clock } from "../schedule/clock";
import { appendEvent } from "../store/events";
import { expiredInputRequests, getRunRow, nextInputExpiry, setInputRequestState, updateRun } from "../store/rows";
import type { GateResolver } from "./answers";
import type { RunContext } from "./context";
import { RunDriver } from "./driver";
import { finishRun } from "./finish";
import type { Scheduler } from "./scheduler";
import { specForRun } from "./specs";

/**
 * A task's input timeout (§5.6): `deny` resolves an unanswered approval or question as expired
 * (the call gets "timed out"; the run continues), `cancel_run` cancels the run, `wait` never
 * expires (reminders arrive with push, M9). Runs from the timer and at startup, so a request that
 * expired while Homerun was off is handled when it comes back. The timer is armed for the
 * earliest deadline only, and re-armed when a request with a deadline opens.
 */
export class InputTimeouts {
  private cancelTimer: (() => void) | null = null;
  private armedFor: number | null = null;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private ctx: RunContext,
    private clock: Clock,
    private gates: GateResolver,
    private scheduler: Scheduler,
  ) {}

  start(): void {
    this.unsubscribe = this.ctx.store.bus.subscribeAll((e) => {
      if (e.type === "input.requested" && (e.payload as { expires_at: number | null }).expires_at !== null) queueMicrotask(() => this.arm());
    });
    this.run();
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.disarm();
  }

  private run(): void {
    this.disarm();
    if (this.stopped) return;
    try {
      this.sweep(this.clock.now());
    } catch (e) {
      log.error("input timeout sweep failed", { error: e instanceof Error ? e.message : String(e) });
    }
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    const next = nextInputExpiry(this.ctx.store);
    if (next === this.armedFor) return;
    this.disarm();
    if (next === null) return;
    this.armedFor = next;
    this.cancelTimer = this.clock.setTimer(Math.max(0, next - this.clock.now()), () => this.run());
  }

  private disarm(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.armedFor = null;
  }

  /** Expire every request past its deadline. Returns the expired request ids. */
  sweep(now: number): string[] {
    const store = this.ctx.store;
    const out: string[] = [];
    for (const req of expiredInputRequests(store, now)) {
      const run = getRunRow(store, req.run_id);
      if (!run) continue;
      const action = specForRun(store, this.ctx.config, run).policy.input_timeout.action;
      let stopLive: RunDriver | null = null;
      store.tx(() => {
        setInputRequestState(store, req.request_id, "expired");
        appendEvent(store, run.thread_id, run.run_id, "input.resolved", {
          request_id: req.request_id,
          state: "expired",
          response: null,
          answered_by: null,
          surface: null,
          via: null,
        }, now);
        if (action !== "cancel_run") {
          this.gates.route(getRunRow(store, run.run_id)!, req.request_id, now);
          return;
        }
        const d = this.scheduler.driverFor(run.run_id);
        if (d instanceof RunDriver && d.state === "running") {
          stopLive = d;
          return;
        }
        updateRun(store, run.run_id, { stop_requested_at: now, stop_by: null });
        appendEvent(store, run.thread_id, run.run_id, "run.cancelled", { by: null, reason: "input_timeout" }, now);
        finishRun(store, run.run_id, "cancelled", null, { now });
      });
      (stopLive as RunDriver | null)?.requestStop(null, "input_timeout");
      out.push(req.request_id);
      log.info("input request expired", { run_id: run.run_id, request_id: req.request_id, action });
    }
    if (out.length) this.scheduler.kick();
    return out;
  }
}
