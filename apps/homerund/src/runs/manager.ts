import { authorityAfterMessage, isTerminal, type MonitorSpec, type Origin, type RunState, type Task, type TaskSpec, type Thread } from "@homerun/core";
import { ensureRunStarted } from "../monitors/complete";
import { monitorThread, monthCost } from "../schedule/fire-scheduler";
import { appendEvent, findUserMessage } from "../store/events";
import {
  activeRunRow,
  addRunInput,
  archiveTaskRow,
  createTask,
  createThread,
  getRunRow,
  getTask,
  getThread,
  tryInsertRun,
  updateRun,
  updateTaskSpec,
} from "../store/rows";
import { scheduleForTask, setScheduleEnabled, syncSchedule } from "../store/schedule-rows";
import { AmbiguityResolver, type Answer, type AnswerResult } from "./ambiguity";
import { GateResolver } from "./answers";
import { RunDriver } from "./driver";
import { now, type RunContext } from "./context";
import { finishRun } from "./finish";
import { UNKNOWN_TEXT } from "./resume";
import type { Scheduler } from "./scheduler";

/** A request about something that does not exist (mapped to NOT_FOUND). */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** A well-formed request the runtime cannot honour (mapped to INVALID_PARAMS). */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/** `expected_version` is not current (mapped to CONFLICT). */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`the task is at version ${currentVersion}`);
    this.name = "VersionConflictError";
  }
}

/** A budget cap blocks the action (§7.4; mapped to BUDGET_EXCEEDED). */
export class BudgetCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetCapError";
  }
}

export interface ManagerHooks {
  /** A schedule was created, edited, enabled or disabled: evaluate again. */
  schedulesChanged(): void;
  /** The device's IANA zone, stored with interval schedules (§8.1). */
  deviceZone(): string;
}

export type Disposition = "started_run" | "steered" | "held";

export interface SendMessage {
  thread_id: string;
  client_msg_id: string;
  text: string;
  sent_at?: number;
}

/** Messages, stops and thread/task creation: the write side of the protocol (plan §3.1). */
export class RunManager {
  private resolver: AmbiguityResolver;
  private gates: GateResolver;

  private hooks: ManagerHooks = { schedulesChanged: () => {}, deviceZone: () => "UTC" };

  constructor(
    private ctx: RunContext,
    private scheduler: Scheduler,
  ) {
    this.resolver = new AmbiguityResolver(ctx.store, ctx.config.devAmbiguityMode, () => this.scheduler.kick());
    const live = (runId: string) => {
      const d = this.scheduler.driverFor(runId);
      return d instanceof RunDriver ? d : null;
    };
    this.gates = new GateResolver(ctx.store, {
      liveGate: (runId, requestId) => live(runId)?.gateFor(requestId) ?? null,
      wake: (runId, requestId) => live(runId)?.wake(requestId),
      requeued: () => this.scheduler.kick(),
    });
  }

  /**
   * input.answer for an approval or a question (§5.6): first answer wins, then the answer goes
   * to the waiting call or requeues the run. Throws AnswerRejected.
   */
  answerInput(requestId: string, a: Answer): AnswerResult & { grant_id?: string } {
    return this.gates.answer(requestId, a, now(this.ctx));
  }

  /** The approval/question resolver, shared with the input-timeout sweep. */
  get gateResolver(): GateResolver {
    return this.gates;
  }

  /** input.answer for "Did this happen?" (§5.4). Throws AnswerRejected. */
  answerAmbiguous(requestId: string, a: Answer): AnswerResult {
    return this.resolver.answer(requestId, a, now(this.ctx));
  }

  createThread(title?: string): Thread {
    return createThread(this.ctx.store, { title: title ?? null, now: now(this.ctx) });
  }

  setHooks(h: ManagerHooks): void {
    this.hooks = h;
  }

  createTask(spec: TaskSpec, fromThreadId?: string) {
    if (fromThreadId) throw new InvalidRequestError("Promoting a chat into a task arrives in a later version of Homerun.");
    if (spec.kind === "monitor") checkMonitorSupported(spec);
    const store = this.ctx.store;
    const t = now(this.ctx);
    const out = store.tx(() => {
      const created = createTask(store, this.ctx.device.device_id, spec, t);
      if (spec.kind === "monitor") syncSchedule(store, created.task.task_id, spec.schedule, this.hooks.deviceZone(), t);
      return created;
    });
    if (spec.kind === "monitor") this.hooks.schedulesChanged();
    return out;
  }

