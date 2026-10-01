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
  policyNeedsFullApp,
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
import { getGrant, insertGrant, listGrants, revokeGrant } from "../store/grants";
import { eventsAfter, historyPage, lastSeq } from "../store/events";
import { getInputRequest, getRunRow, getTask, getThread, listRuns, listTasks, listThreadSummaries, markRead, pendingInputRequests, rowToRun } from "../store/rows";
import { allSchedules, coverageDays, editMonitorState, getMonitorState, rowToScheduleState, scheduleForTask } from "../store/schedule-rows";
import { computeDigest, type DigestScheduler } from "../monitors/digest";
import type { ThreadChanges } from "../threads/changes";
import { listCliTokens } from "../store/cli-tokens";
import type { Authenticator } from "./auth";
import type { RemotePeer } from "./server";
import type { ShellSecrets } from "../shell-secrets";
import { RemoteError, type RemoteService } from "../remote/service";
import type { AccessRequester, CliAccess } from "./cli-access";

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
export interface Conn extends AccessRequester {
  role: CallerRole | null;
  setRole(role: CallerRole): void;
  /** The CLI token this connection said hello with, so revoking it closes the connection. */
  cliTokenId: string | null;
  /** Send a notification on this connection. */
  notify(method: string, params: unknown): void;
  subscriptions: Map<string, () => void>;
  /** The paired device behind a live session (§9.4); null on the local socket. */
  readonly remote: RemotePeer | null;
}

export interface HandlerDeps {
  ctx: RunContext;
  manager: RunManager;
  auth: Authenticator;
  digest: DigestScheduler;
  /** The daily digest's settings changed: re-arm the timers. */
  settingsChanged?: () => void;
  /** `threads.changed` for changes that write no thread event (§9.8). */
  changes?: ThreadChanges;
  /** The shell's connection said hello: replay what it should still show (§8.2 notifications). */
  shellConnected?: (conn: Conn) => void;
  /** Command-line access requests and token revocation (§5.2). */
  cliAccess: CliAccess;
  /** Secrets the runtime wrote itself: the shell's hand-over mustn't overwrite them (§5.2). */
  shellSecrets?: ShellSecrets;
  /** Remote access: the account, the relay link and paired devices (§9, §10). */
  remote?: RemoteService;
  /** secrets.verify (§7.2): ask the provider about a candidate key. */
  verifyKey: (key: string) => Promise<{ outcome: "valid" | "invalid" | "unreachable"; detail?: string }>;
}

/** A result, plus an optional step to run after the reply is written (subscription backlog). */
type ResultIn<M extends MethodName> = z.input<(typeof METHODS)[M]["result"]>;
export type Reply<M extends MethodName> = ResultIn<M> | { result: ResultIn<M>; after: () => void };

type Params<M extends MethodName> = z.output<(typeof METHODS)[M]["params"]>;
type Handler<M extends MethodName> = (conn: Conn, p: Params<M>) => Reply<M> | Promise<Reply<M>>;
export type Handlers = { [M in MethodName]?: Handler<M> };

/**
 * The release CLI may edit tasks but never pre-approve calls (§5.2): anything running as the user
 * can invoke it. Nor may a paired phone or browser (§13): a stolen, unlocked phone must not be able
 * to widen what a task may do unattended. `policyNeedsFullApp` says what only the app may add.
 */
const CANNOT_WIDEN: ReadonlySet<CallerRole> = new Set(["cli", "ios", "web"]);

function refuseWidening(reasons: string[]): void {
  if (reasons.length) throw new RpcFail(RPC_ERROR.AUTHORITY_INSUFFICIENT, `Change this in the Homerun app: ${reasons.join("; ")}.`);
}

const BACKLOG_PAGE = 1000;
const HISTORY_DEFAULT = 100;
const THREADS_DEFAULT = 50;

