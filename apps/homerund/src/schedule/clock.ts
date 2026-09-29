/**
 * Time for the scheduler (§8). `now()` is wall-clock time, which jumps when the computer sleeps
 * or the user changes the clock. Timers count elapsed awake time, as the OS's do: on macOS a
 * timer does not advance while the computer sleeps, so it fires late after a wake. The scheduler
 * therefore never trusts a timer alone; each tick re-reads `now()`.
 */
export interface Clock {
  now(): number;
  /** Call `fn` after `ms` of awake time. Returns a cancel function. */
  setTimer(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (ms, fn) => {
    const t = setTimeout(fn, Math.max(0, ms));
    return () => clearTimeout(t);
  },
};

interface FakeTimer {
  id: number;
  due: number;
  fn: () => void;
}

/**
 * A clock tests drive by hand (§16.2 "Fake clock"). `advance` moves awake time and wall time
 * together and fires due timers in order; `sleep` moves wall time only, like a closed lid; `setWall`
 * jumps the wall clock, forwards or backwards, like a manual clock change.
 */
export class FakeClock implements Clock {
  private wall: number;
  private awake = 0;
  private timers: FakeTimer[] = [];
  private nextId = 1;

  constructor(start: number) {
    this.wall = start;
  }

  now(): number {
    return this.wall;
  }

  setTimer(ms: number, fn: () => void): () => void {
    const t = { id: this.nextId++, due: this.awake + Math.max(0, ms), fn };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x.id !== t.id);
    };
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  /** Move time forward `ms`, firing each timer at its moment and letting its async work settle. */
  async advance(ms: number): Promise<void> {
    const target = this.awake + ms;
    for (;;) {
      this.timers.sort((a, b) => a.due - b.due || a.id - b.id);
      const t = this.timers[0];
      if (!t || t.due > target) break;
      this.timers.shift();
      this.wall += t.due - this.awake;
      this.awake = t.due;
      t.fn();
      await settle();
    }
    this.wall += target - this.awake;
    this.awake = target;
    await settle();
  }

  /** Advance to a wall-clock instant (no sleep in between). */
  async advanceTo(wall: number): Promise<void> {
    if (wall > this.wall) await this.advance(wall - this.wall);
  }

  /** The computer sleeps for `ms`: wall time moves, timers do not. */
  sleep(ms: number): void {
    this.wall += ms;
  }

  /** The wall clock is set to `wall` (NTP correction, manual change, or a timezone-free jump). */
  setWall(wall: number): void {
    this.wall = wall;
  }
}

/** Let promise chains and immediate callbacks run. */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/** The device's own IANA timezone, e.g. for defaults. Schedules never use it implicitly. */
export function deviceTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
