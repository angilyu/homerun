import { CALLER_ROLES, type CallerRole } from "./handshake";
import { METHODS, METHOD_NAMES, NOTIFICATIONS, NOTIFICATION_NAMES, type MethodName, type NotificationName } from "./methods";

/**
 * Per-caller allowlists, derived from the method table. The runtime checks every request
 * against its connection's role and answers FORBIDDEN otherwise. The Rust shell uses
 * `ALLOWLISTS.webview` (via `schema/callers.json`) for the Tauri commands it forwards.
 */
export const ALLOWLISTS: Readonly<Record<CallerRole, readonly MethodName[]>> = Object.fromEntries(
  CALLER_ROLES.map((role) => [
    role,
    METHOD_NAMES.filter((m) => METHODS[m].direction === "to_runtime" && (METHODS[m].callers as readonly string[]).includes(role)),
  ]),
) as Record<CallerRole, MethodName[]>;

/** Methods only the shell's own launch-token connection may call: never forwarded, never CLI. */
export const SHELL_ONLY_METHODS: readonly MethodName[] = METHOD_NAMES.filter(
  (m) => METHODS[m].direction === "to_runtime" && METHODS[m].callers.length === 1 && METHODS[m].callers[0] === "shell",
);

/** Requests the runtime sends to the shell. */
export const RUNTIME_TO_SHELL_METHODS: readonly MethodName[] = METHOD_NAMES.filter((m) => METHODS[m].direction === "to_shell");

export const PREAUTH_METHODS: readonly MethodName[] = METHOD_NAMES.filter((m) => METHODS[m].preauth);

export type AuthorizeResult = { ok: true } | { ok: false; reason: "unknown_method" | "handshake_required" | "forbidden" };

/**
 * Whether a request may proceed. `role` is null before `hello` succeeds. Params are validated
 * separately, after this check, so a forbidden caller learns nothing about param shapes.
 */
export function authorize(role: CallerRole | null, method: string): AuthorizeResult {
  if (!Object.hasOwn(METHODS, method)) return { ok: false, reason: "unknown_method" };
  const m = METHODS[method as MethodName];
  if (m.direction !== "to_runtime") return { ok: false, reason: "forbidden" };
  if (role === null) return m.preauth ? { ok: true } : { ok: false, reason: "handshake_required" };
  if (method === "hello" || method === "cli.request_access") return { ok: false, reason: "forbidden" };
  return (m.callers as readonly string[]).includes(role) ? { ok: true } : { ok: false, reason: "forbidden" };
}

/** Whether the runtime may send this notification to a connection with `role`. */
export function mayReceive(role: CallerRole, n: NotificationName): boolean {
  const d = NOTIFICATIONS[n];
  if (d.direction === "shell_to_runtime") return false;
  return (d.recipients as readonly string[]).includes(role);
}

export const NOTIFICATIONS_BY_DIRECTION = {
  runtime_to_client: NOTIFICATION_NAMES.filter((n) => NOTIFICATIONS[n].direction === "runtime_to_client"),
  runtime_to_shell: NOTIFICATION_NAMES.filter((n) => NOTIFICATIONS[n].direction === "runtime_to_shell"),
  shell_to_runtime: NOTIFICATION_NAMES.filter((n) => NOTIFICATIONS[n].direction === "shell_to_runtime"),
} as const;

/** Whether a connection with `role` may send this notification to the runtime. */
export function maySend(role: CallerRole, n: NotificationName): boolean {
  return NOTIFICATIONS[n].direction === "shell_to_runtime" && role === "shell";
}