  /**
   * tasks.update: a new version, if `expected_version` is current. A changed schedule counts from
   * now: an edit never creates missed fires for the past (§8.1).
   */
  updateTask(taskId: string, spec: TaskSpec, expectedVersion: number): Task {
    const store = this.ctx.store;
    const t = now(this.ctx);
    const task = store.tx(() => {
      const cur = getTask(store, taskId);
      if (!cur) throw new NotFoundError("task");
      if (cur.archived_at !== null) throw new InvalidRequestError("This task is archived.");
      if (cur.version !== expectedVersion) throw new VersionConflictError(cur.version);
      if (cur.kind !== spec.kind) throw new InvalidRequestError(`A ${cur.kind} task cannot become a ${spec.kind}; create a new task instead.`);
      if (spec.kind === "monitor") checkMonitorSupported(spec);
      const updated = updateTaskSpec(store, taskId, spec, t);
      if (spec.kind === "monitor") syncSchedule(store, taskId, spec.schedule, this.hooks.deviceZone(), t);
      return updated;
    });
    if (spec.kind === "monitor") this.hooks.schedulesChanged();
    return task;
  }

  /** tasks.archive: the task stops firing; its history stays. */
  archiveTask(taskId: string): number {
    const store = this.ctx.store;
    const t = now(this.ctx);
    const at = store.tx(() => {
      if (!getTask(store, taskId)) throw new NotFoundError("task");
      const archivedAt = archiveTaskRow(store, taskId, t);
      const s = scheduleForTask(store, taskId);
      if (s && s.paused_reason !== "archived") setScheduleEnabled(store, s.schedule_id, "archived", t);
      return archivedAt;
    });
    this.hooks.schedulesChanged();
    return at;
  }

  /** schedules.set_enabled: the user pauses or resumes a schedule (§8.2). */
  setScheduleEnabled(scheduleId: string, enabled: boolean) {
    const store = this.ctx.store;
    const t = now(this.ctx);
    const row = store.tx(() => {
      const s = store.db.query<{ task_id: string }, [string]>("SELECT task_id FROM schedules WHERE schedule_id = ?").get(scheduleId);
      if (!s) throw new NotFoundError("schedule");
      const task = getTask(store, s.task_id);
      if (enabled && task && task.archived_at !== null) throw new InvalidRequestError("This task is archived.");
      return setScheduleEnabled(store, scheduleId, enabled ? null : "user", t);
    });
    this.hooks.schedulesChanged();
    return row;
  }

  /**
   * tasks.run_now: a manual monitor run, through the whole check → act pipeline. If the monitor
   * is already running, that run is returned rather than a second one queued.
   */
  runNow(taskId: string, origin: Origin): { run_id: string; thread_id: string } {
    const store = this.ctx.store;
    const out = store.tx(() => {
      const task = getTask(store, taskId);
      if (!task) throw new NotFoundError("task");
      if (task.archived_at !== null) throw new InvalidRequestError("This task is archived.");
      if (task.spec.kind !== "monitor") throw new InvalidRequestError("Only monitors run on demand; send a message to the task's thread instead.");
      const spec = task.spec;
      const threadId = monitorThread(store, taskId);
      if (!threadId) throw new NotFoundError("thread");
      const active = activeRunRow(store, threadId);
      if (active) return { run_id: active.run_id, thread_id: threadId };
      const t = now(this.ctx);
      const cap = spec.budget.monthly_cap_usd;
      const zone = scheduleForTask(store, taskId)?.timezone ?? this.hooks.deviceZone();
      if (cap !== undefined && monthCost(store, taskId, zone, t) >= cap) {
        throw new BudgetCapError(`This monitor's spend this month reached its $${cap} cap.`);
      }
      const run = tryInsertRun(store, {
        threadId,
        taskId,
        taskVersion: task.version,
        deviceId: this.ctx.device.device_id,
        trigger: "manual",
        originDevice: origin.device_id,
        originSurface: origin.surface,
        authority: authorityAfterMessage("full", origin.surface),
        pool: "monitor",
        now: t,
        monitorPhase: spec.check.kind === "rule" ? "rule_check" : "model_check",
      });
      if (!run) throw new Error("no run after an empty thread");
      return { run_id: run.run_id, thread_id: threadId };
    });
    this.scheduler.kick();
    return out;
  }

