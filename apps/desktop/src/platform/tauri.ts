import { Channel, invoke } from "@tauri-apps/api/core";
import type { RuntimeStatus, Transport, TransportEvent } from "@homerun/app-state";
import { fromShellError } from "./errors";
import type { AppInfo, KeyStatus, Platform, SetKeyOutcome } from "./types";

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
      keyStatus: () => call<KeyStatus>("key_status"),
      setKey: (value) => call<SetKeyOutcome>("key_set", { value }),
      clearKey: () => call<void>("key_clear"),
      restartRuntime: () => call<void>("runtime_restart"),
      openExternal: (url) => call<void>("open_external", { url }),
      revealLogs: () => call<void>("reveal_logs"),
      appInfo: () => call<AppInfo>("app_info"),
    },
  };
}
