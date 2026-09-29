import { randomUUID } from "node:crypto";
import { CheckResult, MonitorSpec, type Origin, type RunError } from "@homerun/core";
import { RunSetupError } from "../agent/claude/mcp";
import { log } from "../log";
import { now, type RunContext } from "../runs/context";
import { finishRun } from "../runs/finish";
import { appendEvent, publishLive } from "../store/events";
import { addRunInput, getRunRow, getTaskVersionSpec, setRunState, updateRun, type RunRow } from "../store/rows";
import { getMonitorState } from "../store/schedule-rows";
import { ensureRunStarted } from "./complete";
import { runModelCheck } from "./model-check";
import { evaluateRule } from "./rules";
import { observe, SourceError } from "./sources";

type Phase = "idle" | "running" | "stopping" | "shutdown" | "done";

/**
 * The check step of a monitor run (§8.3 steps 1–3). A rule check runs here in the runtime with
 * no model; a model check is one small `query()`. Either way the check only reads, so a check
 * interrupted by a crash or shutdown simply runs again.
 *
 * - No change: the run succeeds at once, saving the new state in the same transaction and
 *   writing nothing to the thread (step 6).
 * - Changed: one transaction records the result, moves the run to its act step and queues the
 *   findings as the act step's first message; the pool then starts it like any run (step 4).
 */
export class CheckRunner {
  readonly runId: string;
  readonly threadId: string;
  readonly pool = "monitor" as const;
  readonly kind: "rule" | "model";
  readonly done: Promise<void>;
  private phase: Phase = "idle";
  private abort = new AbortController();
  private resolveDone!: () => void;
  private stopBy: Origin | null = null;

