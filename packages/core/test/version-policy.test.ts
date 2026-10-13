import { describe, expect, test } from "bun:test";
import {
  VERDICT_OK,
  VERSION_POLICY_MAX_SKEW_MS,
  VersionPolicy,
  compareVersions,
  evaluateVersionPolicy,
  isVersionRange,
  matchesRange,
  verdictMessage,
  type VersionRule,
} from "../src/index";

const T0 = 1_767_225_600_000;
const DAY = 86_400_000;
const policy = (rules: VersionRule[], over: Partial<VersionPolicy> = {}): VersionPolicy =>
  VersionPolicy.parse({ v: 1, issued_at: T0, expires_at: T0 + 7 * DAY, rules, ...over });
const at = (version: string, over: Partial<{ platform: string; channel: string; now: number }> = {}) => ({
  platform: "macos",
  channel: "stable",
  version,
  now: T0 + 1000,
  ...over,
});

describe("semver", () => {
  test("precedence follows semver.org", () => {
    const order = ["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0"];
    for (let i = 0; i + 1 < order.length; i++) {
      expect(compareVersions(order[i]!, order[i + 1]!)).toBe(-1);
      expect(compareVersions(order[i + 1]!, order[i]!)).toBe(1);
    }
    expect(compareVersions("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(() => compareVersions("1.0", "1.0.0")).toThrow();
  });

  test("ranges", () => {
    expect(matchesRange("0.3.2", ">=0.3.1 <0.3.4")).toBe(true);
    expect(matchesRange("0.3.4", ">=0.3.1 <0.3.4")).toBe(false);
    expect(matchesRange("0.3.1", "0.3.1")).toBe(true);
    expect(matchesRange("0.3.1", "=0.3.1")).toBe(true);
    expect(matchesRange("0.3.1-dev", "<0.3.1")).toBe(true);
    expect(matchesRange("9.9.9", "*")).toBe(true);
    expect(matchesRange("garbage", "*")).toBe(false);
    expect(isVersionRange("^1.0.0")).toBe(false);
    expect(isVersionRange("1.0.0 || 2.0.0")).toBe(false);
  });
});

describe("evaluateVersionPolicy", () => {
  test("fails open with no policy, an expired one, one from the far future, or an unparseable version", () => {
    const p = policy([{ platform: "macos", channel: "*", kill: ["*"] }]);
    expect(evaluateVersionPolicy(null, at("0.3.1"))).toEqual(VERDICT_OK);
    expect(evaluateVersionPolicy(p, at("0.3.1", { now: T0 + 7 * DAY }))).toEqual(VERDICT_OK);
    expect(evaluateVersionPolicy(p, at("0.3.1", { now: T0 - VERSION_POLICY_MAX_SKEW_MS - 1 }))).toEqual(VERDICT_OK);
    expect(evaluateVersionPolicy(p, at("0.3.1", { now: T0 - VERSION_POLICY_MAX_SKEW_MS + 1 })).state).toBe("killed");
    expect(evaluateVersionPolicy(p, at("not-a-version"))).toEqual(VERDICT_OK);
  });

  test("below the minimum stops unattended work only", () => {
    const v = evaluateVersionPolicy(policy([{ platform: "macos", channel: "stable", min_version: "0.4.0" }]), at("0.3.9"));
    expect(v).toMatchObject({ state: "update_required", reason: "below_minimum", unattended_allowed: false, interactive_allowed: true, min_version: "0.4.0" });
    expect(verdictMessage(v)).toContain("0.4.0 or later");
    expect(evaluateVersionPolicy(policy([{ platform: "macos", channel: "stable", min_version: "0.4.0" }]), at("0.4.0"))).toEqual(VERDICT_OK);
  });

  test("matches only this platform and channel; * matches every channel", () => {
    const p = policy([
      { platform: "windows", channel: "*", min_version: "9.0.0" },
      { platform: "macos", channel: "beta", min_version: "9.0.0" },
      { platform: "linux", channel: "*", kill: ["*"] },
    ]);
    expect(evaluateVersionPolicy(p, at("0.3.1"))).toEqual(VERDICT_OK);
    expect(evaluateVersionPolicy(p, at("0.3.1", { channel: "beta" })).reason).toBe("below_minimum");
    expect(evaluateVersionPolicy(p, at("0.3.1", { platform: "windows", channel: "development" })).reason).toBe("below_minimum");
  });

  test("the most severe rule wins, and kill_interactive comes from the killing rule", () => {
    const p = policy([
      { platform: "macos", channel: "*", min_version: "1.0.0", message: "old" },
      { platform: "macos", channel: "*", blocked_versions: ["0.3.1"], message: "blocked" },
      { platform: "macos", channel: "stable", kill: [">=0.3.0 <0.3.2"], kill_interactive: true, message: "killed", url: "https://homerun.example/s" },
    ]);
    const v = evaluateVersionPolicy(p, at("0.3.1"));
    expect(v).toEqual({ state: "killed", reason: "killed", unattended_allowed: false, interactive_allowed: false, min_version: null, message: "killed", url: "https://homerun.example/s" });
    expect(evaluateVersionPolicy(p, at("0.3.5")).message).toBe("old");
    const noChat = policy([{ platform: "macos", channel: "*", kill: ["*"] }]);
    expect(evaluateVersionPolicy(noChat, at("0.3.1")).interactive_allowed).toBe(true);
  });

  test("restrict-only: no rule shape grants anything beyond ok", () => {
    // Whatever the rules say, the verdict only ever turns things off.
    const p = policy([{ platform: "macos", channel: "*", min_version: "0.0.0", blocked_versions: [], kill: [] }]);
    expect(evaluateVersionPolicy(p, at("0.3.1"))).toEqual(VERDICT_OK);
    for (const v of [evaluateVersionPolicy(policy([{ platform: "macos", channel: "*", kill: ["*"] }]), at("0.1.0"))]) {
      expect(v.unattended_allowed).toBe(false);
    }
  });

  test("ignores unknown fields (forward compatible)", () => {
    const p = VersionPolicy.parse({ v: 1, issued_at: T0, expires_at: T0 + DAY, rules: [{ platform: "macos", channel: "*", min_version: "1.0.0", future: true }], extra: 1 });
    expect(evaluateVersionPolicy(p, at("0.1.0")).reason).toBe("below_minimum");
  });
});
