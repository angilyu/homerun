/**
 * What the state layer needs from its platform, injected so the same code runs in a webview, in
 * React Native and under `bun test` with a fake clock (§9.8). Nothing here touches the DOM.
 */
export interface Env {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A random UUID v4, e.g. a `client_msg_id`. */
  newId(): string;
}

interface Globals {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  crypto?: { randomUUID?(): string };
}

export function defaultEnv(): Env {
  const g = globalThis as unknown as Globals;
  return {
    now: () => Date.now(),
    setTimeout: (cb, ms) => g.setTimeout(cb, ms),
    clearTimeout: (h) => g.clearTimeout(h),
    newId: () => {
      const id = g.crypto?.randomUUID?.();
      if (!id) throw new Error("crypto.randomUUID is not available");
      return id;
    },
  };
}
