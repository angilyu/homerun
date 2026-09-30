import { z } from "zod";
import { named } from "../registry";
import {
  ClientMsgId,
  DeviceId,
  GrantId,
  JsonValue,
  MONITOR_STATE_MAX_BYTES,
  RequestId,
  RunId,
  ScheduleId,
  Seq,
  Sha256Hex,
  TaskId,
  ThreadId,
  TimestampMs,
  UUID_PATTERN,
  jsonByteLength,
} from "../common";
import { MonitorState, Run, RunState, Task, TaskKind, TaskVersion, Thread, ThreadSummary } from "../domain";
import { GrantProposal, ToolGrant } from "../grants";
import { AnswerVia, InputRequest, InputRequestState, InputResponse } from "../input";
import { ScheduleCoverage, ScheduleState } from "../schedule";
import { HEALTH_DIGEST_MAX_MS, HealthDigest, HealthSettings } from "../health";
import { TaskSpec } from "../task-spec";
import { PersistedThreadEvent, ThreadEvent } from "../events";
import { CallerRole, ClientInfo, CliToken, HelloParams, HelloResult } from "./handshake";

/**
 * The method table. Each entry names its direction, its param and result schemas, and the
 * caller roles allowed to call it: the allowlists are this data (see `callers.ts`), exported to
 * `schema/callers.json` for the Rust shell and remote clients.
 *
 * The runtime identifies the caller from the connection, never from params: a run's
 * `origin_device` and `authority` (§9.9) come from the authenticated role and device.
 */

export type Direction = "to_runtime" | "to_shell";

export interface MethodDef<P extends z.ZodType = z.ZodType, R extends z.ZodType = z.ZodType> {
  readonly direction: Direction;
  readonly params: P;
  readonly result: R;
  /** Roles allowed to call a `to_runtime` method. Empty for `to_shell` (only the runtime calls those). */
  readonly callers: readonly CallerRole[];
  /** Callable before `hello` succeeds. */
  readonly preauth: boolean;
  readonly description: string;
}