  /**
   * One transaction (§5.7): an idempotent replay returns the stored answer; otherwise the message
   * starts a run if the thread has none active (the partial unique index decides), steers the
   * running or queued one, or is held while the run waits for input.
   */
  sendMessage(p: SendMessage, origin: Origin): { seq: number; run_id: string; disposition: Disposition } {
    const store = this.ctx.store;
    let steer: { runId: string; uuid: string; text: string } | null = null;
    const out = store.tx(() => {
      const thread = getThread(store, p.thread_id);
      if (!thread) throw new NotFoundError("thread");
      const dup = findUserMessage(store, p.thread_id, p.client_msg_id);
      if (dup) return { seq: dup.seq, run_id: dup.run_id!, disposition: dup.payload.disposition };

      let taskId: string | null = null;
      let taskVersion: number | null = null;
      if (thread.task_id) {
        const task = getTask(store, thread.task_id);
        if (!task) throw new NotFoundError("task");
        if (task.archived_at !== null) throw new InvalidRequestError("This task is archived.");
        if (task.kind !== "session") throw new InvalidRequestError("Replying on a monitor's thread arrives in a later version of Homerun.");
        taskId = task.task_id;
        taskVersion = task.version;
      }

      const t = now(this.ctx);
      const sentAt = p.sent_at !== undefined && p.sent_at < t ? { sent_at: p.sent_at } : {};
      const created = tryInsertRun(store, {
        threadId: thread.thread_id,
        taskId,
        taskVersion,
        deviceId: this.ctx.device.device_id,
        trigger: "message",
        originDevice: origin.device_id,
        originSurface: origin.surface,
        authority: authorityAfterMessage("full", origin.surface),
        pool: "session",
        now: t,
      });
      if (created) {
        addRunInput(store, created.run_id, p.client_msg_id, p.text, false, t);
        const ev = appendEvent(store, thread.thread_id, created.run_id, "user.message", {
          client_msg_id: p.client_msg_id,
          text: p.text,
          origin,
          disposition: "started_run",
          ...sentAt,
        }, t);
        store.afterCommit(() => this.scheduler.kick());
        return { seq: ev.seq, run_id: created.run_id, disposition: "started_run" as const };
      }

      const active = activeRunRow(store, thread.thread_id);
      if (!active) throw new Error("no active run after a unique-index conflict");
      const held = active.state === "waiting_input";
      const authority = authorityAfterMessage(active.authority as "full", origin.surface);
      if (authority !== active.authority) updateRun(store, active.run_id, { authority });
      addRunInput(store, active.run_id, p.client_msg_id, p.text, held, t);
      const disposition: Disposition = held ? "held" : "steered";
      const ev = appendEvent(store, thread.thread_id, active.run_id, "user.message", {
        client_msg_id: p.client_msg_id,
        text: p.text,
        origin,
        disposition,
        ...sentAt,
      }, t);
      if (!held) steer = { runId: active.run_id, uuid: p.client_msg_id, text: p.text };
      return { seq: ev.seq, run_id: active.run_id, disposition };
    });
    // A queued run picks the message up from run_inputs when it starts.
    if (steer) {
      const s = steer as { runId: string; uuid: string; text: string };
      this.scheduler.driverFor(s.runId)?.steer({ uuid: s.uuid, text: s.text });
    }
    return out;
  }

  /** runs.stop (§5.7): a queued or waiting run is cancelled at once; a running one at its next safe point. */
  stop(runId: string, by: Origin | null): RunState {
    const store = this.ctx.store;
    const row = getRunRow(store, runId);
    if (!row) throw new NotFoundError("run");
    const state = row.state as RunState;
    if (isTerminal(state)) return state;
    const driver = this.scheduler.driverFor(runId);
    // A run in its short wait for an answer still has its process: it stops like a running one.
    const live = state === "running" || (state === "waiting_input" && driver instanceof RunDriver && driver.state === "running");
    if (live && driver) {
      driver.requestStop(by);
      return getRunRow(store, runId)!.state as RunState;
    }
    const t = now(this.ctx);
    store.tx(() => {
      updateRun(store, runId, { stop_requested_at: t, stop_by: by ? JSON.stringify(by) : null });
      if (row.monitor_phase) ensureRunStarted(store, row, t);
      appendEvent(store, row.thread_id, runId, "run.cancelled", { by, reason: "user" }, t);
      finishRun(store, runId, "cancelled", null, { now: t, unresolved: UNKNOWN_TEXT });
    });
    this.scheduler.kick();
    return "cancelled";
  }
}

/** Sources Homerun cannot observe yet are refused when the task is saved, not when it fires. */
function checkMonitorSupported(spec: MonitorSpec): void {
  const src = spec.check.source;
  if (src?.type === "homerun_tool") throw new InvalidRequestError("Checks that use Homerun's own tools arrive in a later version of Homerun.");
  if (spec.tools.homerun.length) throw new InvalidRequestError("Homerun's own tools arrive in a later version of Homerun.");
}
