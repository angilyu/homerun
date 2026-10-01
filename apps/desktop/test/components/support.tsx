import { expect } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { AppClient } from "@homerun/app-state";
import { AppRoot, createApp } from "../../src/app";
import type { Route } from "../../src/hooks";
import type { AppInfo, CliToolStatus, KeyStatus, LoginItemStatus, NotificationPermission, SetKeyOutcome, ShellApi, ShellEvent, ShellPrefs, UpdateState } from "../../src/platform/types";
import { DEVICE, FakeTransport, T0, uuid } from "../../../../packages/app-state/test/helpers";

export * from "../../../../packages/app-state/test/helpers";

/** The shell's services, faked (the real ones are Rust; plan §9). */
export class FakeShell implements ShellApi {
  key: KeyStatus = { present: true, hint: "abcd", store: "memory" };
  setKeyResult: SetKeyOutcome | Error = { outcome: "saved" };
  calls: string[] = [];
  opened: string[] = [];
  keyStatus = async () => (this.calls.push("keyStatus"), { ...this.key });
  setKey = async (v: string) => {
    this.calls.push(`setKey:${v}`);
    if (this.setKeyResult instanceof Error) throw this.setKeyResult;
    if (this.setKeyResult.outcome !== "rejected") this.key = { present: true, hint: v.slice(-4), store: "memory" };
    return this.setKeyResult;
  };
  clearKey = async () => {
    this.calls.push("clearKey");
    this.key = { present: false, hint: null, store: "memory" };
  };
  restartRuntime = async () => void this.calls.push("restartRuntime");
  openExternal = async (url: string) => void this.opened.push(url);
  revealLogs = async () => void this.calls.push("revealLogs");
  appInfo = async (): Promise<AppInfo> => ({ version: "0.2.0", build: "debug", platform: "macos", data_dir: "/tmp/h", log_path: "/tmp/h/logs/x.log", key_store: "memory" });