const pascal = (m: string) =>
  m
    .split(/[._]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");

const PARAM_IDS = new Map<string, string>();
const RESULT_IDS = new Map<string, string>();

function def<P extends z.ZodType, R extends z.ZodType>(
  name: string,
  d: Omit<MethodDef<P, R>, "preauth" | "direction"> & { preauth?: boolean; direction?: Direction },
): MethodDef<P, R> {
  const pid = `${pascal(name)}Params`;
  const rid = `${pascal(name)}Result`;
  // hello's schemas are already named in handshake.ts.
  const params = d.params.meta()?.id ? d.params : named(pid, d.params);
  const result = d.result.meta()?.id ? d.result : named(rid, d.result);
  PARAM_IDS.set(name, params.meta()!.id as string);
  RESULT_IDS.set(name, result.meta()!.id as string);
  return { direction: "to_runtime", preauth: false, ...d, params, result };
}

// ---------------------------------------------------------------- caller groups

const EVERYONE = ["shell", "webview", "cli", "cli_dev", "ios", "web"] as const satisfies readonly CallerRole[];
/**
 * Everyone except the web client. The web bundle is served by a third party and can be swapped
 * (§9.9), so it gets no method that raises the agent's reach: creating or editing tasks,
 * enabling schedules, adding grants, or writing monitor state.
 */
const NOT_WEB = ["shell", "webview", "cli", "cli_dev", "ios"] as const satisfies readonly CallerRole[];
/**
 * The full app, where the user can see and edit a grant's exact pattern first (§5.6), plus the
 * development CLI. Not the release CLI: anything running as the user can invoke it, and it
 * answers questions only (§5.2). Not the web client (§9.9).
 */
const FULL_APP = ["shell", "webview", "cli_dev", "ios"] as const satisfies readonly CallerRole[];
/** Local app UI only: settings screens that manage local credentials. */
const LOCAL_UI = ["shell", "webview"] as const satisfies readonly CallerRole[];
/** The shell's own launch-token connection, never forwarded webview calls (§5.2). */
const SHELL = ["shell"] as const satisfies readonly CallerRole[];

// ---------------------------------------------------------------- shared shapes

const Empty = z.object({});
const Limit = z.int().min(1).max(500);
const Ok = z.object({ ok: z.literal(true) });
const Uuid = z.string().regex(UUID_PATTERN);

export const SecretName = named(
  "SecretName",
  z.enum(["anthropic_api_key", "device_static_key", "refresh_token"]),
  "Keychain items the shell holds for the runtime (§11)",
);
export type SecretName = z.infer<typeof SecretName>;

const Hostname = z.string().min(1).max(255);

export const CliTokenInfo = named(
  "CliTokenInfo",
  z.object({ token_id: Uuid, client: ClientInfo, hostname: Hostname, created_at: TimestampMs, last_used_at: TimestampMs.nullable() }),
);

/** How long a `cli.request_access` waits for the user before it expires (§5.2). */
export const CLI_ACCESS_REQUEST_TTL_MS = 2 * 60 * 1000;
/** Pending `cli.request_access` requests across all connections; one more is UNAVAILABLE. */
export const CLI_ACCESS_MAX_PENDING = 3;

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

// ---------------------------------------------------------------- accounts and devices (§9.6, §10)

/**
 * The desktop's account and relay link (§10.4, §10.10). `not_configured`: this build has no
 * identity provider or relay. `needs_sign_in`: the refresh token stopped working, so remote access
 * is paused until the user signs in again.
 */
export const AccountState = named("AccountState", z.enum(["not_configured", "signed_out", "signing_in", "signed_in", "needs_sign_in"]));
export type AccountState = z.infer<typeof AccountState>;

export const RelayLinkState = named("RelayLinkState", z.enum(["off", "connecting", "connected", "offline"]));
export type RelayLinkState = z.infer<typeof RelayLinkState>;

export const AccountStatus = named(
  "AccountStatus",
  z.object({
    state: AccountState,
    /** The provider's email for the signed-in account, when it gave one. */
    email: z.string().max(320).nullable(),
    /** Why the last sign-in didn't finish (denied, timed out, the provider unreachable). */
    error: z.string().max(500).nullable(),
    relay: z.object({
      state: RelayLinkState,
      /** When the link entered this state. */
      since: TimestampMs.nullable(),
      /** Why the last attempt failed, in words the user can act on. */
      error: z.string().max(500).nullable(),
    }),
    /** A device asking to link, while the shell's prompt shows its code (§10.5). */
    link_request: z.object({ name: z.string().max(100), platform: z.enum(["ios", "web"]) }).nullable(),
  }),
);
export type AccountStatus = z.infer<typeof AccountStatus>;

/** A phone or browser linked to this desktop (§9.6 revocation). */
export const PairedDevice = named(
  "PairedDevice",
  z.object({
    device_id: DeviceId,
    name: z.string().min(1).max(100),
    platform: z.enum(["ios", "web"]),
    /** QR pairing (§9.6) or code linking (§10.5). */
    method: z.enum(["qr", "code"]),
    paired_at: TimestampMs,
    online: z.boolean(),
    last_seen_at: TimestampMs.nullable(),
  }),
);
export type PairedDevice = z.infer<typeof PairedDevice>;

/** How long a QR pairing offer stays open (§9.6). */
export const PAIRING_OFFER_TTL_MS = 5 * 60 * 1000;
/** How long the shell's link prompt waits for the user (§10.5). */
export const LINK_REQUEST_TTL_MS = 2 * 60 * 1000;
/** Largest `blobs.get` page, before base64. */
export const BLOB_PAGE_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- the table

export const METHODS = {
  // ---- handshake and pairing (§5.2)
  hello: def("hello", {
    params: HelloParams,
    result: HelloResult,
    callers: EVERYONE,
    preauth: true,
    description: "First request on every connection. Negotiates version and capabilities; authenticates.",
  }),
  "cli.request_access": def("cli.request_access", {
    params: z.object({ client: ClientInfo, hostname: Hostname }),
    result: z.object({ request_id: Uuid, expires_at: TimestampMs }),
    callers: ["cli"],
    preauth: true,
    description:
      "An unapproved CLI asks for a token. The app asks the user; the decision arrives as `cli.access_decision` on this connection. One per connection; UNAVAILABLE (`CliAccessUnavailableData`) while too many are pending.",
  }),
  ping: def("ping", {
    params: Empty,
    result: z.object({ pong: z.literal(true), runtime_version: z.string(), protocol: z.int().min(1) }),
    callers: EVERYONE,
    description: "Liveness check.",
  }),

  // ---- tasks (§8)
  "tasks.list": def("tasks.list", {
    params: z.object({ kind: TaskKind.optional(), include_archived: z.boolean().optional() }),
    result: z.object({ tasks: z.array(Task) }),
    callers: EVERYONE,
    description: "Tasks on this device.",
  }),
  "tasks.get": def("tasks.get", {
    params: z.object({ task_id: TaskId }),
    result: z.object({ task: Task }),
    callers: EVERYONE,
    description: "One task at its current version.",
  }),
  "tasks.get_version": def("tasks.get_version", {
    params: z.object({ task_id: TaskId, version: z.int().min(1) }),
    result: z.object({ version: TaskVersion }),
    callers: EVERYONE,
    description: "A past version, e.g. the one a run executed.",
  }),
  "tasks.create": def("tasks.create", {
    params: z.object({ spec: TaskSpec, from_thread_id: ThreadId.optional() }),
    result: z.object({ task: Task, thread_id: ThreadId }),
    callers: NOT_WEB,
    description: "Create a task, optionally promoting a chat's thread (§2.1).",
  }),
  "tasks.update": def("tasks.update", {
    params: z.object({ task_id: TaskId, spec: TaskSpec, expected_version: z.int().min(1) }),
    result: z.object({ task: Task }),
    callers: NOT_WEB,
    description: "Edit a task. Fails with CONFLICT unless `expected_version` is current. Bumps the version.",
  }),
  "tasks.archive": def("tasks.archive", {
    params: z.object({ task_id: TaskId }),
    result: z.object({ archived_at: TimestampMs }),
    callers: NOT_WEB,
    description: "Archive a task and disable its schedules.",
  }),
  "tasks.run_now": def("tasks.run_now", {
    params: z.object({ task_id: TaskId }),
    result: z.object({ run_id: RunId, thread_id: ThreadId }),
    callers: EVERYONE,
    description: "Start a manual run. A web caller's run gets `web_read_only` authority (§9.9).",
  }),

  // ---- schedules (§8.2, §8.4)
  "schedules.list": def("schedules.list", {
    params: z.object({ task_id: TaskId.optional() }),
    result: z.object({ schedules: z.array(ScheduleState) }),
    callers: EVERYONE,
    description: "Schedules and their next fire time.",
  }),
  "schedules.set_enabled": def("schedules.set_enabled", {
    params: z.object({ schedule_id: ScheduleId, enabled: z.boolean() }),
    result: z.object({ schedule: ScheduleState }),
    callers: NOT_WEB,
    description: "Pause or resume a schedule.",
  }),
  "schedules.coverage": def("schedules.coverage", {
    params: z.object({ task_id: TaskId, from_day: z.iso.date(), to_day: z.iso.date() }),
    result: z.object({ days: z.array(ScheduleCoverage) }),
    callers: EVERYONE,
    description: "Per-day ran / missed counts for the coverage display (§8.4).",
  }),

  // ---- health digest (§8.3)
  "health.digest": def("health.digest", {
    params: z
      .object({ from: TimestampMs, to: TimestampMs })
      .refine((p) => p.to > p.from, "to must be after from")
      .refine((p) => p.to - p.from <= HEALTH_DIGEST_MAX_MS, "at most 31 days"),
    result: z.object({ digest: HealthDigest }),
    callers: EVERYONE,
    description: "Summarise every monitor over a period: runs, changes, failures, misses by cause, and cost.",
  }),
  "health.settings.get": def("health.settings.get", {
    params: Empty,
    result: z.object({ settings: HealthSettings }),
    callers: EVERYONE,
    description: "When the daily digest is generated, or whether it is off.",
  }),
  "health.settings.set": def("health.settings.set", {
    params: z.object({ settings: HealthSettings }),
    result: z.object({ settings: HealthSettings }),
    callers: NOT_WEB,
    description: "Change or turn off the daily digest.",
  }),

  // ---- grants (§5.6)
  "grants.list": def("grants.list", {
    params: z.object({ task_id: TaskId, include_revoked: z.boolean().optional() }),
    result: z.object({ grants: z.array(ToolGrant) }),
    callers: EVERYONE,
    description: "A task's grants.",
  }),
  "grants.create": def("grants.create", {
    params: z.object({ task_id: TaskId, grant: GrantProposal }),
    result: z.object({ grant: ToolGrant }),
    callers: FULL_APP,
    description: "Add a grant from settings (e.g. 'Trust this tool', §5.5). 'Always allow' answers create grants via `input.answer`.",
  }),
  "grants.revoke": def("grants.revoke", {
    params: z.object({ grant_id: GrantId }),
    result: z.object({ revoked_at: TimestampMs }),
    callers: EVERYONE,
    description: "Revoke a grant. Only ever reduces what the agent may do, so the web client may call it.",
  }),

  // ---- threads (§9.8)
  "threads.list": def("threads.list", {
    params: z.object({ limit: Limit.optional(), updated_before: TimestampMs.optional(), task_id: TaskId.optional() }),
    result: z.object({ threads: z.array(ThreadSummary), has_more: z.boolean() }),
    callers: EVERYONE,
    description: "Summaries, most recently updated first.",
  }),
  "threads.create": def("threads.create", {
    params: z.object({ title: z.string().max(500).optional(), task_id: TaskId.optional() }),
    result: z.object({ thread: Thread }),
    callers: EVERYONE,
    description:
      "Start a chat thread: a one-off chat, or with `task_id` a new chat on a session task (§2.1) that runs under that task's spec and grants.",
  }),
  "threads.history": def("threads.history", {
    params: z.object({ thread_id: ThreadId, before_seq: Seq.optional(), limit: Limit.optional() }),
    result: z.object({ events: z.array(PersistedThreadEvent), has_more: z.boolean() }),
    callers: EVERYONE,
    description: "Persisted events before `before_seq` (default: the end), newest page first, ascending within the page.",
  }),
  "threads.subscribe": def("threads.subscribe", {
    params: z.object({ thread_id: ThreadId, after_seq: z.int().nonnegative() }),
    result: z.object({ subscription_id: Uuid, last_seq: z.int().nonnegative() }),
    callers: EVERYONE,
    description:
      "Stream a thread. Persisted events after `after_seq` arrive first as `thread.event`, then live events. Gap-free by seq.",
  }),
  "threads.unsubscribe": def("threads.unsubscribe", {
    params: z.object({ subscription_id: Uuid }),
    result: Ok,
    callers: EVERYONE,
    description: "Stop a subscription.",
  }),
  "threads.mark_read": def("threads.mark_read", {
    params: z.object({ thread_id: ThreadId, seq: Seq }),
    result: Ok,
    callers: EVERYONE,
    description: "Move this device's read marker.",
  }),

  // ---- messages (§5.7)
  "messages.send": def("messages.send", {
    params: z.object({
      thread_id: ThreadId,
      client_msg_id: ClientMsgId,
      text: z.string().min(1).max(100_000),
      /** When the user sent it, for instructions queued while offline (§9.4). */
      sent_at: TimestampMs.optional(),
    }),
    result: z.object({ seq: Seq, run_id: RunId, disposition: z.enum(["started_run", "steered", "held"]) }),
    callers: EVERYONE,
    description:
      "Send a message: starts a run, steers the running one, or is held while it waits for input. Idempotent on client_msg_id.",
  }),

  // ---- runs (§5.3)
  "runs.list": def("runs.list", {
    params: z.object({
      thread_id: ThreadId.optional(),
      task_id: TaskId.optional(),
      states: z.array(RunState).min(1).optional(),
      limit: Limit.optional(),
    }),
    result: z.object({ runs: z.array(Run) }),
    callers: EVERYONE,
    description: "Runs, newest first.",
  }),
  "runs.get": def("runs.get", {
    params: z.object({ run_id: RunId }),
    result: z.object({ run: Run }),
    callers: EVERYONE,
    description: "One run.",
  }),
  "runs.stop": def("runs.stop", {
    params: z.object({ run_id: RunId }),
    result: z.object({ state: RunState }),
    callers: EVERYONE,
    description: "Request a stop. `run.cancelled` then `run.end` follow.",
  }),
  "runs.retry": def("runs.retry", {
    params: z.object({ run_id: RunId }),
    result: z.object({ run_id: RunId }),
    callers: EVERYONE,
    description: "Start a new run with the same trigger inputs as a failed one.",
  }),

  // ---- input (§5.6)
  "input.list_pending": def("input.list_pending", {
    params: z.object({ thread_id: ThreadId.optional() }),
    result: z.object({ requests: z.array(InputRequest) }),
    callers: EVERYONE,
    description: "Unanswered input requests.",
  }),
  "input.answer": def("input.answer", {
    params: z.object({ request_id: RequestId, response: InputResponse, via: AnswerVia }),
    result: z.discriminatedUnion("status", [
      z.object({ status: z.literal("applied") }),
      /** First answer wins (§5.6): a second device learns who answered. */
      z.object({ status: z.literal("already_resolved"), state: InputRequestState, answered_by: z.string().nullable() }),
    ]),
    callers: EVERYONE,
    description: "Answer an input request. Fails with AUTHORITY_INSUFFICIENT when the caller may not answer it (`INPUT_ANSWER_RIGHTS`, `checkResponse`).",
  }),

  // ---- monitor state (§8.3)
  "monitors.state.get": def("monitors.state.get", {
    params: z.object({ task_id: TaskId }),
    result: z.object({ state: MonitorState.nullable() }),
    callers: EVERYONE,
    description: "The monitor's stored state.",
  }),
  "monitors.state.set": def("monitors.state.set", {
    params: z.object({
      task_id: TaskId,
      state: JsonValue.refine((v) => jsonByteLength(v) <= MONITOR_STATE_MAX_BYTES, `at most ${MONITOR_STATE_MAX_BYTES} bytes`),
      expected_version: z.int().min(1),
    }),
    result: z.object({ state: MonitorState }),
    callers: NOT_WEB,
    description: "Edit the state by hand (§8.3). CONFLICT unless `expected_version` is current.",
  }),
  "monitors.state.reset": def("monitors.state.reset", {
    params: z.object({ task_id: TaskId, expected_version: z.int().min(1) }),
    result: Ok,
    callers: NOT_WEB,
    description: "Clear the state so the next run starts fresh.",
  }),

  // ---- blobs (§6)
  "blobs.get": def("blobs.get", {
    params: z.object({ sha256: Sha256Hex, offset: z.int().nonnegative(), length: z.int().min(1).max(BLOB_PAGE_MAX_BYTES) }),
    result: z.object({ sha256: Sha256Hex, size: z.int().nonnegative(), offset: z.int().nonnegative(), data: Base64, eof: z.boolean() }),
    callers: EVERYONE,
    description: "A page of a large tool input or output. NOT_FOUND once retention has expired it.",
  }),

  // ---- CLI tokens (§5.2)
  "cli.tokens.list": def("cli.tokens.list", {
    params: Empty,
    result: z.object({ tokens: z.array(CliTokenInfo) }),
    callers: LOCAL_UI,
    description: "Approved CLI tokens, for settings.",
  }),
  "cli.tokens.revoke": def("cli.tokens.revoke", {
    params: z.object({ token_id: Uuid }),
    result: Ok,
    callers: LOCAL_UI,
    description: "Revoke a CLI token. Open connections using it are closed.",
  }),
  "cli.sign_out": def("cli.sign_out", {
    params: Empty,
    result: Ok,
    callers: ["cli"],
    description: "Revoke the token this connection authenticated with (`homerun logout`). The connection is closed after the reply.",
  }),

  // ---- account and devices (§9.6, §10)
  "account.status": def("account.status", {
    params: Empty,
    result: z.object({ status: AccountStatus }),
    callers: LOCAL_UI,
    description: "Whether this desktop is signed in, and its relay link.",
  }),
  "account.sign_in": def("account.sign_in", {
    params: Empty,
    result: z.object({ status: AccountStatus }),
    callers: LOCAL_UI,
    description:
      "Start signing in (§10.4): the runtime asks the shell to open the provider's page in the system browser (`browser.open`) and waits on a loopback redirect. `account.changed` reports the outcome.",
  }),
  "account.cancel_sign_in": def("account.cancel_sign_in", {
    params: Empty,
    result: z.object({ status: AccountStatus }),
    callers: LOCAL_UI,
    description: "Stop waiting for the browser.",
  }),
  "account.sign_out": def("account.sign_out", {
    params: Empty,
    result: z.object({ status: AccountStatus }),
    callers: LOCAL_UI,
    description: "Revoke the refresh token, close the relay link and forget the token. Paired devices are kept for the same account.",
  }),
  "account.delete": def("account.delete", {
    params: Empty,
    result: z.object({ status: AccountStatus }),
    callers: LOCAL_UI,
    description: "Delete the account's devices, links and queued messages at the relay (§10.7), unpair everything here, and sign out.",
  }),
  "devices.list": def("devices.list", {
    params: Empty,
    result: z.object({ devices: z.array(PairedDevice) }),
    callers: LOCAL_UI,
    description: "Phones and browsers linked to this desktop, with presence.",
  }),
  "devices.unpair": def("devices.unpair", {
    params: z.object({ device_id: DeviceId }),
    result: Ok,
    callers: LOCAL_UI,
    description: "Remove the link at the relay and forget the device's key (§9.6). Its live sessions close.",
  }),
  "devices.pairing.start": def("devices.pairing.start", {
    params: Empty,
    result: z.object({ offer_id: Uuid, qr_url: z.string().url().max(512), expires_at: TimestampMs }),
    callers: LOCAL_UI,
    description:
      "Open a QR pairing offer (§9.6). The QR code holds a one-time secret: show it only on this screen. `devices.pairing_completed` follows when a phone scans it.",
  }),
  "devices.pairing.cancel": def("devices.pairing.cancel", {
    params: z.object({ offer_id: Uuid }),
    result: Ok,
    callers: LOCAL_UI,
    description: "Close a pairing offer before it expires.",
  }),

  // ---- shell only (§5.2)
  "devices.link.decide": def("devices.link.decide", {
    params: z.object({ request_id: Uuid, approve: z.boolean() }),
    result: Ok,
    callers: SHELL,
    description: "The user compared the codes in the shell's native prompt and linked the device, or didn't (§10.5).",
  }),
  "cli.approve": def("cli.approve", {
    params: z.object({ request_id: Uuid }),
    result: z.object({ token_id: Uuid }),
    callers: SHELL,
    description: "The user approved a CLI access request in the shell's native prompt.",
  }),
  "cli.deny": def("cli.deny", {
    params: z.object({ request_id: Uuid }),
    result: Ok,
    callers: SHELL,
    description: "The user denied a CLI access request.",
  }),
  "secrets.set": def("secrets.set", {
    params: z.object({ name: SecretName, value: z.string().min(1).max(16_384) }),
    result: Ok,
    callers: SHELL,
    description: "Hand a keychain secret to the runtime, held in memory only. Never overwrites a newer pending value.",
  }),
  "secrets.clear": def("secrets.clear", {
    params: z.object({ name: SecretName }),
    result: Ok,
    callers: SHELL,
    description: "Forget a secret, e.g. after sign-out.",
  }),
  "secrets.verify": def("secrets.verify", {
    params: z.object({ name: z.literal("anthropic_api_key"), value: z.string().min(1).max(16_384) }),
    result: z.object({ outcome: z.enum(["valid", "invalid", "unreachable"]), detail: z.string().max(500).optional() }),
    callers: SHELL,
    description:
      "Check a candidate API key with the provider before the shell stores it (§7.2). Does not keep or use the value. `unreachable`: no answer, so the key may still be fine.",
  }),

  // ---- runtime → shell (§5.2)
  "secrets.persist": def("secrets.persist", {
    direction: "to_shell",
    params: z.object({ name: SecretName, value: z.string().min(1).max(16_384) }),
    result: z.object({ stored: z.literal(true) }),
    callers: [],
    description: "Store a runtime-created secret in the keychain. Pending in the runtime until acknowledged.",
  }),
  "secrets.delete": def("secrets.delete", {
    direction: "to_shell",
    params: z.object({ name: SecretName }),
    result: z.object({ deleted: z.literal(true) }),
    callers: [],
    description: "Remove a runtime-created secret from the keychain (the refresh token after sign-out).",
  }),
} as const satisfies Record<string, MethodDef>;

export type MethodName = keyof typeof METHODS;
export type MethodParams<M extends MethodName> = z.input<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.output<(typeof METHODS)[M]["result"]>;
export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];

