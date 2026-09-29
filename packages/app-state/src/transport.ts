/**
 * How a client reaches the runtime. The desktop app forwards calls through the Tauri shell,
 * which holds the webview-role connection (§5.2); the web and iOS clients will go through the
 * relay (§9). The state layer sees only this interface.
 */

/**
 * The runtime as the platform sees it. On desktop the shell supervises `homerund` (§5.1) and
 * reports its state; `connection` changes every time a new connection is ready, so thread
 * subscriptions, which belong to a connection, are made again.
 */
export type RuntimeStatus =
  | { state: "starting" }
  | { state: "ready"; connection: number; device_id: string; runtime_version: string; protocol: number }
  /** It stopped unexpectedly and is being restarted, at `retry_at` if known. */
  | { state: "restarting"; retry_at: number | null; last_error: string | null }
  /** It kept crashing: fast restarts stopped, the shell retries slowly (§5.1). */
  | { state: "crash_loop"; retry_at: number | null; last_error: string | null }
  /** It can't run until the user acts; no automatic restart. */
  | { state: "blocked"; reason: BlockedReason; message: string }
  | { state: "stopping" };

export type BlockedReason = "other_runtime" | "database_too_new" | "incompatible" | "failed";

export type TransportEvent =
  | { type: "notification"; method: string; params: unknown }
  | { type: "status"; status: RuntimeStatus };

export interface Transport {
  /**
   * Call a runtime method. Rejects with `RpcCallError` for a JSON-RPC error and
   * `NotConnectedError` when the runtime can't be reached.
   */
  call(method: string, params: unknown): Promise<unknown>;
  /** Notifications and status changes, in order. Returns an unsubscribe function. */
  listen(listener: (e: TransportEvent) => void): () => void;
  status(): RuntimeStatus;
}
