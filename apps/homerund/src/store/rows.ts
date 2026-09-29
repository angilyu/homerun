import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  Device,
  InputRequest,
  Run,
  Task,
  TaskSpec,
  Thread,
  ThreadSummary,
  canTransition,
  type Authority,
  type InputResponse,
  type RunError,
  type RunState,
  type RunTrigger,
  type TaskKind,
} from "@homerun/core";
import { preview } from "./content";
import type { Store } from "./store";

// ---------------------------------------------------------------- device (§12)

export function ensureDevice(store: Store, now = Date.now()): Device {
  const row = store.db.query<DeviceRow, []>("SELECT * FROM device LIMIT 1").get();
  if (row) return Device.parse(row);
  const d = Device.parse({
    device_id: randomUUID(),
    platform: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    hostname: hostname() || "localhost",
    account_id: null,
    created_at: now,
  });
  store.tx(() =>
    store.db
      .query("INSERT INTO device (device_id, platform, hostname, account_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(d.device_id, d.platform, d.hostname, d.account_id, d.created_at),
  );
  return d;
}

interface DeviceRow {
  device_id: string;
  platform: string;
  hostname: string;
  account_id: string | null;
  created_at: number;
}

// ---------------------------------------------------------------- threads

interface ThreadRow {
  thread_id: string;
  task_id: string | null;
  title: string | null;
  last_seq: number;
  updated_at: number;
}

export function createThread(store: Store, opts: { taskId?: string | null; title?: string | null; now?: number } = {}): Thread {
  const t = Thread.parse({
    thread_id: randomUUID(),
    task_id: opts.taskId ?? null,
    title: opts.title ?? null,
    last_seq: 0,
    updated_at: opts.now ?? Date.now(),
  });
  store.tx(() =>
    store.db.query("INSERT INTO threads (thread_id, task_id, title, last_seq, updated_at) VALUES (?, ?, ?, 0, ?)").run(t.thread_id, t.task_id, t.title, t.updated_at),
  );
  return t;
}

export function getThread(store: Store, threadId: string): Thread | null {
  const r = store.db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE thread_id = ?").get(threadId);
  return r ? Thread.parse(r) : null;
}

type SummaryRow = ThreadRow & {
  msg_seq: number | null;
  msg_type: string | null;
  msg_payload: string | null;
  msg_ts: number | null;
  input_pending: number;
  unread: number;
  run_id: string | null;
  run_state: string | null;
};

/** Events that count as unread for a device: what the agent said or asked (§9.8). */
const UNREAD_TYPES = "('message.final', 'input.requested', 'schedule.paused')";

function summaryQuery(where: string[], limited: boolean): string {
  return `SELECT t.*,
       m.seq AS msg_seq, m.type AS msg_type, m.payload AS msg_payload, m.ts AS msg_ts,
       EXISTS (SELECT 1 FROM input_requests i JOIN runs ir ON ir.run_id = i.run_id WHERE ir.thread_id = t.thread_id AND i.state = 'pending') AS input_pending,
       (SELECT COUNT(*) FROM thread_events u WHERE u.thread_id = t.thread_id AND u.type IN ${UNREAD_TYPES}
          AND u.seq > COALESCE((SELECT rm.seq FROM read_markers rm WHERE rm.thread_id = t.thread_id AND rm.device_id = ?), 0)) AS unread,
       r.run_id AS run_id, r.state AS run_state
     FROM threads t
     LEFT JOIN thread_events m ON m.thread_id = t.thread_id AND m.seq = (
       SELECT MAX(seq) FROM thread_events WHERE thread_id = t.thread_id AND type IN ('user.message', 'message.final'))
     LEFT JOIN runs r ON r.thread_id = t.thread_id AND r.state IN ('pending', 'running', 'waiting_input')
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY t.updated_at DESC, t.thread_id DESC
     ${limited ? "LIMIT ?" : ""}`;
}

function rowToSummary(r: SummaryRow): ThreadSummary {
  return ThreadSummary.parse({
    thread_id: r.thread_id,
    task_id: r.task_id,
    title: r.title,
    last_seq: r.last_seq,
    updated_at: r.updated_at,
    last_message:
      r.msg_seq !== null
        ? {
            seq: r.msg_seq,
            role: r.msg_type === "user.message" ? "user" : "assistant",
            preview: preview((JSON.parse(r.msg_payload!) as { text: string }).text),
            ts: r.msg_ts!,
          }
        : null,
    unread_count: r.unread,
    input_pending: r.input_pending === 1,
    active_run: r.run_id ? { run_id: r.run_id, state: r.run_state } : null,
  });
}

/**
 * threads.list (§5.7): summaries, most recently updated first. `unread_count` is for `deviceId`,
 * from its read marker (`threads.mark_read`).
 *
 * The cursor is `updated_before` alone, so a page never ends inside a group of threads with the
 * same `updated_at`: the group moves to the next page, or, if it would fill a page by itself,
 * this page holds the whole group (more than `limit`). Otherwise the next page's
 * `updated_before` would skip the rest of the group.
 */
export function listThreadSummaries(
  store: Store,
  o: { limit: number; updatedBefore?: number; taskId?: string; deviceId: string },
): { threads: ThreadSummary[]; has_more: boolean } {
  const query = (cond: { before?: number; at?: number }, limit: number | null): SummaryRow[] => {
    const where: string[] = [];
    const args: Array<string | number> = [o.deviceId];
    if (cond.before !== undefined) {
      where.push("t.updated_at < ?");
      args.push(cond.before);
    }
    if (cond.at !== undefined) {
      where.push("t.updated_at = ?");
      args.push(cond.at);
    }
    if (o.taskId !== undefined) {
      where.push("t.task_id = ?");
      args.push(o.taskId);
    }
    if (limit !== null) args.push(limit);
    return store.db.query<SummaryRow, Array<string | number>>(summaryQuery(where, limit !== null)).all(...args);
  };

  const rows = query({ before: o.updatedBefore }, o.limit + 1);
  let page = rows.slice(0, o.limit);
  let hasMore = rows.length > o.limit;
  if (hasMore) {
    const next = rows[o.limit]!.updated_at;
    page = page.filter((r) => r.updated_at > next);
    if (!page.length) {
      page = query({ at: next }, null);
      hasMore = query({ before: next }, 1).length > 0;
    }
  }
  return { threads: page.map(rowToSummary), has_more: hasMore };
}

/** One thread's summary for `deviceId` (`threads.changed`), or null if it does not exist. */
export function threadSummary(store: Store, threadId: string, deviceId: string): ThreadSummary | null {
  const r = store.db.query<SummaryRow, [string, string]>(summaryQuery(["t.thread_id = ?"], false)).get(deviceId, threadId);
  return r ? rowToSummary(r) : null;
}

/**
 * threads.mark_read: move `deviceId`'s marker to `seq`, clamped to the thread's last event. It
 * only moves forward, so a late call from a stale view cannot mark read messages unread.
 * Returns whether it moved.
 */
export function markRead(store: Store, threadId: string, deviceId: string, seq: number, now: number): boolean {
  return store.tx(() => {
    const t = store.db.query<{ last_seq: number }, [string]>("SELECT last_seq FROM threads WHERE thread_id = ?").get(threadId);
    if (!t) return false;
    const to = Math.min(seq, t.last_seq);
    const r = store.db
      .query(
        `INSERT INTO read_markers (thread_id, device_id, seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (thread_id, device_id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
         WHERE excluded.seq > read_markers.seq`,
      )
      .run(threadId, deviceId, to, now);
    return r.changes > 0;
  });
}

// ---------------------------------------------------------------- tasks (§6)

interface TaskRow {
  task_id: string;
  device_id: string;
  kind: string;
  name: string;
  version: number;
  spec: string;
  archived_at: number | null;
}

function rowToTask(r: TaskRow): Task {
  return Task.parse({ ...r, spec: JSON.parse(r.spec) });
}

export function createTask(store: Store, deviceId: string, spec: TaskSpec, now = Date.now()): { task: Task; thread: Thread } {
  return store.tx(() => {
    const taskId = randomUUID();
    const task = Task.parse({ task_id: taskId, device_id: deviceId, kind: spec.kind, name: spec.name, version: 1, spec, archived_at: null });
    const json = JSON.stringify(task.spec);
    store.db
      .query("INSERT INTO tasks (task_id, device_id, kind, name, version, spec, archived_at, created_at) VALUES (?, ?, ?, ?, 1, ?, NULL, ?)")
      .run(taskId, deviceId, task.kind, task.name, json, now);
    store.db.query("INSERT INTO task_versions (task_id, version, spec, created_at) VALUES (?, 1, ?, ?)").run(taskId, json, now);
    const thread = createThread(store, { taskId, title: task.name, now });
    return { task, thread };
  });
}

/** A new version of a task's spec (§6 `task_versions`). The caller checked `expected_version`. */
export function updateTaskSpec(store: Store, taskId: string, spec: TaskSpec, now: number): Task {
  return store.tx(() => {
    const cur = getTask(store, taskId);
    if (!cur) throw new Error(`no task ${taskId}`);
    const version = cur.version + 1;
    const task = Task.parse({ ...cur, name: spec.name, version, spec });
    const json = JSON.stringify(task.spec);
    store.db.query("UPDATE tasks SET name = ?, version = ?, spec = ? WHERE task_id = ?").run(task.name, version, json, taskId);
    store.db.query("INSERT INTO task_versions (task_id, version, spec, created_at) VALUES (?, ?, ?, ?)").run(taskId, version, json, now);
    return task;
  });
}

export function archiveTaskRow(store: Store, taskId: string, now: number): number {
  return store.tx(() => {
    store.db.query("UPDATE tasks SET archived_at = ? WHERE task_id = ? AND archived_at IS NULL").run(now, taskId);
    return getTask(store, taskId)!.archived_at!;
  });
}

export function getTask(store: Store, taskId: string): Task | null {
  const r = store.db.query<TaskRow, [string]>("SELECT task_id, device_id, kind, name, version, spec, archived_at FROM tasks WHERE task_id = ?").get(taskId);
  return r ? rowToTask(r) : null;
}

export function listTasks(store: Store, kind?: TaskKind, includeArchived = false): Task[] {
  return store.db
    .query<TaskRow, []>("SELECT task_id, device_id, kind, name, version, spec, archived_at FROM tasks ORDER BY created_at")
    .all()
    .filter((r) => (kind === undefined || r.kind === kind) && (includeArchived || r.archived_at === null))
    .map(rowToTask);
}

export function getTaskVersionSpec(store: Store, taskId: string, version: number): TaskSpec | null {
  const r = store.db.query<{ spec: string }, [string, number]>("SELECT spec FROM task_versions WHERE task_id = ? AND version = ?").get(taskId, version);
  return r ? TaskSpec.parse(JSON.parse(r.spec)) : null;
}

// ---------------------------------------------------------------- runs (§6)

export type Pool = "session" | "monitor";

export interface RunRow {
  run_id: string;
  thread_id: string;
  task_id: string | null;
  task_version: number | null;
  sdk_session_id: string | null;
  device_id: string;
  trigger: string;
  origin_device: string | null;
  authority: string;
  scheduled_for: number | null;
  dedupe_key: string;
  attempt: number;
  state: string;
  started_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  error: string | null;
  check_result: string | null;
  cost_usd: number | null;
  claude_pid: number | null;
  created_at: number;
  pool: Pool;
  origin_surface: string | null;
  claude_boot: number | null;
  claude_started_at: number | null;
  reap_pgid: number | null;
  resume_count: number;
  resume_reason: string | null;
  resume_note: string | null;
  resume_at: string | null;
  stop_requested_at: number | null;
  stop_by: string | null;
  sdk_cost_baseline: number | null;
  sdk_cost_total: number | null;
  monitor_phase: MonitorPhase | null;
  check_session_id: string | null;
  state_version: number | null;
  tainted_at: number | null;
}

/** Which step of the monitor pipeline a monitor run is in (§8.3); null for other runs. */
export type MonitorPhase = "rule_check" | "model_check" | "act";

export function rowToRun(r: RunRow): Run {
  return Run.parse({
    run_id: r.run_id,
    thread_id: r.thread_id,
    task_id: r.task_id,
    task_version: r.task_version,
    sdk_session_id: r.sdk_session_id,
    device_id: r.device_id,
    trigger: r.trigger,
    origin_device: r.origin_device,
    authority: r.authority,
    scheduled_for: r.scheduled_for,
    dedupe_key: r.dedupe_key,
    attempt: r.attempt,
    state: r.state,
    started_at: r.started_at,
    ended_at: r.ended_at,
    outcome: r.outcome,
    error: r.error ? JSON.parse(r.error) : null,
    check_result: r.check_result ? JSON.parse(r.check_result) : null,
    cost_usd: r.cost_usd,
    claude_pid: r.claude_pid,
  });
}

export function getRunRow(store: Store, runId: string): RunRow | null {
  return store.db.query<RunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId) ?? null;
}

