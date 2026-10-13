import {
  VERDICT_OK,
  VERSION_POLICY_MAX_BYTES,
  evaluateVersionPolicy,
  isPolicyCurrent,
  type VersionGateStatus,
  type VersionPolicy,
  type VersionVerdict,
} from "@homerun/core";
import { verifySignedVersionPolicy, type VersionPolicyKeys } from "@homerun/protocol";
import { log } from "../log";
import type { Clock } from "../schedule/clock";
import { getSetting, putSetting } from "../store/schedule-rows";
import type { Store } from "../store/store";

/**
 * The minimum-version gate and kill switch (§11 "Updates and control").
 *
 * The runtime fetches the signed version policy from the relay's public endpoint at start and
 * every hour, keeps the newest valid one in `app_settings`, and evaluates it lazily against the
 * current time and its own version, so an expired policy or an update clears the gate without a
 * fetch. It fails open: offline, a bad signature, an unknown key or an expired policy all mean
 * "ok". It can only restrict: the fire scheduler and the run pool ask `verdict()` before starting
 * unattended work, and the run manager before starting chat; nothing here enables, runs or deletes.
 *
 * Replay: a policy issued before the cached one is refused, so a relay or CDN replaying an old
 * policy can't lift a newer kill; the policy's expiry (at most 90 days) bounds the rest.
 */

export const POLICY_SETTING = "version_policy";
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface Cached {
  /** The signed envelope exactly as fetched, re-verified on load so a retired key stops counting. */
  signed: unknown;
  fetched_at: number;
}

export interface VersionGateOptions {
  store: Store;
  clock: Clock;
  /** The policy URL (the relay's `/v1/version-policy`); null when this build has no relay. */
  url: string | null;
  keys: VersionPolicyKeys;
  version: string;
  platform: string;
  channel: string;
  fetch?: typeof fetch;
  /** The gate changed: broadcast `version.changed` and wake the schedulers. */
  onChange?: (status: VersionGateStatus) => void;
  intervalMs?: number;
}

/** The gate as the schedulers and the run manager see it. */
export interface Gate {
  verdict(now?: number): VersionVerdict;
}

/** No policy: everything allowed. */
export const OPEN_GATE: Gate = { verdict: () => VERDICT_OK };

export class VersionGate implements Gate {
  private policy: VersionPolicy | null = null;
  private fetchedAt: number | null = null;
  private source: "relay" | "cache" = "cache";
  private checkedAt: number | null = null;
  private lastError: string | null = null;
  private last: string;
  private cancel: (() => void) | null = null;
  private inflight: Promise<VersionGateStatus> | null = null;
  private stopped = false;

  constructor(private o: VersionGateOptions) {
    this.load();
    this.last = JSON.stringify(this.verdict());
  }

  /** What the policy means for this runtime right now. Fails open. */
  verdict(now = this.o.clock.now()): VersionVerdict {
    try {
      return evaluateVersionPolicy(this.policy, { platform: this.o.platform, channel: this.o.channel, version: this.o.version, now });
    } catch (e) {
      log.warn("version policy evaluation failed; failing open", { error: e instanceof Error ? e.message : String(e) });
      return VERDICT_OK;
    }
  }

  status(now = this.o.clock.now()): VersionGateStatus {
    const p = this.policy && isPolicyCurrent(this.policy, now) ? this.policy : null;
    return {
      verdict: this.verdict(now),
      policy: p ? { issued_at: p.issued_at, expires_at: p.expires_at, fetched_at: this.fetchedAt ?? now, source: this.source } : null,
      checked_at: this.checkedAt,
      last_error: this.lastError,
      version: this.o.version,
      platform: this.o.platform,
      channel: this.o.channel,
    };
  }

  /** The policy in effect (verified, possibly expired), for the diagnostic bundle. */
  currentPolicy(): VersionPolicy | null {
    return this.policy;
  }

