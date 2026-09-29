import type { RuntimeStatus, Transport, TransportEvent } from "@homerun/app-state";
import { fromShellError } from "./errors";
import type { AppInfo, KeyStatus, Platform, SetKeyOutcome } from "./types";

/**
 * A platform over a WebSocket to a stand-in shell (test/e2e/bridge-server.ts), for the E2E smoke
 * test and for working on the UI in a browser. Same protocol as the Tauri commands; never part
 * of the app bundle.
 *
 *   → {id, cmd, args}           ← {id, ok} | {id, err: ShellError}      ← {event: TransportEvent}
 */
export function bridgePlatform(url: string): Platform {
  let status: RuntimeStatus = { state: "starting" };
  const listeners = new Set<(e: TransportEvent) => void>();
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let nextId = 1;
  let ws: WebSocket;
  let open: Promise<void>;

  const connect = () => {
    ws = new WebSocket(url);
    open = new Promise((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));
    ws.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; ok?: unknown; err?: unknown; event?: TransportEvent };
      if (msg.event) {
        if (msg.event.type === "status") status = msg.event.status;
        for (const l of [...listeners]) l(msg.event);
        return;
      }
      const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id!);
      if ("err" in msg) p.reject(fromShellError(msg.err));
      else p.resolve(msg.ok);
    });
    ws.addEventListener("close", () => {
      for (const p of pending.values()) p.reject(fromShellError({ kind: "not_connected", message: "The bridge closed." }));
      pending.clear();
    });
  };
  connect();

  const call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    await open;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id, cmd, args }));
    });
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