export function isMethodName(m: string): m is MethodName {
  return Object.hasOwn(METHODS, m);
}

export function methodSchemaIds(m: MethodName): { params: string; result: string } {
  return { params: PARAM_IDS.get(m)!, result: RESULT_IDS.get(m)! };
}

// ---------------------------------------------------------------- notifications

export type NotificationDirection = "runtime_to_client" | "runtime_to_shell" | "shell_to_runtime";

export interface NotificationDef<P extends z.ZodType = z.ZodType> {
  readonly direction: NotificationDirection;
  readonly params: P;
  /** runtime_to_client: roles that may receive it. */
  readonly recipients: readonly CallerRole[];
  readonly description: string;
}

const NOTIFICATION_IDS = new Map<string, string>();

function note<P extends z.ZodType>(name: string, d: NotificationDef<P>): NotificationDef<P> {
  const params = named(`${pascal(name)}Notification`, d.params);
  NOTIFICATION_IDS.set(name, params.meta()!.id as string);
  return { ...d, params };
}

/** Local notification limits (§8.2, §9.7): a line each, never tool input or secrets. */
export const LOCAL_NOTIFICATION_TITLE_MAX = 80;
export const LOCAL_NOTIFICATION_BODY_MAX = 160;

export const LocalNotificationKind = named(
  "LocalNotificationKind",
  z.enum(["approval", "question", "ambiguous_call", "monitor_report", "monitor_failed", "monitor_paused", "missed_checks", "digest"]),
  "What a local notification is about (§8.2, §9.7)",
);
export type LocalNotificationKind = z.infer<typeof LocalNotificationKind>;

