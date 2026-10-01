import { createContext, type ComponentType, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppClient, Store, errorMessage } from "@homerun/app-state";
import type { KeyStatus, ShellApi, ShellTarget, UpdateState } from "./platform/types";

/** A state-layer store in a React view (§9.8). React Native binds the same stores the same way. */
export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

export type Route =
  | { name: "home" }
  | { name: "thread"; thread_id: string }
  | { name: "new_chat"; task_id?: string }
  | { name: "inbox" }
  | { name: "tasks" }
  | { name: "task"; task_id: string }
  | { name: "task_edit"; task_id?: string; kind?: "session" | "monitor"; from_thread_id?: string }
  | { name: "health" }
  | { name: "settings" };

export interface App {
  client: AppClient;
  /** Null in the web client: no keychain, runtime process or updater (§9.9). */
  shell: ShellApi | null;
  /** Open a link outside the app: the shell's browser, or a new tab. */
  openExternal(url: string): void;
  /** The web client's own settings section, if any. */
  settings: ComponentType | null;
  /** Try connecting again after a blocked status, where there's no shell to restart. */
  retry: (() => void) | null;
  route: Store<Route>;
  /** The API key's status; null until the shell answers. */
  key: Store<KeyStatus | null>;
  /** The updater (§11); null until the shell answers. */
  update: Store<UpdateState | null>;
  refreshKey(): Promise<void>;
  go(r: Route): void;
}

/** A notification click or a menu-bar row (§8.2): the screen it names. */
export function routeFor(t: ShellTarget): Route {
  switch (t.screen) {
    case "thread":
      return { name: "thread", thread_id: t.thread_id };
    case "health":
      return { name: "health" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "home" };
  }
}

export const AppContext = createContext<App | null>(null);

export function useApp(): App {
  const a = useContext(AppContext);
  if (!a) throw new Error("no AppContext");
  return a;
}

/** The desktop shell, for views that only the desktop shows (the key, login item, updater). */
export function useShell(): ShellApi {
  const shell = useApp().shell;
  if (!shell) throw new Error("no shell in this client");
  return shell;
}

/** The current time, ticking every `ms` while mounted, for "in 12 min" labels. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch while mounted; again when `deps` change, when the runtime reconnects, and every
 * `pollMs` if given (tasks and schedules have no change notification, plan Q10).
 */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[], pollMs?: number): Loaded<T> {
  const { client } = useApp();
  const runtime = useStore(client.runtime);
  const connection = runtime.state === "ready" ? runtime.connection : -1;
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const gen = useRef(0);
  const f = useRef(fetcher);
  f.current = fetcher;
  const reload = useCallback(() => {
    const g = ++gen.current;
    setState((s) => ({ ...s, loading: true }));
    f.current().then(
      (data) => g === gen.current && setState({ data, error: null, loading: false }),
      (e) => g === gen.current && setState((s) => ({ ...s, error: errorMessage(e), loading: false })),
    );
  }, []);
  useEffect(() => {
    if (connection < 0) return;
    reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, pollMs, ...deps]);
  return { ...state, reload };
}

/** Run an action with a busy flag and an error message for the view. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>): { run: (...a: A) => Promise<boolean>; busy: boolean; error: string | null; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...a: A) => {
      setBusy(true);
      setError(null);
      try {
        await fn(...a);
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, clear: () => setError(null) };
}
