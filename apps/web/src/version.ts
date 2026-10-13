import { Store } from "@homerun/app-state";
import { VERDICT_OK, type VersionVerdict } from "@homerun/core";
import { checkVersionPolicy, type ClientVersionTarget } from "@homerun/remote";
import type { WebConfig } from "./config";
import type { Kv } from "./storage";

/** How often an open tab checks the policy again. */
export const VERSION_CHECK_INTERVAL_MS = 60 * 60_000;
const CACHE_KEY = "version_policy";

/**
 * The web client's own minimum-version gate (§11): the signed policy's "web" rules, checked at
 * load and hourly. It only shows "Update Homerun"; the Mac's runtime enforces its own gate, which
 * the desktop's views show as well. The last verified policy is kept in the "state" area, so it
 * still applies offline; any failure keeps it and otherwise fails open.
 */
export class WebVersionGate {
  readonly verdict = new Store<VersionVerdict>(VERDICT_OK);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly kv: Kv,
    private readonly target: ClientVersionTarget,
  ) {}

  static forConfig(kv: Kv, config: WebConfig, o: Partial<ClientVersionTarget> = {}): WebVersionGate {
    return new WebVersionGate(kv, { relayUrl: config.relayUrl, platform: "web", channel: config.dev ? "development" : "stable", version: config.version, ...o });
  }

  async check(): Promise<VersionVerdict> {
    const cached = await this.kv.get<unknown>("state", CACHE_KEY).catch(() => undefined);
    const c = await checkVersionPolicy(this.target, cached ?? null);
    if (c.keep !== (cached ?? null)) await (c.keep ? this.kv.put("state", CACHE_KEY, c.keep) : this.kv.delete("state", CACHE_KEY)).catch(() => {});
    this.verdict.set(c.verdict);
    return c.verdict;
  }

  start(intervalMs = VERSION_CHECK_INTERVAL_MS): void {
    void this.check();
    this.timer ??= setInterval(() => void this.check(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
