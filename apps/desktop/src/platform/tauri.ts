import { Channel, invoke } from "@tauri-apps/api/core";
import type { RuntimeStatus, Transport, TransportEvent } from "@homerun/app-state";
import { fromShellError } from "./errors";
import { shellCommands, type Platform, type ShellEvent } from "./types";

/**
 * The desktop platform: every call goes to the shell over Tauri IPC (§5.2). Runtime methods go
 * through `rpc_call`, which the shell forwards on its webview-role connection after checking
 * the webview allowlist; notifications and runtime status arrive in order on one channel.
 */
export function tauriPlatform(): Platform {
  let status: RuntimeStatus = { state: "starting" };
  const listeners = new Set<(e: TransportEvent) => void>();
  const channel = new Channel<TransportEvent>();
  channel.onmessage = (e) => {
    if (e.type === "status") status = e.status;
    for (const l of [...listeners]) l(e);
  };
  void invoke("rpc_attach", { channel });

  // Notification clicks can arrive before React mounts: the shell queues them until this attaches.
  const shellListeners = new Set<(e: ShellEvent) => void>();
  const early: ShellEvent[] = [];
  const shellChannel = new Channel<ShellEvent>();
  shellChannel.onmessage = (e) => {
    if (shellListeners.size === 0) early.push(e);
    for (const l of [...shellListeners]) l(e);
  };
  void invoke("shell_events_attach", { channel: shellChannel });

  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      throw fromShellError(e);
    }
  };

  const transport: Transport = {
    call: (method, params) => call("rpc_call", { method, params }),
    listen: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    status: () => status,
  };

  return {
    transport,
    shell: {
      ...shellCommands(call),
      onEvent: (l) => {
        shellListeners.add(l);
        for (const e of early.splice(0)) l(e);
        return () => void shellListeners.delete(l);
      },
    },
  };
}
