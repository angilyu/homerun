type Subscribe = (listener: () => void) => () => void;

export interface Timers {
  setTimeout(f: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

/**
 * A store subscription that tells its listener at most once per `ms` (§9.8): the first change at
 * once, then the latest change in each window at its end. A streaming reply's deltas arrive ~75 ms
 * apart from the runtime; on a phone, re-rendering a long timeline for each costs more than it
 * shows. The view still reads the store's current value, so nothing is lost, only merged.
 */
export function coalesced(subscribe: Subscribe, ms: number, timers: Timers = realTimers): Subscribe {
  return (listener) => {
    let timer: unknown = null;
    let dirty = false;
    const windowEnds = () => {
      if (!dirty) {
        timer = null;
        return;
      }
      dirty = false;
      listener();
      timer = timers.setTimeout(windowEnds, ms);
    };
    const off = subscribe(() => {
      if (timer !== null) {
        dirty = true;
        return;
      }
      listener();
      timer = timers.setTimeout(windowEnds, ms);
    });
    return () => {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      off();
    };
  };
}
