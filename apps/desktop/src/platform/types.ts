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

export interface ShellApi {
  keyStatus(): Promise<KeyStatus>;
  setKey(value: string): Promise<SetKeyOutcome>;
  clearKey(): Promise<void>;
  restartRuntime(): Promise<void>;
  /** http(s) and mailto only; opens in the default browser, never in the webview. */
  openExternal(url: string): Promise<void>;
  revealLogs(): Promise<void>;
  appInfo(): Promise<AppInfo>;
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
