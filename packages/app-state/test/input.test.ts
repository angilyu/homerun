import { describe, expect, test } from "bun:test";
import type { ApprovalPrompt, QuestionPrompt } from "@homerun/core";
import {
  alreadyAnswered,
  approvalResponse,
  checkGrant,
  describeResolution,
  grantEditor,
  initialAnswers,
  initialGrant,
  offersAlways,
  questionResponse,
  setFreeform,
  toggleOption,
} from "../src/input";
import { DEVICE, OTHER_DEVICE, approvalPrompt, questionPrompt } from "./helpers";

const bash = approvalPrompt("t1") as unknown as ApprovalPrompt;

describe("Always allow (§5.6)", () => {
  test("the editor starts from the runtime's suggestion and shows what it covers", () => {
    expect(offersAlways(bash)).toBe(true);
    expect(grantEditor(bash)).toMatchObject({ pattern_editable: true, classes: ["read", "write", "network"] });
    const d = initialGrant(bash);
    expect(d).toEqual({ pattern: "npm test *", class: "read" });
    expect(checkGrant(bash, d)).toMatchObject({ covers: true, errors: [] });
  });

  test("an edited pattern that no longer covers the call is refused", () => {
    const c = checkGrant(bash, { pattern: "npm run lint", class: "read" });
    expect(c.covers).toBe(false);
    expect(c.errors[0]).toContain("doesn't cover");
    expect(approvalResponse(bash, "allow_always", { pattern: "npm run lint", class: "read" }).response).toBeNull();
  });

  test("shell metacharacters and a bare wildcard are refused", () => {
    expect(checkGrant(bash, { pattern: "npm test; rm -rf /", class: "read" }).proposal).toBeNull();
    expect(checkGrant(bash, { pattern: "*", class: "read" }).proposal).toBeNull();
    expect(checkGrant(bash, { pattern: "", class: "read" }).errors.join()).toContain("needs a command pattern");
  });

  test("allow_always carries the confirmed grant; allow and deny carry none", () => {
    expect(approvalResponse(bash, "allow").response).toEqual({ type: "approval", decision: "allow" });
    expect(approvalResponse(bash, "deny").response).toEqual({ type: "approval", decision: "deny" });
    expect(approvalResponse(bash, "allow_always", { pattern: "npm test *", class: "write" }).response).toEqual({
      type: "approval",
      decision: "allow_always",
      grant: { tool: "Bash", pattern: "npm test *", class: "write" },
    });
  });

  test("WebFetch grants are domains; third-party tools are trusted for every call", () => {
    const fetch = approvalPrompt("t2", {
      tool: "WebFetch",
      class: "network",
      input: { kind: "inline", value: { url: "https://docs.github.com/x?q=1" } },
      reason: "tainted_egress",
      suggested_grant: { tool: "WebFetch", pattern: "docs.github.com", class: "network" },
    }) as unknown as ApprovalPrompt;
    expect(grantEditor(fetch)).toMatchObject({ pattern_label: "Domain", classes: ["network"] });
    expect(checkGrant(fetch, { pattern: "*.github.com", class: "network" }).covers).toBe(true);
    expect(checkGrant(fetch, { pattern: "example.com", class: "network" }).covers).toBe(false);

    const mcp = approvalPrompt("t3", {
      tool: "mcp__github__create_issue",
      class: "destructive",
      input: { kind: "inline", value: { title: "x" } },
      reason: "untrusted_tool",
      suggested_grant: undefined,
    }) as unknown as ApprovalPrompt;
    expect(grantEditor(mcp).pattern_editable).toBe(false);
    expect(approvalResponse(mcp, "allow_always", initialGrant(mcp)).response).toMatchObject({ grant: { pattern: null, class: "read" } });
  });

  test("never offered for a known destructive call", () => {
    const rm = approvalPrompt("t4", { tool: "Write", class: "destructive", offer_always: true, reason: "destructive" }) as unknown as ApprovalPrompt;
    expect(offersAlways(rm)).toBe(false);
  });
});

describe("questions (§5.6)", () => {
  const q = questionPrompt("q1") as unknown as QuestionPrompt;

  test("single choice replaces, multiple choice toggles, freeform where allowed", () => {
    let d = initialAnswers(q);
    expect(questionResponse(q, d)).toBeNull();
    d = toggleOption(q, d, 0, "main");
    d = toggleOption(q, d, 0, "dev");
    expect(d.answers[0]!.selected).toEqual(["dev"]);
    expect(questionResponse(q, d)).toBeNull(); // second question unanswered
    d = toggleOption(q, d, 1, "lint");
    d = toggleOption(q, d, 1, "test");
    d = toggleOption(q, d, 1, "lint");
    expect(questionResponse(q, d)).toEqual({ type: "question", answers: [{ selected: ["dev"] }, { selected: ["test"] }] });
    d = setFreeform(d, 0, "  feature/x  ");
    expect(questionResponse(q, d)).toMatchObject({ answers: [{ selected: ["dev"], text: "feature/x" }, { selected: ["test"] }] });
  });

  test("freeform alone answers a question that allows it", () => {
    let d = setFreeform(initialAnswers(q), 0, "release branch");
    d = toggleOption(q, d, 1, "build");
    expect(questionResponse(q, d)).toMatchObject({ answers: [{ selected: [], text: "release branch" }, { selected: ["build"] }] });
    // Freeform on a question that doesn't allow it is ignored, so the answer is still missing.
    expect(questionResponse(q, setFreeform(setFreeform(initialAnswers(q), 0, "x"), 1, "y"))).toBeNull();
  });
});

describe("after the answer", () => {
  test("says who answered and where", () => {
    const r = { state: "answered" as const, response: { type: "approval" as const, decision: "allow" as const }, answered_by: DEVICE, surface: "desktop" as const, ts: 1 };
    expect(describeResolution(bash, r, DEVICE)).toBe("Allowed once on this Mac");
    expect(describeResolution(bash, { ...r, answered_by: OTHER_DEVICE, surface: "ios" }, DEVICE)).toBe("Allowed once on iPhone");
    expect(describeResolution(bash, { ...r, state: "expired", response: null, answered_by: null, surface: null }, DEVICE)).toBe("Expired without an answer");
    expect(alreadyAnswered("answered", OTHER_DEVICE, DEVICE)).toContain("another device");
  });
});