export function activeRunRow(store: Store, threadId: string): RunRow | null {
  return (
    store.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? AND state IN ('pending','running','waiting_input')").get(threadId) ?? null
  );
}

/** The thread's most recent run that reached the agent with a session `usable` accepts, for a follow-up's `resume`. */
export function lastSessionRun(store: Store, threadId: string, usable: (sessionId: string) => boolean = () => true): RunRow | null {
  const q = store.db.query<RunRow, [string]>("SELECT * FROM runs WHERE thread_id = ? AND sdk_session_id IS NOT NULL ORDER BY created_at DESC, rowid DESC");
  for (const r of q.iterate(threadId)) if (usable(r.sdk_session_id!)) return r;
  return null;
}

/** When the run last asked for input (it parked then), or null if it never did. */
export function lastInputRequestAt(store: Store, runId: string): number | null {
  return store.db.query<{ at: number | null }, [string]>("SELECT MAX(requested_at) AS at FROM input_requests WHERE run_id = ?").get(runId)?.at ?? null;
}

export interface NewRun {
  threadId: string;
  taskId: string | null;
  taskVersion: number | null;
  deviceId: string;
  trigger: RunTrigger;
  originDevice: string | null;
  originSurface: string | null;
  authority: Authority;
  pool: Pool;
  now: number;
  /** Scheduled fires (§8): the slot, its dedupe key and retry attempt. */
  scheduledFor?: number | null;
  dedupeKey?: string;
  attempt?: number;
  monitorPhase?: MonitorPhase | null;
}

