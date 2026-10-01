import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AppClient, Store } from "@homerun/app-state";
import { coalesced } from "../coalesce";
import type { AppLock } from "../lock";
import type { IosSession } from "../session";

/** A state-layer store in a view (§9.8): the same binding as the desktop's React DOM views. */
export function useStore<T>(s: Store<T>): T {
  return useSyncExternalStore(s.subscribe, s.get, s.get);
}

/** A store that changes many times a second (a streaming reply): re-render at most every `ms`. */
export function useCoalescedStore<T>(s: Store<T>, ms = 120): T {
  const subscribe = useMemo(() => coalesced(s.subscribe, ms), [s, ms]);
  return useSyncExternalStore(subscribe, s.get, s.get);
}

/** The current time, ticking every `ms` while mounted, for "in 12 h" labels. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** One shown desktop: its app-state client. */
export interface PhoneApp {
  client: AppClient;
  desktopId: string;
}

export interface Phone {
  session: IosSession<PhoneApp>;
  lock: AppLock;
  /** Face ID (or the passcode) for this one step. */
  authenticate(reason: string): Promise<boolean>;
}

export const PhoneContext = createContext<Phone | null>(null);
export const DesktopContext = createContext<PhoneApp | null>(null);

export function usePhone(): Phone {
  const p = useContext(PhoneContext);
  if (!p) throw new Error("no PhoneContext");
  return p;
}

export function useDesktop(): PhoneApp {
  const d = useContext(DesktopContext);
  if (!d) throw new Error("no DesktopContext");
  return d;
}