/** Where clicking the notification goes: the thread, or the Health screen for device-wide news. */
export const NotificationTarget = named(
  "NotificationTarget",
  z.discriminatedUnion("screen", [z.object({ screen: z.literal("thread"), thread_id: ThreadId }), z.object({ screen: z.literal("health") })]),
);
export type NotificationTarget = z.infer<typeof NotificationTarget>;

/** Replaces an earlier notification with the same key, and names it for `notification.withdrawn`. */
const NotificationKey = z.string().regex(/^[a-z_]+:[0-9a-z_:-]{1,120}$/);

/** Composed by the runtime from fixed templates (§8.2): the shell only displays it. Named by its notification. */
export const LocalNotification = z.object({
    key: NotificationKey,
    kind: LocalNotificationKind,
    target: NotificationTarget,
    /** Groups notifications per thread; null for device-wide ones. */
    thread_id: ThreadId.nullable(),
    title: z.string().min(1).max(LOCAL_NOTIFICATION_TITLE_MAX),
    body: z.string().max(LOCAL_NOTIFICATION_BODY_MAX),
    created_at: TimestampMs,
});
export type LocalNotification = z.infer<typeof LocalNotification>;

export const NOTIFICATIONS = {
  "thread.event": note("thread.event", {
    direction: "runtime_to_client",
    params: z.object({ subscription_id: Uuid, event: ThreadEvent }),
    recipients: EVERYONE,
    description: "An event on a subscribed thread, persisted or live-only.",
  }),
  "threads.changed": note("threads.changed", {
    direction: "runtime_to_client",
    params: z.object({ summary: ThreadSummary }),
    recipients: EVERYONE,
    description:
      "A thread's summary changed: created, new message, title, unread count, pending input, run state. Sent to every authenticated connection.",
  }),
  "cli.access_decision": note("cli.access_decision", {
    direction: "runtime_to_client",
    params: z
      .object({
        request_id: Uuid,
        approved: z.boolean(),
        token: CliToken.optional(),
        token_id: Uuid.optional(),
        /** Why no token was issued: the user said no, or nobody answered in time. */
        reason: z.enum(["denied", "expired"]).optional(),
      })
      .refine((p) => p.approved === (p.token !== undefined && p.token_id !== undefined), "a token is issued exactly when approved")
      .refine((p) => p.approved === (p.reason === undefined), "a reason is given exactly when not approved"),
    recipients: ["cli"],
    description:
      "Sent once to the connection that called `cli.request_access`, and to no other. The CLI stores the token in its keychain item, then says `hello` with it on the same connection.",
  }),
  "cli.access_requested": note("cli.access_requested", {
    direction: "runtime_to_shell",
    params: z.object({ request_id: Uuid, client: ClientInfo, hostname: Hostname, requested_at: TimestampMs, expires_at: TimestampMs }),
    recipients: SHELL,
    description:
      "Show 'Allow the Homerun CLI to control your agents?'. Answer with `cli.approve` or `cli.deny`. Replayed when the shell connects while the request is pending.",
  }),
  "cli.access_withdrawn": note("cli.access_withdrawn", {
    direction: "runtime_to_shell",
    params: z.object({ request_id: Uuid, reason: z.enum(["expired", "cancelled"]) }),
    recipients: SHELL,
    description: "Dismiss the prompt for this request: it expired, or the CLI went away before an answer.",
  }),
  "notification.requested": note("notification.requested", {
    direction: "runtime_to_shell",
    params: LocalNotification,
    recipients: SHELL,
    description:
      "Show a local notification (§8.2, §9.7). The runtime writes the text; clicking opens `target`. Never carries tool input or secrets, and never offers an answer: destructive approvals are answered in the app only.",
  }),
  "notification.withdrawn": note("notification.withdrawn", {
    direction: "runtime_to_shell",
    params: z.object({ key: NotificationKey }),
    recipients: SHELL,
    description: "Remove the notification with this key: the request it announced was answered, expired or cancelled.",
  }),
  "health.digest_ready": note("health.digest_ready", {
    direction: "runtime_to_client",
    params: z.object({ digest: HealthDigest }),
    recipients: EVERYONE,
    description: "The daily digest (§8.3) was generated. Also stored; `health.digest` recomputes any period.",
  }),
  "account.changed": note("account.changed", {
    direction: "runtime_to_client",
    params: z.object({ status: AccountStatus }),
    recipients: LOCAL_UI,
    description: "Sign-in state or the relay link changed.",
  }),
  "devices.changed": note("devices.changed", {
    direction: "runtime_to_client",
    params: z.object({ devices: z.array(PairedDevice) }),
    recipients: LOCAL_UI,
    description: "A device was paired, linked or unpaired, or came online or went offline.",
  }),
  "devices.pairing_completed": note("devices.pairing_completed", {
    direction: "runtime_to_client",
    params: z.object({ offer_id: Uuid, device: PairedDevice }),
    recipients: LOCAL_UI,
    description: "A phone scanned this offer's QR code and is now paired: close the pairing screen.",
  }),
  "devices.link_requested": note("devices.link_requested", {
    direction: "runtime_to_shell",
    params: z.object({
      request_id: Uuid,
      name: z.string().min(1).max(100),
      platform: z.enum(["ios", "web"]),
      /** The six-digit code the other device shows too (§10.5). */
      code: z.string().regex(/^[0-9]{6}$/),
      requested_at: TimestampMs,
      expires_at: TimestampMs,
    }),
    recipients: SHELL,
    description:
      "Show the native 'Link this device?' prompt with the code, defaulting to Don't Link. Answer with `devices.link.decide`. Never shown in the webview: a new device gets the app's authority.",
  }),
  "devices.link_withdrawn": note("devices.link_withdrawn", {
    direction: "runtime_to_shell",
    params: z.object({ request_id: Uuid, reason: z.enum(["expired", "cancelled"]) }),
    recipients: SHELL,
    description: "Close the link prompt: it expired, or the other device gave up.",
  }),
  "browser.open": note("browser.open", {
    direction: "runtime_to_shell",
    params: z.object({ url: z.string().url().max(4096) }),
    recipients: SHELL,
    description:
      "Open the identity provider's sign-in page in the system browser (§10.4, RFC 8252). The shell opens https URLs only (and http on 127.0.0.1 in development builds).",
  }),
  "power.will_sleep": note("power.will_sleep", {
    direction: "shell_to_runtime",
    params: z.object({ at: TimestampMs }),
    recipients: [],
    description: "The OS is about to sleep.",
  }),
  "power.did_wake": note("power.did_wake", {
    direction: "shell_to_runtime",
    params: z.object({ at: TimestampMs, slept_at: TimestampMs.nullable() }),
    recipients: [],
    description: "The OS woke. The scheduler re-evaluates missed fires (§8.2).",
  }),
} as const satisfies Record<string, NotificationDef>;

export type NotificationName = keyof typeof NOTIFICATIONS;
export type NotificationParams<N extends NotificationName> = z.input<(typeof NOTIFICATIONS)[N]["params"]>;
export const NOTIFICATION_NAMES = Object.keys(NOTIFICATIONS) as NotificationName[];

export function notificationSchemaId(n: NotificationName): string {
  return NOTIFICATION_IDS.get(n)!;
}
