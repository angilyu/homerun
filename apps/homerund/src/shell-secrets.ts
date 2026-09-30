import type { SecretName } from "@homerun/core";
import { log } from "./log";
import type { SecretStore } from "./secrets";

/** The shell's connection, as far as storing secrets goes. */
export interface ShellLink {
  request(method: string, params: unknown): Promise<unknown>;
}

type Pending = { op: "persist"; value: string } | { op: "delete" };

/**
 * Secrets the runtime creates (the refresh token, the device's static keys) and the shell keeps
 * in the Keychain or Credential Manager (§5.2):
 * - A value is held in memory at once and is *pending* until the shell acknowledges
 *   `secrets.persist` (or `secrets.delete`). Pending writes are retried whenever the shell
 *   (re)connects.
 * - Once the runtime has written a name, its own value is the newest: a `secrets.set` for it
 *   (the shell handing over what the keychain held at connect) is ignored, so a stale hand-over
 *   racing a rotation never overwrites the rotated token.
 * - A runtime that restarts before a rotated refresh token was stored gets the old one back; the
 *   provider answers `invalid_grant` and the account asks to sign in again (`remote/account.ts`).
 */
export class ShellSecrets {
  private pending = new Map<SecretName, Pending>();
  private owned = new Set<SecretName>();
  private settledListeners = new Set<() => void>();

  constructor(
    private secrets: SecretStore,
    private shell: () => ShellLink | null,
  ) {}

  persist(name: SecretName, value: string): void {
    this.owned.add(name);
    this.secrets.set(name, value);
    this.write(name, { op: "persist", value });
  }

  delete(name: SecretName): void {
    this.owned.add(name);
    this.secrets.clear(name);
    this.write(name, { op: "delete" });
  }

  /** May the shell's `secrets.set` / `secrets.clear` change this name? */
  accepts(name: SecretName): boolean {
    return !this.owned.has(name);
  }

  isPending(name: SecretName): boolean {
    return this.pending.has(name);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** Every pending write reached the shell (tests). */
  onSettled(fn: () => void): () => void {
    this.settledListeners.add(fn);
    return () => this.settledListeners.delete(fn);
  }

  /** The shell connected: send whatever it hasn't acknowledged. */
  flush(): Promise<void> {
    return Promise.all([...this.pending.keys()].map((n) => this.send(n))).then(() => undefined);
  }

  private write(name: SecretName, p: Pending): void {
    this.pending.set(name, p);
    void this.send(name);
  }

  private async send(name: SecretName): Promise<void> {
    const p = this.pending.get(name);
    const shell = this.shell();
    if (!p || !shell) return;
    try {
      if (p.op === "persist") await shell.request("secrets.persist", { name, value: p.value });
      else await shell.request("secrets.delete", { name });
    } catch (e) {
      // Kept pending: retried when the shell reconnects.
      log.warn("shell didn't store a secret", { name, op: p.op, error: (e as Error).message });
      return;
    }
    // A newer write while this one was in flight stays pending.
    if (this.pending.get(name) === p) this.pending.delete(name);
    if (this.pending.size === 0) for (const fn of this.settledListeners) fn();
  }
}