  constructor(
    private ctx: RunContext,
    row: RunRow,
    private kick: () => void,
  ) {
    this.runId = row.run_id;
    this.threadId = row.thread_id;
    this.kind = row.monitor_phase === "rule_check" ? "rule" : "model";
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  get state(): Phase {
    return this.phase;
  }

  private get store() {
    return this.ctx.store;
  }

  start(): void {
    if (this.phase !== "idle") return;
    const row = getRunRow(this.store, this.runId);
    if (!row || row.state !== "pending" || !row.task_id || !row.task_version) return this.finishDone();
    const prev = getMonitorState(this.store, row.task_id);
    // `started_at` stays null: a quiet run has no visible start, and the act step's start is
    // the run's `run.started` (§8.3 step 6).
    setRunState(this.store, this.runId, "running", { state_version: prev?.version ?? 0 });
    this.phase = "running";
    const spec = MonitorSpec.parse(getTaskVersionSpec(this.store, row.task_id, row.task_version));
    void this.check(row, spec, prev).then(
      (r) => this.onChecked(r.result, r.costUsd, r.sessionId),
      (e) => this.onFailed(e),
    );
  }

  private async check(row: RunRow, spec: MonitorSpec, prev: ReturnType<typeof getMonitorState>) {
    const check = spec.check;
    const opts = { roots: spec.policy.roots, userHome: this.ctx.config.userHome, signal: this.abort.signal };
    if (check.kind === "rule") {
      const obs = await observe(check.source, opts);
      return { result: evaluateRule(check, prev?.state ?? null, obs), costUsd: 0, sessionId: null };
    }
    const obs = check.source ? await observe(check.source, opts) : null;
    if (this.phase !== "running") throw new DOMException("aborted", "AbortError");
    return runModelCheck(this.ctx, row.run_id, row.thread_id, spec, prev, obs, this.abort.signal, (pid) => {
      if (getRunRow(this.store, this.runId)?.state === "running") updateRun(this.store, this.runId, { claude_pid: pid, claude_boot: this.ctx.bootTime, claude_started_at: now(this.ctx) });
    });
  }

  private onChecked(raw: CheckResult, costUsd: number, sessionId: string | null): void {
    if (this.phase === "shutdown") return this.finishDone();
    const result = CheckResult.safeParse(raw);
    if (!result.success) return this.onFailed(new SourceError("invalid_check_result", "The check's new state is too large or not valid JSON."));
    if (this.phase === "stopping") return this.cancel(costUsd);
    const t = now(this.ctx);
    const fields = { check_result: JSON.stringify(result.data), cost_usd: round6(costUsd), check_session_id: sessionId, claude_pid: null };
    try {
      if (!result.data.changed) {
        this.store.tx(() => {
          updateRun(this.store, this.runId, fields);
          finishRun(this.store, this.runId, "succeeded", null, { now: t });
        });
      } else {
        this.store.tx(() => {
          const row = getRunRow(this.store, this.runId)!;
          updateRun(this.store, this.runId, { ...fields, monitor_phase: "act" });
          addRunInput(this.store, this.runId, randomUUID(), findingsMessage(row, result.data), false, t);
          setRunState(this.store, this.runId, "pending");
        });
        this.kick();
      }
    } catch (e) {
      log.error("monitor check could not be recorded", { run_id: this.runId, error: e instanceof Error ? e.message : String(e) });
    }
    this.finishDone();
  }

  private onFailed(e: unknown): void {
    if (this.phase === "shutdown") return this.finishDone();
    const costUsd = (e as { costUsd?: number } | null)?.costUsd ?? 0;
    if (this.phase === "stopping" || (e instanceof DOMException && e.name === "AbortError")) return this.cancel(costUsd);
    const err: RunError =
      e instanceof SourceError || e instanceof RunSetupError
        ? { code: e.code, message: e.message.slice(0, 10_000) }
        : { code: "internal_error", message: (e instanceof Error ? e.message : String(e)).slice(0, 10_000) };
    if (!(e instanceof SourceError || e instanceof RunSetupError)) log.error("monitor check failed", { run_id: this.runId, error: err.message });
    try {
      this.store.tx(() => {
        updateRun(this.store, this.runId, { cost_usd: round6(costUsd), claude_pid: null });
        finishRun(this.store, this.runId, "failed", err, { now: now(this.ctx) });
      });
    } catch (x) {
      log.error("monitor check failure could not be recorded", { run_id: this.runId, error: x instanceof Error ? x.message : String(x) });
    }
    this.finishDone();
  }

  private cancel(costUsd: number): void {
    const t = now(this.ctx);
    this.store.tx(() => {
      const row = getRunRow(this.store, this.runId)!;
      if (row.state !== "running") return;
      updateRun(this.store, this.runId, { cost_usd: round6(costUsd), claude_pid: null });
      ensureRunStarted(this.store, row, t);
      appendEvent(this.store, this.threadId, this.runId, "run.cancelled", { by: this.stopBy, reason: "user" }, t);
      finishRun(this.store, this.runId, "cancelled", null, { now: t });
    });
    this.finishDone();
  }

  /** runs.stop: the check is abandoned where it is; it has changed nothing. */
  requestStop(by: Origin | null): void {
    if (this.phase !== "running") return;
    this.phase = "stopping";
    this.stopBy = by;
    const t = now(this.ctx);
    updateRun(this.store, this.runId, { stop_requested_at: t, stop_by: by ? JSON.stringify(by) : null });
    publishLive(this.store, this.threadId, this.runId, "run.status", { state: "running", detail: "stopping" });
    this.abort.abort();
  }

  steer(_input?: unknown): void {}

  /** Runtime shutdown: drop the check; the run stays `running` and is checked again at the next start. */
  async shutdown(graceMs: number): Promise<void> {
    if (this.phase === "running" || this.phase === "stopping") {
      this.phase = "shutdown";
      this.abort.abort();
      await Promise.race([this.done, Bun.sleep(graceMs)]);
      this.finishDone();
    }
  }

  private finishDone(): void {
    if (this.phase === "done") return;
    this.phase = "done";
    this.resolveDone();
  }
}

/** The act step's first message: what the check found (§8.3 step 4). */
export function findingsMessage(row: RunRow, r: CheckResult): string {
  const when = row.trigger === "manual" ? "A check you asked for" : row.trigger === "catchup" ? "A late check (catching up after a missed time)" : "The scheduled check";
  return `${when} found a change.\n\nEvidence:\n${r.evidence}\n\nAct on it as your instructions describe, then report briefly what changed and what you did.`;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
