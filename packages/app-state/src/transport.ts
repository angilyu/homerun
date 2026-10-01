/**
 * How a client reaches the runtime. The desktop app forwards calls through the Tauri shell,
 * which holds the webview-role connection (§5.2); the web and iOS clients go through the relay
 * to a desktop (§9, `RelayTransport` in `@homerun/remote`). The state layer sees only this
 * interface.
 */

/** Who this client is to the runtime: the desktop's own window, or a remote (§9.9, §12). */
export type ClientRole = "webview" | "ios" | "web";

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
  | { state: "stopping" }
  /**
   * A remote client can't reach its desktop (§9.4, §9.8): the desktop is off or asleep
   * (`last_seen_at` from the relay), or the relay itself is out of reach. Messages still queue
   * at the relay; questions and approvals wait.
   */
  | { state: "offline"; reason: "desktop" | "relay"; last_seen_at: number | null };

/** `unlinked`: a remote that the desktop no longer lists. */
export type BlockedReason = "other_runtime" | "database_too_new" | "incompatible" | "failed" | "unlinked";

/** A message for the desktop to apply when it is back (§9.4). */
export interface QueuedInstruction {
  thread_id: string;
  client_msg_id: string;
  text: string;
}

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
  /**
   * A remote client's offline path (§9.4): seal a message for the desktop, which applies it once
   * when it is back, if before `expires_at`. Absent on the desktop, whose runtime is local.
   */
  queueInstruction?(i: QueuedInstruction): Promise<{ expires_at: number }>;
}
