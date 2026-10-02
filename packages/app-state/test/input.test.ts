import { describe, expect, test } from "bun:test";
import type { ApprovalPrompt, QuestionPrompt } from "@homerun/core";
import {
  ALL_WEB_FETCHES,
  ALL_WEB_FETCHES_WARNING,
  allWebFetchesResponse,
  alreadyAnswered,
  answerVerb,
  approvalResponse,
  cantAnswer,
  checkGrant,
  describeResolution,
  grantEditor,
  initialAnswers,
  initialGrant,
  offersAllWebFetches,
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

describe("Allow all web fetches for this task (§5.6)", () => {
  const all = { tool: "WebFetch", pattern: "*", class: "network" } as const;
  const fetch = approvalPrompt("t7", {
    tool: "WebFetch",
    class: "network",
    input: { kind: "inline", value: { url: "https://evil.test/x?q=1" } },
    url: "https://evil.test/x?q=1",
    reason: "tainted_egress",
    suggested_grant: { tool: "WebFetch", pattern: "evil.test", class: "network" },
    suggested_grant_all: all,
  }) as unknown as ApprovalPrompt;

  test("offered beside the domain where the runtime offers it; the warning says what it allows", () => {
    expect(ALL_WEB_FETCHES).toBe("Allow all web fetches for this task");
    expect(ALL_WEB_FETCHES_WARNING).toContain("send data it has read to any website");
    for (const role of ["webview", "ios"] as const) {
      expect(offersAlways(fetch, role)).toBe(true);
      expect(offersAllWebFetches(fetch, role)).toBe(true);
      expect(allWebFetchesResponse(fetch, role)).toEqual({ response: { type: "approval", decision: "allow_always", grant: all }, errors: [] });
    }
    // The domain choice is unchanged.
    expect(approvalResponse(fetch, "allow_always", initialGrant(fetch)).response).toMatchObject({ grant: { pattern: "evil.test" } });
    expect(answerVerb(fetch, { type: "approval", decision: "allow_always", grant: all })).toBe("Allowed all web fetches");
    expect(answerVerb(fetch, { type: "approval", decision: "allow_always", grant: fetch.suggested_grant })).toBe("Always allowed");
  });

  test("not on the web, not where the runtime didn't offer it, and not by typing * as the domain", () => {
    expect(offersAllWebFetches(fetch, "web")).toBe(false);
    expect(allWebFetchesResponse(fetch, "web").response).toBeNull();
    const { suggested_grant_all: _, ...domainOnly } = fetch;
    expect(offersAllWebFetches(domainOnly as ApprovalPrompt)).toBe(false);
    expect(allWebFetchesResponse(domainOnly as ApprovalPrompt).response).toBeNull();
    expect(offersAllWebFetches({ ...fetch, offer_always: false })).toBe(false);
    const typed = checkGrant(fetch, { pattern: " * ", class: "network" });
    expect(typed.proposal).toBeNull();
    expect(typed.errors.join()).toContain(ALL_WEB_FETCHES);
    expect(approvalResponse(fetch, "allow_always", { pattern: "*", class: "network" }).response).toBeNull();
  });
});

describe("the web client's reduced authority (§9.9)", () => {
  const q = questionPrompt("q1") as unknown as QuestionPrompt;
  const read = approvalPrompt("t5", { class: "read", reason: "not_allowlisted" }) as unknown as ApprovalPrompt;

  test("the web answers questions and read-class approvals; the rest says where to go", () => {
    expect(cantAnswer(q, "web")).toBeNull();
    expect(cantAnswer(read, "web")).toBeNull();
    expect(cantAnswer(bash, "web")).toBe("Approve on your phone or Mac");
    for (const role of ["webview", "ios"] as const) expect(cantAnswer(bash, role)).toBeNull();
  });

  test("never offers Always allow, and core refuses it from the web anyway", () => {
    const allow = approvalPrompt("t6", { class: "read", offer_always: true }) as unknown as ApprovalPrompt;
    expect(offersAlways(allow)).toBe(true);
    expect(offersAlways(allow, "web")).toBe(false);
    expect(approvalResponse(read, "allow", undefined, "web").response).toEqual({ type: "approval", decision: "allow" });
    expect(approvalResponse(allow, "allow_always", initialGrant(allow), "web").response).toBeNull();
    expect(approvalResponse(bash, "allow", undefined, "web").response).toBeNull();
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

  test("names the device this client runs on by its role", () => {
    const r = { state: "answered" as const, response: { type: "approval" as const, decision: "deny" as const }, answered_by: DEVICE, surface: "ios" as const, ts: 1 };
    expect(describeResolution(bash, r, DEVICE, "ios")).toBe("Denied on this iPhone");
    expect(describeResolution(bash, { ...r, surface: "web" }, DEVICE, "web")).toBe("Denied on this browser");
    // The desktop's own answer, seen on the phone.
    expect(describeResolution(bash, { ...r, answered_by: OTHER_DEVICE, surface: "desktop" }, DEVICE, "ios")).toBe("Denied on a Mac");
    expect(alreadyAnswered("answered", DEVICE, DEVICE, "web")).toBe("You already answered this on this browser.");
  });
});
