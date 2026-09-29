import { randomUUID } from "node:crypto";
import {
  CAPABILITIES,
  METHODS,
  PROTOCOL_VERSION,
  RPC_ERROR,
  SUPPORTED_PROTOCOL,
  SURFACE_OF_ROLE,
  negotiateCapabilities,
  negotiateProtocol,
  type CallerRole,
  type MethodName,
  type Origin,
  type ThreadEvent,
} from "@homerun/core";
import type { z } from "zod";
import { RUNTIME_VERSION } from "../config";
import { AnswerRejected } from "../runs/ambiguity";
import { now, type RunContext } from "../runs/context";
import type { RunManager } from "../runs/manager";
import { getBlob } from "../store/content";
import { eventsAfter, historyPage, lastSeq } from "../store/events";
import { getInputRequest, getRunRow, getTask, getThread, listRuns, listTasks, listThreadSummaries, pendingInputRequests, rowToRun } from "../store/rows";
import { allSchedules, coverageDays, editMonitorState, getMonitorState, rowToScheduleState, scheduleForTask } from "../store/schedule-rows";
import { computeDigest, type DigestScheduler } from "../monitors/digest";
import type { Authenticator } from "./auth";

/** A JSON-RPC error a handler wants to send as is. */
export class RpcFail extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    /** Close the connection after the reply (failed hello). */
    readonly close = false,
  ) {
    super(message);
  }
}

/** What a handler sees of its connection. */
export interface Conn {
  role: CallerRole | null;
  setRole(role: CallerRole): void;
  /** Send a notification on this connection. */
  notify(method: string, params: unknown): void;
  subscriptions: Map<string, () => void>;
}

export interface HandlerDeps {
  ctx: RunContext;
  manager: RunManager;
  auth: Authenticator;
  digest: DigestScheduler;
  /** The daily digest's settings changed: re-arm the timers. */
  settingsChanged?: () => void;
}

/** A result, plus an optional step to run after the reply is written (subscription backlog). */
type ResultIn<M extends MethodName> = z.input<(typeof METHODS)[M]["result"]>;
export type Reply<M extends MethodName> = ResultIn<M> | { result: ResultIn<M>; after: () => void };

type Params<M extends MethodName> = z.output<(typeof METHODS)[M]["params"]>;
type Handler<M extends MethodName> = (conn: Conn, p: Params<M>) => Reply<M>;
export type Handlers = { [M in MethodName]?: Handler<M> };

const BACKLOG_PAGE = 1000;
const HISTORY_DEFAULT = 100;
const THREADS_DEFAULT = 50;