  start(): void {
    void this.check();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  private arm(): void {
    if (this.stopped) return;
    this.cancel = this.o.clock.setTimer(this.o.intervalMs ?? CHECK_INTERVAL_MS, () => {
      this.cancel = null;
      void this.check().finally(() => this.arm());
    });
  }

  /** Fetch the policy now. Never rejects: a failure leaves the cached policy in effect. */
  check(): Promise<VersionGateStatus> {
    return (this.inflight ??= this.fetchOnce()
      .catch((e) => {
        this.lastError = `failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
        return this.changed();
      })
      .finally(() => (this.inflight = null)));
  }

  /** Re-evaluate without fetching (the hourly tick also catches an expiry this way). */
  reevaluate(): VersionGateStatus {
    return this.changed();
  }

  private async fetchOnce(): Promise<VersionGateStatus> {
    const now = this.o.clock.now();
    this.checkedAt = now;
    if (!this.o.url || Object.keys(this.o.keys).length === 0) {
      // Nothing to fetch from, or nothing could verify what came back.
      this.lastError = this.o.url ? "no version policy key in this build" : "no relay in this build";
      return this.changed();
    }
    let raw: unknown;
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (res.status === 404) {
        // None published. Keep the cached one: a relay that loses its config mustn't lift a kill early.
        this.lastError = null;
        return this.changed();
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > VERSION_POLICY_MAX_BYTES * 2) throw new Error("too large");
      raw = JSON.parse(text);
    } catch (e) {
      this.lastError = `offline: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      log.info("version policy check failed; keeping the cached policy", { error: this.lastError });
      return this.changed();
    }
    if (this.stopped) return this.status();
    const policy = verifySignedVersionPolicy(raw, this.o.keys);
    if (!policy) {
      this.lastError = "invalid: the policy's signature or format didn't verify";
      log.warn("version policy rejected", { reason: this.lastError });
      return this.changed();
    }
    if (!isPolicyCurrent(policy, now)) {
      // Expired, or issued in the future: adopting the latter would make every later policy "stale".
      this.lastError = policy.expires_at <= now ? "expired: the published policy has expired" : "invalid: issued in the future";
      log.warn("version policy rejected", { reason: this.lastError });
      return this.changed();
    }
    if (this.policy && policy.issued_at < this.policy.issued_at) {
      this.lastError = "stale: issued before the cached policy";
      log.warn("version policy rejected", { reason: this.lastError, issued_at: policy.issued_at, cached: this.policy.issued_at });
      return this.changed();
    }
    this.policy = policy;
    this.fetchedAt = now;
    this.source = "relay";
    this.lastError = null;
    putSetting(this.o.store, POLICY_SETTING, { signed: raw, fetched_at: now } satisfies Cached);
    return this.changed();
  }

  /** Report when what the gate means changed (a new policy, an expiry, a rule now matching). */
  private changed(): VersionGateStatus {
    const s = this.status();
    const k = JSON.stringify(s.verdict);
    if (k !== this.last) {
      this.last = k;
      log.info("version gate changed", { state: s.verdict.state, reason: s.verdict.reason });
      try {
        this.o.onChange?.(s);
      } catch (e) {
        log.error("version.changed handler failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return s;
  }

  private load(): void {
    try {
      const c = getSetting<Cached>(this.o.store, POLICY_SETTING);
      if (!c) return;
      const p = verifySignedVersionPolicy(c.signed, this.o.keys);
      if (!p) return;
      this.policy = p;
      this.fetchedAt = c.fetched_at;
      this.source = "cache";
    } catch (e) {
      log.warn("cached version policy unreadable; ignoring it", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/** Raised when the gate refuses interactive work (a kill with `kill_interactive`). */
export class VersionBlockedError extends Error {
  constructor(readonly verdict: VersionVerdict) {
    super(verdict.message ?? "This version of Homerun has been stopped. Update Homerun to keep using it.");
    this.name = "VersionBlockedError";
  }
}
