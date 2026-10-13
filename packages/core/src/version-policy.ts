import { z } from "zod";
import { named } from "./registry";
import { TimestampMs } from "./common";

/**
 * The minimum-version gate and remote kill switch (§11 "Updates and control").
 *
 * The policy is a small JSON document, signed offline with an Ed25519 key whose public half is
 * compiled into every client (`@homerun/protocol` `verifySignedVersionPolicy`), and served by the
 * relay at a public, cacheable URL. It can only restrict: a runtime that matches a rule stops
 * starting unattended runs and shows a banner; it never enables, runs or deletes anything.
 * Clients fail open: no policy, an invalid one, or an expired one means "ok", so offline users
 * keep working.
 *
 * Forward compatibility: unknown fields are ignored, and `platform` and `channel` are open
 * strings, so a policy naming a platform this client doesn't know still parses and still applies
 * the rules that do match. A new `v` is a new format: older clients fail open on it.
 */

export const VERSION_POLICY_FORMAT = 1 as const;
/** The longest a policy may stay valid: bounds how long a captured policy can be replayed. */
export const VERSION_POLICY_MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** A policy issued this far in the future is still accepted (clock skew), but no further. */
export const VERSION_POLICY_MAX_SKEW_MS = 24 * 60 * 60 * 1000;
/** The serialized body's limit, so a hostile relay can't make clients parse megabytes. */
export const VERSION_POLICY_MAX_BYTES = 64 * 1024;

/** The platforms Homerun ships on. Policies may name others; a client matches only its own. */
export const PolicyPlatform = named("PolicyPlatform", z.enum(["macos", "windows", "ios", "web"]));
export type PolicyPlatform = z.infer<typeof PolicyPlatform>;

/** Release channels. `development` builds evaluate as their own channel, so a stable rule never stops a dev build. */
export const PolicyChannel = named("PolicyChannel", z.enum(["stable", "beta", "development"]));
export type PolicyChannel = z.infer<typeof PolicyChannel>;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(.+)$/;

export const SemVer = named("SemVer", z.string().max(64).regex(SEMVER), "MAJOR.MINOR.PATCH with an optional pre-release and build (semver.org)");

/** True for a well-formed range: "*", or space-separated comparators that must all hold ("0.3.1", ">=0.3.1 <0.3.4"). */
export function isVersionRange(s: string): boolean {
  if (s === "*") return true;
  const parts = s.trim().split(/\s+/);
  if (!parts.length || parts.length > 4) return false;
  return parts.every((p) => {
    const m = COMPARATOR.exec(p);
    return m !== null && SEMVER.test(m[2]!);
  });
}

export const VersionRange = named(
  "VersionRange",
  z.string().min(1).max(100).refine(isVersionRange, "a version range: *, or comparators such as >=0.3.1 <0.3.4"),
  'A version, or comparators that must all hold: "0.3.1", ">=0.3.1 <0.3.4", "<0.3.0", "*"',
);

const Tag = (max: number) => z.string().regex(/^(\*|[a-z][a-z0-9_-]*)$/).max(max);
/** No `*`: versions are numbered per platform, so a rule always names the one it means. */
const PlatformTag = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(32);

export const VersionRule = named(
  "VersionRule",
  z.object({
    /** A PolicyPlatform, or one this client doesn't know (ignored by it). Never `*`: versions are per platform. */
    platform: PlatformTag,
    /** A PolicyChannel, `*` for every channel, or one this client doesn't know. */
    channel: Tag(32),
    /** Versions below this must update: unattended work stops until they do. */
    min_version: SemVer.optional(),
    /** Known-bad versions, as ranges: like `min_version`, but for a version in the middle. */
    blocked_versions: z.array(VersionRange).max(50).optional(),
    /** The kill switch: matching versions stop unattended work even when no update exists yet. */
    kill: z.array(VersionRange).max(50).optional(),
    /** With `kill`: interactive chat stops too. Off unless set; a kill otherwise leaves chat working. */
    kill_interactive: z.boolean().optional(),
    /** Shown in the banner. Plain text. */
    message: z.string().min(1).max(500).optional(),
    /** "Learn more"; https only. */
    url: z.string().url().max(2048).startsWith("https://").optional(),
  }),
);
export type VersionRule = z.infer<typeof VersionRule>;

export const VersionPolicy = named(
  "VersionPolicy",
  z
    .object({
      v: z.literal(VERSION_POLICY_FORMAT),
      issued_at: TimestampMs,
      expires_at: TimestampMs,
      rules: z.array(VersionRule).max(100),
    })
    .refine((p) => p.expires_at > p.issued_at, "expires_at must be after issued_at")
    .refine((p) => p.expires_at - p.issued_at <= VERSION_POLICY_MAX_LIFETIME_MS, "a policy may be valid for at most 90 days"),
  "The minimum-version and kill-switch policy (§11). Carried signed in a SignedVersionPolicy.",
);
export type VersionPolicy = z.infer<typeof VersionPolicy>;

export const VersionGateReason = named("VersionGateReason", z.enum(["below_minimum", "blocked_version", "killed"]));
export type VersionGateReason = z.infer<typeof VersionGateReason>;

