import { bad, badRule, edit, ok, type Vector } from "./types";
import * as F from "./fixtures";

const DAY = 86_400_000;

export const versionRule = (over: Record<string, unknown> = {}) => ({
  platform: "macos",
  channel: "stable",
  min_version: "0.3.0",
  ...over,
});

export const versionPolicy = (over: Record<string, unknown> = {}) => ({
  v: 1,
  issued_at: F.T0,
  expires_at: F.T0 + 30 * DAY,
  rules: [versionRule()],
  ...over,
});

export const verdictOk = { state: "ok", reason: null, unattended_allowed: true, interactive_allowed: true, min_version: null, message: null, url: null };

export const gateStatus = (over: Record<string, unknown> = {}) => ({
  verdict: verdictOk,
  policy: { issued_at: F.T0, expires_at: F.T0 + 30 * DAY, fetched_at: F.T0 + 60_000, source: "relay" },
  checked_at: F.T0 + 60_000,
  last_error: null,
  version: "0.3.1",
  platform: "macos",
  channel: "stable",
  ...over,
});

const killed = {
  state: "killed",
  reason: "killed",
  unattended_allowed: false,
  interactive_allowed: true,
  min_version: null,
  message: "A bug in 0.3.1 can repeat scheduled runs. Update to 0.3.2.",
  url: "https://homerun.example/status/2026-01",
};

export const versionPolicyVectors: Vector[] = [
  ok("SemVer", "release", "0.3.1"),
  ok("SemVer", "pre-release and build", "1.0.0-beta.2+exp.sha.5114f85"),
  bad("SemVer", "two parts", "0.3"),
  bad("SemVer", "leading zero", "0.03.1"),
  bad("SemVer", "v prefix", "v0.3.1"),
  ok("VersionRange", "exact", "0.3.1"),
  ok("VersionRange", "half-open interval", ">=0.3.1 <0.3.4"),
  ok("VersionRange", "everything", "*"),
  badRule("VersionRange", "caret", "^0.3.1"),
  badRule("VersionRange", "or", "0.3.1 || 0.3.2"),
  bad("VersionRange", "empty", ""),
  ok("VersionRule", "minimum only", versionRule()),
  ok("VersionRule", "kill with chat", versionRule({ channel: "*", kill: [">=0.3.1 <0.3.2"], kill_interactive: true, message: "Stop.", url: "https://homerun.example/status" })),
  ok("VersionRule", "a platform this client doesn't know", versionRule({ platform: "linux" })),
  bad("VersionRule", "http url", versionRule({ url: "http://homerun.example/status" })),
  bad("VersionRule", "uppercase platform", versionRule({ platform: "macOS" })),
  bad("VersionRule", "every platform", versionRule({ platform: "*" })),
  badRule("VersionRule", "bad blocked range", versionRule({ blocked_versions: ["~0.3"] })),
  ok("VersionPolicy", "one rule", versionPolicy()),
  ok("VersionPolicy", "every platform", versionPolicy({
    rules: [
      versionRule(),
      versionRule({ platform: "windows", blocked_versions: ["0.3.1"] }),
      versionRule({ platform: "ios", channel: "*", min_version: "0.2.0" }),
      versionRule({ platform: "web", kill: ["<0.2.0"], message: "Reload the page." }),
    ],
  })),
  ok("VersionPolicy", "no rules", versionPolicy({ rules: [] })),
  bad("VersionPolicy", "format 2", versionPolicy({ v: 2 })),
  bad("VersionPolicy", "no expiry", edit(versionPolicy(), (p) => delete p.expires_at)),
  badRule("VersionPolicy", "expires before issued", versionPolicy({ expires_at: F.T0 - 1 })),
  badRule("VersionPolicy", "valid for a year", versionPolicy({ expires_at: F.T0 + 365 * DAY })),
  ok("VersionVerdict", "ok", verdictOk),
  ok("VersionVerdict", "killed", killed),
  ok("VersionVerdict", "below the minimum", { ...verdictOk, state: "update_required", reason: "below_minimum", unattended_allowed: false, min_version: "0.3.0" }),
  bad("VersionVerdict", "unknown state", { ...verdictOk, state: "paused" }),
  ok("VersionGateStatus", "current policy", gateStatus()),
  ok("VersionGateStatus", "never fetched, offline", gateStatus({ policy: null, checked_at: F.T0, last_error: "offline" })),
  ok("VersionGateStatus", "killed from the cache", gateStatus({ verdict: killed, policy: { issued_at: F.T0, expires_at: F.T0 + DAY, fetched_at: F.T0, source: "cache" } })),
  bad("VersionGateStatus", "unknown source", gateStatus({ policy: { issued_at: F.T0, expires_at: F.T0 + DAY, fetched_at: F.T0, source: "cdn" } })),
  ok("VersionBlockedData", "killed", { reason: "killed", url: null }),
  bad("VersionBlockedData", "no reason", { url: null }),
  ok("CrashReportSettings", "off", { available: true, enabled: false }),
  badRule("CrashReportSettings", "on without an endpoint", { available: false, enabled: true }),
  ok("DiagnosticFile", "nested", { name: "logs/homerund.log", bytes: 0, description: "Runtime and shell log, redacted" }),
  bad("DiagnosticFile", "parent directory", { name: "../secrets.json", bytes: 0, description: "x" }),
];
