import { errorMessage } from "./errors";
import { Store } from "./store";

export interface ResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * One fetched value with its loading and error state, e.g. a task's grants or today's digest.
 * `refresh` keeps the old data while loading, so a view doesn't flicker; a late answer from an
 * older refresh never overwrites a newer one.
 */
export class Resource<T> {
  readonly store = new Store<ResourceState<T>>({ data: null, loading: false, error: null });
  private generation = 0;

  constructor(private readonly fetcher: () => Promise<T>) {}

  async refresh(): Promise<void> {
    const g = ++this.generation;
    this.store.set((s) => ({ ...s, loading: true }));
    try {
      const data = await this.fetcher();
      if (g === this.generation) this.store.set({ data, loading: false, error: null });
    } catch (e) {
      if (g === this.generation) this.store.set((s) => ({ ...s, loading: false, error: errorMessage(e) }));
    }
  }

  /** Replace the value after a mutation that returned it. */
  set(data: T): void {
    this.generation++;
    this.store.set({ data, loading: false, error: null });
  }
}