/** What the policy means for this build. `ok` whenever there is no valid, current policy (fail open). */
export const VersionVerdict = named(
  "VersionVerdict",
  z.object({
    state: z.enum(["ok", "update_required", "killed"]),
    reason: VersionGateReason.nullable(),
    /** Scheduled and monitor runs may start. */
    unattended_allowed: z.boolean(),
    /** Chat and Run now may start. False only for a kill with `kill_interactive`. */
    interactive_allowed: z.boolean(),
    min_version: SemVer.nullable(),
    message: z.string().max(500).nullable(),
    url: z.string().max(2048).nullable(),
  }),
);
export type VersionVerdict = z.infer<typeof VersionVerdict>;

/** The runtime's view of the gate, for the banner, the CLI and the diagnostic bundle. */
export const VersionGateStatus = named(
  "VersionGateStatus",
  z.object({
    verdict: VersionVerdict,
    /** The policy in effect, or null when there is none (never fetched, or expired). */
    policy: z
      .object({
        issued_at: TimestampMs,
        expires_at: TimestampMs,
        fetched_at: TimestampMs,
        source: z.enum(["relay", "cache"]),
      })
      .nullable(),
    /** When the runtime last tried to fetch it; null before the first try. */
    checked_at: TimestampMs.nullable(),
    /** Why the last fetch didn't produce a new policy, e.g. "offline"; null after a success. */
    last_error: z.string().max(500).nullable(),
    version: z.string().min(1).max(100),
    platform: z.string().max(32),
    channel: z.string().max(32),
  }),
);
export type VersionGateStatus = z.infer<typeof VersionGateStatus>;

export const VERDICT_OK: VersionVerdict = {
  state: "ok",
  reason: null,
  unattended_allowed: true,
  interactive_allowed: true,
  min_version: null,
  message: null,
  url: null,
};

// ---------------------------------------------------------------- semver

type Parsed = { core: [number, number, number]; pre: string[] };

function parse(v: string): Parsed | null {
  const m = SEMVER.exec(v);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver precedence (semver.org §11): -1, 0 or 1. Build metadata is ignored. Throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** Whether `version` satisfies `range` (see `VersionRange`). False for a malformed version or range. */
export function matchesRange(version: string, range: string): boolean {
  if (!parse(version) || !isVersionRange(range)) return false;
  if (range === "*") return true;
  return range
    .trim()
    .split(/\s+/)
    .every((part) => {
      const [, op = "=", v] = COMPARATOR.exec(part)!;
      const c = compareVersions(version, v!);
      switch (op) {
        case ">=":
          return c >= 0;
        case "<=":
          return c <= 0;
        case ">":
          return c > 0;
        case "<":
          return c < 0;
        default:
          return c === 0;
      }
    });
}

// ---------------------------------------------------------------- evaluation

export interface VersionTarget {
  platform: string;
  channel: string;
  version: string;
  now: number;
}

/** Whether `policy` is current at `now`: not expired, and not issued implausibly far in the future. */
export function isPolicyCurrent(policy: VersionPolicy, now: number): boolean {
  return now < policy.expires_at && policy.issued_at <= now + VERSION_POLICY_MAX_SKEW_MS;
}

const SEVERITY = { below_minimum: 1, blocked_version: 2, killed: 3 } as const;

/**
 * What `policy` means for this build. Fails open: no policy, an expired one, or a version this
 * code can't parse is `ok`. Of the rules for this platform and channel, the most severe wins:
 * killed, then a blocked version, then below the minimum.
 */
export function evaluateVersionPolicy(policy: VersionPolicy | null, t: VersionTarget): VersionVerdict {
  if (!policy || !isPolicyCurrent(policy, t.now) || !parse(t.version)) return VERDICT_OK;
  let worst: { reason: VersionGateReason; rule: VersionRule } | null = null;
  for (const rule of policy.rules) {
    if (rule.platform !== t.platform || (rule.channel !== "*" && rule.channel !== t.channel)) continue;
    let reason: VersionGateReason | null = null;
    if (rule.kill?.some((r) => matchesRange(t.version, r))) reason = "killed";
    else if (rule.blocked_versions?.some((r) => matchesRange(t.version, r))) reason = "blocked_version";
    else if (rule.min_version && compareVersions(t.version, rule.min_version) < 0) reason = "below_minimum";
    if (reason && (!worst || SEVERITY[reason] > SEVERITY[worst.reason])) worst = { reason, rule };
  }
  if (!worst) return VERDICT_OK;
  const killed = worst.reason === "killed";
  return {
    state: killed ? "killed" : "update_required",
    reason: worst.reason,
    unattended_allowed: false,
    interactive_allowed: !(killed && worst.rule.kill_interactive === true),
    min_version: worst.rule.min_version ?? null,
    message: worst.rule.message ?? null,
    url: worst.rule.url ?? null,
  };
}

/** The banner's sentence when the policy gives none. */
export function verdictMessage(v: VersionVerdict): string {
  if (v.message) return v.message;
  switch (v.reason) {
    case "killed":
      return "Homerun has paused scheduled tasks and monitors on this version. Update Homerun to resume them.";
    case "blocked_version":
      return "This version of Homerun has a known problem. Update Homerun to resume scheduled tasks and monitors.";
    case "below_minimum":
      return `This version of Homerun is no longer supported${v.min_version ? ` (${v.min_version} or later is required)` : ""}. Update Homerun to resume scheduled tasks and monitors.`;
    default:
      return "";
  }
}