export function makeHandlers(d: HandlerDeps): Handlers {
  const { ctx, manager } = d;
  const store = ctx.store;
  const originOf = (c: Conn): Origin => ({ device_id: ctx.device.device_id, surface: SURFACE_OF_ROLE[c.role!] });
  const notFound = (what: string) => new RpcFail(RPC_ERROR.NOT_FOUND, `${what} not found`);

  return {
    hello: (conn, p) => {
      const protocol = negotiateProtocol(SUPPORTED_PROTOCOL, p.protocol);
      if (protocol === null) {
        throw new RpcFail(RPC_ERROR.INCOMPATIBLE_PROTOCOL, "No protocol version in common.", { supported: { ...SUPPORTED_PROTOCOL } }, true);
      }
      const ok = d.auth.check(p);
      if (!ok.ok) throw new RpcFail(RPC_ERROR.UNAUTHENTICATED, ok.message, undefined, true);
      conn.setRole(p.role);
      return {
        protocol,
        runtime_version: RUNTIME_VERSION,
        device_id: ctx.device.device_id,
        role: p.role,
        capabilities: negotiateCapabilities(CAPABILITIES, p.capabilities),
      };
    },

    ping: () => ({ pong: true as const, runtime_version: RUNTIME_VERSION, protocol: PROTOCOL_VERSION }),

    "secrets.set": (_c, p) => {
      ctx.secrets.set(p.name, p.value);
      return { ok: true as const };
    },
    "secrets.clear": (_c, p) => {
      ctx.secrets.clear(p.name);
      return { ok: true as const };
    },

    "threads.list": (_c, p) =>
      listThreadSummaries(store, {
        limit: p.limit ?? THREADS_DEFAULT,
        ...(p.updated_before !== undefined ? { updatedBefore: p.updated_before } : {}),
        ...(p.task_id ? { taskId: p.task_id } : {}),
      }),

    "threads.create": (_c, p) => ({ thread: manager.createThread(p.title) }),

    "threads.history": (_c, p) => {
      if (!getThread(store, p.thread_id)) throw notFound("thread");
      return historyPage(store, p.thread_id, p.before_seq, p.limit ?? HISTORY_DEFAULT);
    },

    "threads.subscribe": (conn, p) => {
      if (!getThread(store, p.thread_id)) throw notFound("thread");
      const subscription_id = randomUUID();
      // Register and read the backlog in the same tick: nothing is missed or sent twice.
      const buffered: ThreadEvent[] = [];
      let live = false;
      const send = (event: ThreadEvent) => conn.notify("thread.event", { subscription_id, event });
      const unsubscribe = store.bus.subscribe(p.thread_id, (e) => {
        if (live) send(e);
        else buffered.push(e);
      });
      conn.subscriptions.set(subscription_id, unsubscribe);
      const last = lastSeq(store, p.thread_id);
      return {
        result: { subscription_id, last_seq: last },
        after: () => {
          for (let from = p.after_seq; from < last; ) {
            const page = eventsAfter(store, p.thread_id, from, BACKLOG_PAGE).filter((e) => e.seq <= last);
            if (!page.length) break;
            for (const e of page) send(e);
            from = page[page.length - 1]!.seq;
          }
          for (const e of buffered.splice(0)) send(e);
          live = true;
        },
      };
    },

    "threads.unsubscribe": (conn, p) => {
      conn.subscriptions.get(p.subscription_id)?.();
      conn.subscriptions.delete(p.subscription_id);
      return { ok: true as const };
    },

    "messages.send": (conn, p) => manager.sendMessage(p, originOf(conn)),

    "runs.get": (_c, p) => {
      const r = getRunRow(store, p.run_id);
      if (!r) throw notFound("run");
      return { run: rowToRun(r) };
    },
    "runs.list": (_c, p) => ({
      runs: listRuns(store, {
        ...(p.thread_id ? { threadId: p.thread_id } : {}),
        ...(p.task_id ? { taskId: p.task_id } : {}),
        ...(p.states ? { states: p.states } : {}),
        ...(p.limit ? { limit: p.limit } : {}),
      }),
    }),
    "runs.stop": (conn, p) => ({ state: manager.stop(p.run_id, originOf(conn)) }),

    "tasks.create": (_c, p) => {
      const { task, thread } = manager.createTask(p.spec, p.from_thread_id);
      return { task, thread_id: thread.thread_id };
    },
    "tasks.get": (_c, p) => {
      const t = getTask(store, p.task_id);
      if (!t) throw notFound("task");
      return { task: t };
    },
    "tasks.list": (_c, p) => ({ tasks: listTasks(store, p.kind, p.include_archived ?? false) }),
    "tasks.update": (_c, p) => ({ task: manager.updateTask(p.task_id, p.spec, p.expected_version) }),
    "tasks.archive": (_c, p) => ({ archived_at: manager.archiveTask(p.task_id) }),
    "tasks.run_now": (conn, p) => manager.runNow(p.task_id, originOf(conn)),

    "schedules.list": (_c, p) => ({
      schedules: allSchedules(store)
        .filter((s) => !p.task_id || s.task_id === p.task_id)
        .map(rowToScheduleState),
    }),
    "schedules.set_enabled": (_c, p) => ({ schedule: rowToScheduleState(manager.setScheduleEnabled(p.schedule_id, p.enabled)) }),
    "schedules.coverage": (_c, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      const s = scheduleForTask(store, p.task_id);
      if (!s) throw notFound("schedule");
      if (p.to_day < p.from_day) throw new RpcFail(RPC_ERROR.VALIDATION_FAILED, "to_day is before from_day");
      return { days: coverageDays(store, s.schedule_id, p.from_day, p.to_day) };
    },

    "monitors.state.get": (_c, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      return { state: getMonitorState(store, p.task_id) };
    },
    "monitors.state.set": (_c, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      return { state: editMonitorState(store, p.task_id, p.state, p.expected_version, now(ctx)) };
    },
    "monitors.state.reset": (_c, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      editMonitorState(store, p.task_id, null, p.expected_version, now(ctx));
      return { ok: true as const };
    },

    "health.digest": (_c, p) => ({ digest: computeDigest(store, p.from, p.to, d.digest.settings().timezone, now(ctx)) }),
    "health.settings.get": () => ({ settings: d.digest.settings() }),
    "health.settings.set": (_c, p) => {
      const settings = d.digest.setSettings(p.settings, now(ctx));
      d.settingsChanged?.();
      return { settings };
    },

    "blobs.get": (_c, p) => {
      const b = getBlob(store, p.sha256, now(ctx));
      if (!b) throw notFound("blob");
      if (p.offset > b.size) throw new RpcFail(RPC_ERROR.VALIDATION_FAILED, `offset ${p.offset} is past the end of the blob (${b.size} bytes)`);
      const end = Math.min(b.size, p.offset + p.length);
      return {
        sha256: p.sha256,
        size: b.size,
        offset: p.offset,
        data: Buffer.from(b.bytes.subarray(p.offset, end)).toString("base64"),
        eof: end >= b.size,
      };
    },

    "input.list_pending": (_c, p) => ({ requests: pendingInputRequests(store, p.thread_id ? { threadId: p.thread_id } : {}) }),
    "input.answer": (conn, p) => {
      const r = getInputRequest(store, p.request_id);
      if (!r) throw notFound("input request");
      if (r.prompt.type !== "ambiguous_tool_call") {
        throw new RpcFail(RPC_ERROR.UNAVAILABLE, "Answering approvals and questions arrives in a later version of Homerun.", { not_implemented: true });
      }
      try {
        return manager.answerAmbiguous(p.request_id, { response: p.response, role: conn.role!, via: p.via, origin: originOf(conn) });
      } catch (e) {
        if (e instanceof AnswerRejected) throw new RpcFail(e.reason === "authority" ? RPC_ERROR.AUTHORITY_INSUFFICIENT : RPC_ERROR.VALIDATION_FAILED, e.message);
        throw e;
      }
    },
  };
}
