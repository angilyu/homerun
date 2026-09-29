import { authorityAfterMessage, isTerminal, type Origin, type RunState, type TaskSpec, type Thread } from "@homerun/core";
import { appendEvent, findUserMessage } from "../store/events";
import {
  activeRunRow,
  addRunInput,
  createTask,
  createThread,
  getRunRow,
  getTask,
  getThread,
  tryInsertRun,
  updateRun,
} from "../store/rows";
import { AmbiguityResolver, type Answer, type AnswerResult } from "./ambiguity";
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

  constructor(
    private ctx: RunContext,
    private scheduler: Scheduler,
  ) {
    this.resolver = new AmbiguityResolver(ctx.store, ctx.config.devAmbiguityMode, () => this.scheduler.kick());
  }

  /** input.answer for "Did this happen?" (§5.4). Throws AnswerRejected. */
  answerAmbiguous(requestId: string, a: Answer): AnswerResult {
    return this.resolver.answer(requestId, a, now(this.ctx));
  }

  createThread(title?: string): Thread {
    return createThread(this.ctx.store, { title: title ?? null, now: now(this.ctx) });
  }

  createTask(spec: TaskSpec, fromThreadId?: string) {
    if (fromThreadId) throw new InvalidRequestError("Promoting a chat into a task arrives in a later version of Homerun.");
    return createTask(this.ctx.store, this.ctx.device.device_id, spec, now(this.ctx));
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
        if (task.kind !== "session") throw new InvalidRequestError("Monitor runs arrive in a later version of Homerun.");
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
    if (state === "running" && driver) {
      driver.requestStop(by);
      return getRunRow(store, runId)!.state as RunState;
    }
    const t = now(this.ctx);
    store.tx(() => {
      updateRun(store, runId, { stop_requested_at: t, stop_by: by ? JSON.stringify(by) : null });
      appendEvent(store, row.thread_id, runId, "run.cancelled", { by, reason: "user" }, t);
      finishRun(store, runId, "cancelled", null, { now: t, unresolved: UNKNOWN_TEXT });
    });
    this.scheduler.kick();
    return "cancelled";
  }
}
