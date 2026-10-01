import { Store } from "@homerun/app-state";

/** Asks for Face ID (or the passcode); resolves whether it passed. */
export type Authenticate = (reason: string) => Promise<boolean>;

export interface LockStorage {
  kvGet(name: string): Promise<string | null>;
  kvSet(name: string, value: string | null): Promise<void>;
}

const KEY = "lock-on-open";

/** Away this long, the app locks again; a glance at another app doesn't. */
export const RELOCK_AFTER_MS = 60_000;

/**
 * The optional Face ID lock on open (§9.8). Off by default. On, the app hides everything until
 * Face ID passes: at launch, and after it was in the background for a minute. This guards the
 * screen only; the history at rest is protected by the cache's key and the Complete
 * data-protection class, and destructive approvals by the approval key, whatever this says.
 */
export class AppLock {
  readonly enabled = new Store(false);
  readonly locked = new Store(true);
  private leftAt: number | null = null;

  constructor(
    private readonly storage: LockStorage,
    private readonly authenticate: Authenticate,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reads the setting at launch: locked if it is on. */
  async load(): Promise<void> {
    const on = (await this.storage.kvGet(KEY).catch(() => null)) === "1";
    this.enabled.set(on);
    this.locked.set(on);
  }

  /** Turning it on or off takes Face ID, so someone holding an unlocked phone can't quietly turn it off. */
  async setEnabled(on: boolean): Promise<boolean> {
    if (on === this.enabled.get()) return true;
    if (!(await this.authenticate(on ? "Lock Homerun with Face ID" : "Turn off the Face ID lock"))) return false;
    await this.storage.kvSet(KEY, on ? "1" : null);
    this.enabled.set(on);
    return true;
  }

  async unlock(): Promise<boolean> {
    if (!this.locked.get()) return true;
    const ok = await this.authenticate("Unlock Homerun");
    if (ok) this.locked.set(false);
    return ok;
  }

  background(): void {
    this.leftAt ??= this.now();
  }

  foreground(): void {
    const left = this.leftAt;
    this.leftAt = null;
    if (this.enabled.get() && left !== null && this.now() - left >= RELOCK_AFTER_MS) this.locked.set(true);
  }
}