/**
 * Insert a pending run. Returns null when the thread already has an active run: the partial
 * unique index `one_active_run_per_thread` decides (§5.7), not a read-then-write.
 */
export function tryInsertRun(store: Store, n: NewRun): RunRow | null {
  const runId = randomUUID();
  try {
    store.tx(() =>
      store.db
        .query(
          `INSERT INTO runs (run_id, thread_id, task_id, task_version, sdk_session_id, device_id, trigger, origin_device, authority,
           scheduled_for, dedupe_key, attempt, state, created_at, pool, origin_surface, monitor_phase)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
        .run(
          runId,
          n.threadId,
          n.taskId,
          n.taskVersion,
          n.deviceId,
          n.trigger,
          n.originDevice,
          n.authority,
          n.scheduledFor ?? null,
          n.dedupeKey ?? runId,
          n.attempt ?? 0,
          n.now,
          n.pool,
          n.originSurface,
          n.monitorPhase ?? null,
        ),
    );
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: runs\.thread_id/.test(e.message)) return null;
    throw e;
  }
  return getRunRow(store, runId);
}

/** Change a run's state, enforcing core's transition table. */
export function setRunState(store: Store, runId: string, to: RunState, extra: Partial<Pick<RunRow, UpdatableRunField>> = {}): RunRow {
  return store.tx(() => {
    const cur = getRunRow(store, runId);
    if (!cur) throw new Error(`no run ${runId}`);
    if (cur.state !== to) {
      if (!canTransition(cur.state as RunState, to)) throw new Error(`run ${runId}: illegal transition ${cur.state} → ${to}`);
    }
    updateRun(store, runId, { ...extra, state: to });
    return getRunRow(store, runId)!;
  });
}

type UpdatableRunField = Exclude<keyof RunRow, "run_id" | "thread_id" | "created_at" | "dedupe_key">;

export function updateRun(store: Store, runId: string, fields: Partial<Pick<RunRow, UpdatableRunField>>): void {
  const keys = Object.keys(fields) as UpdatableRunField[];
  if (!keys.length) return;
  const sql = `UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE run_id = ?`;
  store.tx(() => store.db.query(sql).run(...keys.map((k) => fields[k] as string | number | null), runId));
}

export function runErrorJson(e: RunError | null): string | null {
  return e ? JSON.stringify(e) : null;
}

export function listRuns(
  store: Store,
  f: { threadId?: string; taskId?: string; states?: RunState[]; limit?: number } = {},
): Run[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.threadId) (where.push("thread_id = ?"), args.push(f.threadId));
  if (f.taskId) (where.push("task_id = ?"), args.push(f.taskId));
  if (f.states?.length) (where.push(`state IN (${f.states.map(() => "?").join(",")})`), args.push(...f.states));
  const sql = `SELECT * FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  return store.db
    .query<RunRow, (string | number)[]>(sql)
    .all(...args, f.limit ?? 100)
    .map(rowToRun);
}

export function runsInState(store: Store, states: readonly RunState[]): RunRow[] {
  return store.db
    .query<RunRow, string[]>(`SELECT * FROM runs WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at, rowid`)
    .all(...states);
}

// ---------------------------------------------------------------- run inputs (internal)

export interface RunInputRow {
  uuid: string;
  run_id: string;
  held: number;
  text: string;
  created_at: number;
  consumed_at: number | null;
}

export function addRunInput(store: Store, runId: string, uuid: string, text: string, held: boolean, now = Date.now()): void {
  store.tx(() => store.db.query("INSERT OR IGNORE INTO run_inputs (uuid, run_id, held, text, created_at) VALUES (?, ?, ?, ?, ?)").run(uuid, runId, held ? 1 : 0, text, now));
}

export function pendingInputs(store: Store, runId: string): RunInputRow[] {
  return store.db
    .query<RunInputRow, [string]>("SELECT * FROM run_inputs WHERE run_id = ? AND held = 0 AND consumed_at IS NULL ORDER BY created_at, rowid")
    .all(runId);
}

/** Messages held while the run waited for input join the next turn (§5.7). */
export function releaseHeldInputs(store: Store, runId: string): void {
  store.tx(() => store.db.query("UPDATE run_inputs SET held = 0 WHERE run_id = ? AND held = 1 AND consumed_at IS NULL").run(runId));
}

export function markInputsConsumed(store: Store, uuids: readonly string[], now = Date.now()): void {
  if (!uuids.length) return;
  const q = store.db.query("UPDATE run_inputs SET consumed_at = ? WHERE uuid = ? AND consumed_at IS NULL");
  store.tx(() => {
    for (const u of uuids) q.run(now, u);
  });
}

// ---------------------------------------------------------------- input requests (§6)

interface InputRequestRow {
  request_id: string;
  applied_at?: number | null;
  deferred_at?: number | null;
  run_id: string;
  kind: string;
  tool_call_id: string | null;
  prompt: string;
  state: string;
  requested_at: number;
  expires_at: number | null;
  answered_at: number | null;
  response: string | null;
  answered_by: string | null;
}

export function rowToInputRequest(r: InputRequestRow): InputRequest {
  return InputRequest.parse({ ...r, prompt: JSON.parse(r.prompt), response: r.response ? JSON.parse(r.response) : null });
}

export function insertInputRequest(store: Store, req: InputRequest): void {
  store.tx(() => store.db
    .query(
      `INSERT INTO input_requests (request_id, run_id, kind, tool_call_id, prompt, state, requested_at, expires_at, answered_at, response, answered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.request_id,
      req.run_id,
      req.kind,
      req.tool_call_id,
      JSON.stringify(req.prompt),
      req.state,
      req.requested_at,
      req.expires_at,
      req.answered_at,
      req.response ? JSON.stringify(req.response) : null,
      req.answered_by,
    ));
}

export function pendingInputRequests(store: Store, f: { threadId?: string; runId?: string } = {}): InputRequest[] {
  const rows = store.db
    .query<InputRequestRow & { thread_id: string }, []>(
      "SELECT i.*, r.thread_id FROM input_requests i JOIN runs r ON r.run_id = i.run_id WHERE i.state = 'pending' ORDER BY i.requested_at, i.rowid",
    )
    .all();
  return rows
    .filter((r) => (!f.threadId || r.thread_id === f.threadId) && (!f.runId || r.run_id === f.runId))
    .map(({ thread_id: _t, ...r }) => rowToInputRequest(r));
}

export function getInputRequest(store: Store, requestId: string): InputRequest | null {
  const r = store.db.query<InputRequestRow, [string]>("SELECT * FROM input_requests WHERE request_id = ?").get(requestId);
  return r ? rowToInputRequest(r) : null;
}

/** First answer wins: false if the request was no longer pending. */
export function answerInputRequest(store: Store, requestId: string, response: InputResponse, answeredBy: string, now: number): boolean {
  return store.tx(
    () =>
      store.db
        .query("UPDATE input_requests SET state = 'answered', response = ?, answered_by = ?, answered_at = ? WHERE request_id = ? AND state = 'pending'")
        .run(JSON.stringify(response), answeredBy, now, requestId).changes === 1,
  );
}

export function setInputRequestState(store: Store, requestId: string, state: "cancelled" | "expired"): void {
  store.tx(() => store.db.query("UPDATE input_requests SET state = ? WHERE request_id = ? AND state = 'pending'").run(state, requestId));
}

/** A request as stored, with the columns internal to the runtime (§5.6 gating). */
export interface GateRequest {
  req: InputRequest;
  applied_at: number | null;
  deferred_at: number | null;
}

function toGate(r: InputRequestRow): GateRequest {
  const { applied_at, deferred_at, ...rest } = r;
  return { req: rowToInputRequest(rest), applied_at: applied_at ?? null, deferred_at: deferred_at ?? null };
}

/** The approval or question gating a tool call (not "Did this happen?"), newest first. */
export function gateRequestForCall(store: Store, toolCallId: string): GateRequest | null {
  const r = store.db
    .query<InputRequestRow, [string]>(
      "SELECT * FROM input_requests WHERE tool_call_id = ? AND json_extract(prompt, '$.type') IN ('approval', 'question') ORDER BY requested_at DESC, rowid DESC LIMIT 1",
    )
    .get(toolCallId);
  return r ? toGate(r) : null;
}

export function getGateRequest(store: Store, requestId: string): GateRequest | null {
  const r = store.db.query<InputRequestRow, [string]>("SELECT * FROM input_requests WHERE request_id = ?").get(requestId);
  return r ? toGate(r) : null;
}

/** Approvals and questions of a run that were answered but never handed to the agent. */
export function unappliedGateRequests(store: Store, runId: string): GateRequest[] {
  return store.db
    .query<InputRequestRow, [string]>(
      "SELECT * FROM input_requests WHERE run_id = ? AND state = 'answered' AND applied_at IS NULL AND json_extract(prompt, '$.type') IN ('approval', 'question') ORDER BY requested_at, rowid",
    )
    .all(runId)
    .map(toGate);
}

export function markRequestApplied(store: Store, requestId: string, now: number): void {
  store.tx(() => store.db.query("UPDATE input_requests SET applied_at = ? WHERE request_id = ? AND applied_at IS NULL").run(now, requestId));
}

export function markRequestDeferred(store: Store, requestId: string, now: number): void {
  store.tx(() => store.db.query("UPDATE input_requests SET deferred_at = ? WHERE request_id = ? AND deferred_at IS NULL").run(now, requestId));
}

/** Pending requests past their `expires_at` (§5.6 `input_timeout`). */
export function expiredInputRequests(store: Store, now: number): InputRequest[] {
  return store.db
    .query<InputRequestRow, [number]>("SELECT * FROM input_requests WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at, rowid")
    .all(now)
    .map((r) => toGate(r).req);
}

/** The earliest pending `expires_at`, for the expiry timer. */
export function nextInputExpiry(store: Store): number | null {
  return store.db.query<{ t: number | null }, []>("SELECT MIN(expires_at) AS t FROM input_requests WHERE state = 'pending' AND expires_at IS NOT NULL").get()?.t ?? null;
}
