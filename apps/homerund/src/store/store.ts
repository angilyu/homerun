import type { Database } from "bun:sqlite";
import type { Bus } from "../bus";

/**
 * The database plus the event bus. Persisted events reach subscribers only after their
 * transaction commits, so a client never sees an event that a rollback later removes.
 *
 * Every write goes through `tx`, so each durable change is one commit. The crash harness
 * (§16.2) watches commits through `Store.commitObserver` to kill the process at each one.
 */
export class Store {
  /** Test-only: called synchronously after every commit, before any after-commit hook. */
  static commitObserver: (() => void) | null = null;

  private pending: Array<() => void> | null = null;

  constructor(
    readonly db: Database,
    readonly bus: Bus,
  ) {}

  /** A write transaction. Nested calls join the outer one; after-commit hooks run once it commits. */
  tx<T>(fn: () => T): T {
    if (this.pending) return fn();
    this.pending = [];
    let hooks: Array<() => void>;
    let out: T;
    try {
      out = this.db.transaction(fn).immediate();
      hooks = this.pending;
    } finally {
      this.pending = null;
    }
    Store.commitObserver?.();
    for (const h of hooks) h();
    return out;
  }

  afterCommit(fn: () => void): void {
    if (this.pending) this.pending.push(fn);
    else fn();
  }

  get inTx(): boolean {
    return this.pending !== null;
  }
}