  shellPrefs: ShellPrefs = { keep_running_asked: true, auto_download_updates: true };
  login: LoginItemStatus = "off";
  permission: NotificationPermission = "not_determined";
  update: UpdateState = { state: "idle" };
  listeners = new Set<(e: ShellEvent) => void>();
  /** A notification click, a menu-bar row or the updater, from the shell. */
  emit(e: ShellEvent) {
    for (const l of [...this.listeners]) l(e);
  }
  onEvent = (l: (e: ShellEvent) => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  prefs = async () => ({ ...this.shellPrefs });
  keepRunningDone = async () => {
    this.calls.push("keepRunningDone");
    this.shellPrefs.keep_running_asked = true;
  };
  loginItem = async () => this.login;
  setLoginItem = async (on: boolean) => {
    this.calls.push(`setLoginItem:${on}`);
    this.login = on ? "enabled" : "off";
    return this.login;
  };
  openLoginItems = async () => void this.calls.push("openLoginItems");
  notifications = async () => this.permission;
  requestNotifications = async () => {
    this.calls.push("requestNotifications");
    if (this.permission === "not_determined") this.permission = "allowed";
    return this.permission;
  };
  openNotificationSettings = async () => void this.calls.push("openNotificationSettings");
  updateStatus = async () => this.update;
  checkForUpdates = async () => void this.calls.push("checkForUpdates");
  restartToUpdate = async () => void this.calls.push("restartToUpdate");
  setAutoUpdate = async (on: boolean) => {
    this.calls.push(`setAutoUpdate:${on}`);
    this.shellPrefs.auto_download_updates = on;
  };
  tool: CliToolStatus = { state: "unavailable", reason: "The command-line tool comes with the Homerun app; this is a development build." };
  cliTool = async () => this.tool;
  installCliTool = async () => {
    this.calls.push("installCliTool");
    if (this.tool.state === "foreign" || this.tool.state === "unavailable") throw new Error("Something else is in the way.");
    this.tool = { state: "installed", link: "/Users/me/.local/bin/homerun" };
    return this.tool;
  };
  removeCliTool = async () => {
    this.calls.push("removeCliTool");
    this.tool = { state: "not_installed", link: "/Users/me/.local/bin/homerun" };
    return this.tool;
  };
}

export const TASK = "4f5a6b7c-8d9e-4f0a-8b1c-2d3e4f5a6b01";
export const SCHEDULE = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";
export const GRANT = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d01";

export function summary(thread_id: string, over: Record<string, unknown> = {}) {
  return {
    thread_id,
    task_id: null,
    title: null,
    last_seq: 1,
    updated_at: T0,
    last_message: { seq: 1, role: "user", preview: "Hello there", ts: T0 },
    unread_count: 0,
    input_pending: false,
    active_run: null,
    ...over,
  };
}

export function sessionTask(over: Record<string, unknown> = {}) {
  const spec = {
    format: 1,
    kind: "session",
    name: "Tidy repo",
    prompt: "Keep the repo tidy.",
    model: { model: "sonnet" },
    budget: { max_run_usd: 2 },
    tools: { builtin: ["Read", "Bash"], mcp_servers: [], homerun: [] },
    policy: { roots: ["~/code"], egress: { mode: "allowlist", domains: [] }, bash_patterns: [], use_shell_environment: false, input_timeout: { action: "wait", remind_after_ms: null }, retention_days: 30 },
  };
  return { task_id: TASK, device_id: DEVICE, kind: "session", name: spec.name, version: 1, spec, archived_at: null, ...over };
}

export function monitorTask(over: Record<string, unknown> = {}) {
  const spec = {
    format: 1,
    kind: "monitor",
    name: "Price watch",
    prompt: "Tell me when the price drops.",
    budget: { max_run_usd: 0.5 },
    tools: { builtin: ["WebFetch"], mcp_servers: [], homerun: [] },
    policy: { roots: [], egress: { mode: "allowlist", domains: ["example.com"] }, bash_patterns: [], use_shell_environment: false, input_timeout: { action: "wait", remind_after_ms: null }, retention_days: 30 },
    schedule: { kind: "interval", every_minutes: 30, catchup: "run_once", max_catchup: 1 },
    check: { kind: "rule", source: { type: "http", url: "https://example.com/p", extract: { kind: "body" } }, comparator: { op: "changed" } },
    act: { model: { model: "haiku" } },
  };
  return { task_id: TASK, device_id: DEVICE, kind: "monitor", name: spec.name, version: 3, spec, archived_at: null, ...over };
}

export function scheduleState(over: Record<string, unknown> = {}) {
  return {
    schedule_id: SCHEDULE,
    task_id: TASK,
    schedule: { kind: "interval", every_minutes: 30, catchup: "run_once", max_catchup: 1 },
    enabled: true,
    paused_reason: null,
    next_fire_at: Date.now() + 12 * 60_000,
    last_fired_at: null,
    consecutive_failures: 0,
    missed_since_last_run: 0,
    ...over,
  };
}

export function accountStatus(over: Record<string, unknown> = {}) {
  return { state: "signed_out", email: null, error: null, relay: { state: "off", since: null, error: null }, link_request: null, ...over };
}

/** A transport that answers the calls every screen makes, with nothing in it. */
export function baseTransport(): FakeTransport {
  const t = new FakeTransport();
  t.handlers = {
    "threads.list": () => ({ threads: [], has_more: false }),
    "input.list_pending": () => ({ requests: [] }),
    "tasks.list": () => ({ tasks: [] }),
    "schedules.list": () => ({ schedules: [] }),
    "threads.history": () => ({ events: [], has_more: false }),
    "threads.subscribe": () => ({ subscription_id: uuid() }),
    "threads.unsubscribe": () => ({ ok: true }),
    "threads.mark_read": () => ({ ok: true }),
    "account.status": () => ({ status: accountStatus() }),
    "devices.list": () => ({ devices: [] }),
  };
  return t;
}

export interface Harness {
  t: FakeTransport;
  shell: FakeShell;
  client: AppClient;
  go(r: Route): void;
}

/** Render the whole app over a fake transport and shell, connected. */
export async function renderApp(opts: { t?: FakeTransport; shell?: FakeShell; route?: Route; connect?: boolean } = {}): Promise<Harness> {
  const t = opts.t ?? baseTransport();
  const shell = opts.shell ?? new FakeShell();
  const client = new AppClient(t, { keepThreadMs: 0, remote: true });
  const app = createApp({ transport: t, shell }, client);
  if (opts.route) app.route.set(opts.route);
  client.start();
  if (opts.connect !== false) t.ready();
  render(<AppRoot app={app} />);
  if (shell.key.present && shell.shellPrefs.keep_running_asked) await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
  return { t, shell, client, go: app.go };
}

export interface WebHarness {
  t: FakeTransport;
  client: AppClient;
  retried: number;
  go(r: Route): void;
}

/** Render the app as the web client renders it: no shell, the web role, its own settings (§9.9). */
export async function renderWeb(opts: { t?: FakeTransport; route?: Route; connect?: boolean } = {}): Promise<WebHarness> {
  const t = opts.t ?? baseTransport();
  const client = new AppClient(t, { keepThreadMs: 0, role: "web" });
  const h: WebHarness = { t, client, retried: 0, go: () => {} };
  const app = createApp({ transport: t, shell: null, role: "web", settings: () => <section aria-label="This browser">Signed in on the web</section>, retry: () => void h.retried++ }, client);
  h.go = app.go;
  if (opts.route) app.route.set(opts.route);
  client.start();
  if (opts.connect !== false) t.ready();
  render(<AppRoot app={app} />);
  await waitFor(() => expect(screen.getByRole("navigation")).toBeTruthy());
  return h;
}
