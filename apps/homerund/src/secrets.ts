import type { SecretName } from "@homerun/core";
import { forgetSecret, registerSecret } from "./log";

/**
 * Secrets handed over by the shell with `secrets.set` (§5.2). Memory only: never written to disk
 * or logs, and passed only into `claude`'s environment.
 */
export class SecretStore {
  private values = new Map<SecretName, string>();
  private listeners = new Set<(name: SecretName) => void>();

  set(name: SecretName, value: string): void {
    const old = this.values.get(name);
    if (old !== undefined && old !== value) forgetSecret(old);
    this.values.set(name, value);
    registerSecret(value);
    for (const l of this.listeners) l(name);
  }

  clear(name: SecretName): void {
    const old = this.values.get(name);
    if (old !== undefined) forgetSecret(old);
    this.values.delete(name);
    for (const l of this.listeners) l(name);
  }

  get(name: SecretName): string | undefined {
    return this.values.get(name);
  }

  has(name: SecretName): boolean {
    return this.values.has(name);
  }

  onChange(fn: (name: SecretName) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
