/**
 * A minimal observable value. Views bind it with `useSyncExternalStore` (React DOM and React
 * Native alike, §9.8): `get` must return the same object until the value changes.
 */
export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  readonly get = (): T => this.value;

  set(next: T | ((prev: T) => T)): void {
    const v = typeof next === "function" ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const l of [...this.listeners]) l();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
