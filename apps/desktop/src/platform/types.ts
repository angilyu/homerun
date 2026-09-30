import type { Transport } from "@homerun/app-state";

/**
 * What the React views need from the platform (§9.8): the runtime `Transport` for the state
 * layer, and the desktop shell's own services (§5.1): the keychain, the runtime process, and
 * opening things outside the webview. The shell implements these in Rust (src-tauri); the E2E
 * bridge implements them in TypeScript.
 */

export interface KeyStatus {
  present: boolean;
  /** The key's last four characters. */
  hint: string | null;
  /** "keychain", "keychain (legacy)" or "memory". */
  store: string;
}

export type SetKeyOutcome =
  | { outcome: "saved" }
  | { outcome: "saved_unverified"; detail: string }
  | { outcome: "rejected"; detail: string };

export interface AppInfo {
  version: string;
  build: "debug" | "release" | string;
  platform: string;
  data_dir: string;
  log_path: string;
  key_store: string;
}

/** Open at login (§5.1): `SMAppService.mainApp`. "needs_approval" means turned off in System Settings. */
export type LoginItemStatus = "enabled" | "off" | "needs_approval" | "unavailable";

/** Whether macOS lets Homerun post notifications (§8.2). "unavailable" outside the installed app. */
export type NotificationPermission = "not_determined" | "denied" | "allowed" | "unavailable";

/** The updater (§11), as the shell reports it. */
export type UpdateState =
  | { state: "idle" }
  | { state: "unavailable"; message: string }
  | { state: "checking" }
  | { state: "up_to_date"; checked_at: number }
  | { state: "downloading"; version: string }
  | { state: "ready"; version: string; note: string | null }
  | { state: "manual"; version: string; reason: string }
  | { state: "failed"; message: string; checked_at: number };

/** Where a notification click or a menu-bar row goes. */
export type ShellTarget = { screen: "thread"; thread_id: string } | { screen: "health" } | { screen: "home" };

/** From the shell, in order: a notification or menu-bar click, or the updater changed. */
export type ShellEvent = { type: "navigate"; target: ShellTarget } | { type: "update"; state: UpdateState };

export interface ShellPrefs {
  /** Onboarding's "Keep Homerun running" step was shown. */
  keep_running_asked: boolean;
  auto_download_updates: boolean;
}

export interface ShellApi {
  keyStatus(): Promise<KeyStatus>;
  setKey(value: string): Promise<SetKeyOutcome>;
  clearKey(): Promise<void>;
  restartRuntime(): Promise<void>;
  /** http(s) and mailto only; opens in the default browser, never in the webview. */
  openExternal(url: string): Promise<void>;
  revealLogs(): Promise<void>;
  appInfo(): Promise<AppInfo>;
  onEvent(listener: (e: ShellEvent) => void): () => void;
  prefs(): Promise<ShellPrefs>;
  keepRunningDone(): Promise<void>;
  loginItem(): Promise<LoginItemStatus>;
  setLoginItem(on: boolean): Promise<LoginItemStatus>;
  openLoginItems(): Promise<void>;
  notifications(): Promise<NotificationPermission>;
  /** The system prompt, the first time; after that it only reports. */
  requestNotifications(): Promise<NotificationPermission>;
  openNotificationSettings(): Promise<void>;
  updateStatus(): Promise<UpdateState>;
  checkForUpdates(): Promise<void>;
  /** Confirms like Quit when runs are active, then restarts into the update. */
  restartToUpdate(): Promise<void>;
  setAutoUpdate(on: boolean): Promise<void>;
}

/** The desktop-only shell calls, shared by the Tauri and bridge platforms. */
export function shellCommands(call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): Omit<ShellApi, "onEvent"> {
  return {
    keyStatus: () => call<KeyStatus>("key_status"),
    setKey: (value) => call<SetKeyOutcome>("key_set", { value }),
    clearKey: () => call<void>("key_clear"),
    restartRuntime: () => call<void>("runtime_restart"),
    openExternal: (url) => call<void>("open_external", { url }),
    revealLogs: () => call<void>("reveal_logs"),
    appInfo: () => call<AppInfo>("app_info"),
    prefs: () => call<ShellPrefs>("shell_prefs"),
    keepRunningDone: () => call<void>("keep_running_done"),
    loginItem: () => call<LoginItemStatus>("login_item_status"),
    setLoginItem: (on) => call<LoginItemStatus>("login_item_set", { on }),
    openLoginItems: () => call<void>("open_login_items"),
    notifications: () => call<NotificationPermission>("notifications_status"),
    requestNotifications: () => call<NotificationPermission>("notifications_request"),
    openNotificationSettings: () => call<void>("open_notification_settings"),
    updateStatus: () => call<UpdateState>("update_status"),
    checkForUpdates: () => call<void>("update_check"),
    restartToUpdate: () => call<void>("update_restart"),
    setAutoUpdate: (on) => call<void>("update_set_auto", { on }),
  };
}

export interface Platform {
  transport: Transport;
  shell: ShellApi;
}

/** A shell error that isn't a runtime error: "keychain_approval" means the keychain is waiting for the user (§11). */
export class ShellError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "ShellError";
  }
}

export const isKeychainApproval = (e: unknown) => e instanceof ShellError && e.kind === "keychain_approval";
