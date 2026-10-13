import { Store } from "@homerun/app-state";
import { VERDICT_OK, type VersionVerdict } from "@homerun/core";
import { checkVersionPolicy, type ClientVersionTarget } from "@homerun/remote";
import type { IosConfig } from "./config";

/** At most this often, on launch and coming to the foreground. */
export const VERSION_CHECK_INTERVAL_MS = 60 * 60_000;
const KV_NAME = "version_policy";

/** Where the last verified policy is kept between launches: the native kv records. */
export interface PolicyKv {
  kvGet(name: string): Promise<string | null>;
  kvSet(name: string, value: string | null): Promise<void>;
}

/**
 * The iPhone app's own minimum-version gate (§11): the signed policy's "ios" rules. It only shows
 * "Update Homerun"; the Mac's runtime enforces its own gate. The last verified policy is kept, so
 * it still applies offline; any failure keeps it and otherwise fails open.
 */
export class IosVersionGate {
  readonly verdict = new Store<VersionVerdict>(VERDICT_OK);
  private last = -Infinity;

  constructor(
    private readonly kv: PolicyKv,
    private readonly target: ClientVersionTarget,
  ) {}

  static forConfig(kv: PolicyKv, config: IosConfig, o: Partial<ClientVersionTarget> = {}): IosVersionGate {
    return new IosVersionGate(kv, { relayUrl: config.relayUrl, platform: "ios", channel: config.dev ? "development" : "stable", version: config.version, ...o });
  }

  async check(): Promise<VersionVerdict> {
    this.last = (this.target.now ?? Date.now)();
    const raw = await this.kv.kvGet(KV_NAME).catch(() => null);
    let cached: unknown = null;
    try {
      cached = raw ? JSON.parse(raw) : null;
    } catch {
      cached = null;
    }
    const c = await checkVersionPolicy(this.target, cached);
    const keep = c.keep ? JSON.stringify(c.keep) : null;
    if (keep !== raw) await this.kv.kvSet(KV_NAME, keep).catch(() => {});
    this.verdict.set(c.verdict);
    return c.verdict;
  }

  /** On launch and on each return to the foreground; checks only if the last check is old enough. */
  maybeCheck(): void {
    if ((this.target.now ?? Date.now)() - this.last >= VERSION_CHECK_INTERVAL_MS) void this.check();
  }
}