export function makeHandlers(d: HandlerDeps): Handlers {
  const { ctx, manager } = d;
  const store = ctx.store;
  const originOf = (c: Conn): Origin => ({
    device_id: c.remote ? (c.remote.deviceId as Origin["device_id"]) : ctx.device.device_id,
    surface: SURFACE_OF_ROLE[c.role!],
  });
  const notFound = (what: string) => new RpcFail(RPC_ERROR.NOT_FOUND, `${what} not found`);
  const remoteOf = (): RemoteService => {
    if (!d.remote) throw new RpcFail(RPC_ERROR.UNAVAILABLE, "Remote access isn't running.");
    return d.remote;
  };
  /** Runs a remote-access call, turning what it refuses into the matching RPC error. */
  const remote = async <T>(fn: (r: RemoteService) => T | Promise<T>): Promise<T> => {
    try {
      return await fn(remoteOf());
    } catch (e) {
      if (e instanceof RemoteError) throw new RpcFail(e.kind === "not_found" ? RPC_ERROR.NOT_FOUND : RPC_ERROR.UNAVAILABLE, e.message);
      throw e;
    }
  };

  return {
    hello: (conn, p) => {
      const protocol = negotiateProtocol(SUPPORTED_PROTOCOL, p.protocol);
      if (protocol === null) {
        throw new RpcFail(RPC_ERROR.INCOMPATIBLE_PROTOCOL, "No protocol version in common.", { supported: { ...SUPPORTED_PROTOCOL } }, true);
      }
      // A connection that says hello while its access request waits no longer wants the answer.
      d.cliAccess.cancel(conn);
      const ok = d.auth.check(p, conn.remote);
      if (!ok.ok) throw new RpcFail(RPC_ERROR.UNAUTHENTICATED, ok.message, ok.data, true);
      conn.setRole(p.role);
      if (ok.cliTokenId) conn.cliTokenId = ok.cliTokenId;
      const result = {
        protocol,
        runtime_version: RUNTIME_VERSION,
        device_id: ctx.device.device_id,
        role: p.role,
        capabilities: negotiateCapabilities(CAPABILITIES, p.capabilities),
      };
      return p.role === "shell" && d.shellConnected ? { result, after: () => d.shellConnected!(conn) } : result;
    },

    ping: () => ({ pong: true as const, runtime_version: RUNTIME_VERSION, protocol: PROTOCOL_VERSION }),

    // ---- command-line access (§5.2)
    "cli.request_access": (conn, p) => d.cliAccess.request(conn, p.client, p.hostname),
    "cli.approve": (_c, p) => d.cliAccess.approve(p.request_id),
    "cli.deny": (_c, p) => {
      d.cliAccess.deny(p.request_id);
      return { ok: true as const };
    },
    "cli.tokens.list": () => ({ tokens: listCliTokens(store) }),

    // ---- account and devices (§9.6, §10)
    "account.status": () => ({ status: remoteOf().status() }),
    "account.sign_in": () => {
      const r = remoteOf();
      if (!r.account.configured) throw new RpcFail(RPC_ERROR.UNAVAILABLE, "This build of Homerun has no account service.");
      return { status: r.signIn() };
    },
    "account.cancel_sign_in": () => ({ status: remoteOf().cancelSignIn() }),
    "account.sign_out": async () => ({ status: await remoteOf().signOut() }),
    "account.delete": () => remote((r) => r.deleteAccount()),
    "devices.list": () => ({ devices: remoteOf().list() }),
    "devices.unpair": (_c, p) => remote((r) => (r.unpair(p.device_id), { ok: true as const })),
    "devices.pairing.start": () => remote((r) => r.startPairing()),
    "devices.pairing.cancel": (_c, p) => remote((r) => (r.cancelPairing(p.offer_id), { ok: true as const })),
    "devices.link.decide": (_c, p) => remote(async (r) => (await r.decideLink(p.request_id, p.approve), { ok: true as const })),
    "cli.tokens.revoke": (_c, p) => {
      if (!d.cliAccess.revoke(p.token_id)) throw notFound("CLI token");
      return { ok: true as const };
    },
    "cli.sign_out": (conn) => {
      const tokenId = conn.cliTokenId;
      if (!tokenId) throw new RpcFail(RPC_ERROR.VALIDATION_FAILED, "This connection did not sign in with a CLI token.");
      // Revoke now; close this and the token's other connections once the reply is written.
      return { result: { ok: true as const }, after: () => d.cliAccess.revoke(tokenId) };
    },

    "secrets.set": (_c, p) => {
      if (d.shellSecrets && !d.shellSecrets.accepts(p.name)) return { ok: true as const };
      ctx.secrets.set(p.name, p.value);
      return { ok: true as const };
    },
    "secrets.clear": (_c, p) => {
      if (d.shellSecrets && !d.shellSecrets.accepts(p.name)) return { ok: true as const };
      ctx.secrets.clear(p.name);
      return { ok: true as const };
    },
    "secrets.verify": (_c, p) => d.verifyKey(p.value),

    "threads.list": (conn, p) =>
      listThreadSummaries(store, {
        deviceId: originOf(conn).device_id,
        limit: p.limit ?? THREADS_DEFAULT,
        ...(p.updated_before !== undefined ? { updatedBefore: p.updated_before } : {}),
        ...(p.task_id ? { taskId: p.task_id } : {}),
      }),

    "threads.create": (_c, p) => {
      const thread = manager.createThread(p.title, p.task_id);
      d.changes?.touch(thread.thread_id);
      return { thread };
    },

    "threads.mark_read": (conn, p) => {
      if (!getThread(store, p.thread_id)) throw notFound("thread");
      if (markRead(store, p.thread_id, originOf(conn).device_id, p.seq, now(ctx))) d.changes?.touch(p.thread_id);
      return { ok: true as const };
    },

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

    "tasks.create": (conn, p) => {
      if (CANNOT_WIDEN.has(conn.role!)) refuseWidening(policyNeedsFullApp(p.spec));
      const { task, thread } = manager.createTask(p.spec, p.from_thread_id);
      d.changes?.touch(thread.thread_id);
      return { task, thread_id: thread.thread_id };
    },
    "tasks.get": (_c, p) => {
      const t = getTask(store, p.task_id);
      if (!t) throw notFound("task");
      return { task: t };
    },
    "tasks.list": (_c, p) => ({ tasks: listTasks(store, p.kind, p.include_archived ?? false) }),
    "tasks.update": (conn, p) => {
      if (CANNOT_WIDEN.has(conn.role!)) {
        const current = getTask(store, p.task_id);
        if (!current) throw notFound("task");
        refuseWidening(policyNeedsFullApp(p.spec, current.spec));
      }
      return { task: manager.updateTask(p.task_id, p.spec, p.expected_version) };
    },
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
      const a = { response: p.response, role: conn.role!, via: p.via, origin: originOf(conn) };
      try {
        if (r.prompt.type === "ambiguous_tool_call") return manager.answerAmbiguous(p.request_id, a);
        const out = manager.answerInput(p.request_id, a);
        return out.status === "applied" ? { status: "applied" as const } : out;
      } catch (e) {
        if (e instanceof AnswerRejected) throw new RpcFail(e.reason === "authority" ? RPC_ERROR.AUTHORITY_INSUFFICIENT : RPC_ERROR.VALIDATION_FAILED, e.message);
        throw e;
      }
    },

    // Grants belong to a task (§5.6). Chat runs never use them.
    "grants.list": (_c, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      return { grants: listGrants(store, p.task_id, p.include_revoked ?? false) };
    },
    "grants.create": (conn, p) => {
      if (!getTask(store, p.task_id)) throw notFound("task");
      return { grant: insertGrant(store, p.task_id, p.grant, originOf(conn).device_id, now(ctx)) };
    },
    "grants.revoke": (_c, p) => {
      const g = getGrant(store, p.grant_id);
      if (!g) throw notFound("grant");
      return { revoked_at: revokeGrant(store, p.grant_id, now(ctx))! };
    },
  };
}
