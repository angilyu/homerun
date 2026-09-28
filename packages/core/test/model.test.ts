import { describe, expect, test } from "bun:test";
import {
  ACTIVE_RUN_STATES,
  BUILTIN_TOOL_CLASS,
  BashCommandPattern,
  BuiltinTool,
  RUN_STATE_TRANSITIONS,
  RunState,
  TERMINAL_RUN_STATES,
  TaskSpec,
  ToolGrant,
  answerableFromNotification,
  authorityAfterMessage,
  canTransition,
  checkResponse,
  effectiveEgressDomains,
  hasShellMetacharacters,
  inputKindOf,
  isTerminal,
  requiredAuthority,
  upgradeSpec,
  type InputPrompt,
  type InputResponse,
  type ToolGrant as ToolGrantT,
} from "../src/index";
import * as F from "../scripts/vectors/fixtures";

describe("task spec", () => {
  test("upgradeSpec reads format 1 and refuses unknown formats", () => {
    expect(upgradeSpec(F.sessionSpec()).kind).toBe("session");
    expect(() => upgradeSpec({ ...F.sessionSpec(), format: 2 })).toThrow("unsupported task spec format 2");
    expect(() => upgradeSpec(null)).toThrow();
  });

  test("monitors carry no top-level model; the act step does", () => {
    const m = TaskSpec.parse(F.monitorSpec());
    expect("model" in m).toBe(false);
    if (m.kind === "monitor") expect(m.act.model.model).toBe("claude-haiku-4-5");
  });

  test("unknown fields are dropped, not kept (tolerant reader)", () => {
    const r = TaskSpec.parse({ ...F.sessionSpec(), future_field: 1 });
    expect("future_field" in r).toBe(false);
  });
});

describe("bash patterns", () => {
  test.each(["npm test", "git status", "ls *", "git log --oneline -n 5", "pnpm --filter @homerun/core test"])("grantable: %p", (p) => {
    expect(BashCommandPattern.safeParse(p).success).toBe(true);
  });
  test.each(["", "*", "* foo", " npm test", "npm test ", "a; b", "a && b", "a || b", "a | b", "a & b", "$(x)", "`x`", "echo $HOME", "a > f", "a < f", "a\nb"])(
    "never grantable: %p",
    (p) => {
      expect(BashCommandPattern.safeParse(p).success).toBe(false);
    },
  );
  test("hasShellMetacharacters", () => {
    expect(hasShellMetacharacters("npm test && rm -rf /")).toBe(true);
    expect(hasShellMetacharacters("npm test")).toBe(false);
  });
});

describe("grants", () => {
  test("every builtin has a class and destructive is never grantable", () => {
    for (const t of BuiltinTool.options) expect(BUILTIN_TOOL_CLASS[t]).toBeDefined();
    expect(ToolGrant.safeParse(F.grant({ tool: "mcp__x__y", pattern: null, class: "destructive" })).success).toBe(false);
  });

  test("effective egress = spec domains + active WebFetch grants", () => {
    const g = (over: Partial<ToolGrantT>) => ToolGrant.parse(F.grant({ tool: "WebFetch", class: "network", ...over }));
    const grants = [g({ pattern: "api.stripe.com" }), g({ pattern: "old.example.com", revoked_at: F.T0 }), ToolGrant.parse(F.grant())];
    expect(effectiveEgressDomains(["api.github.com"], grants).sort()).toEqual(["api.github.com", "api.stripe.com"]);
  });
});

describe("input rules", () => {
  const approval = (cls: string, over: Record<string, unknown> = {}) => F.approvalPrompt({ class: cls, ...over }) as InputPrompt;
  const question = F.questionPrompt() as InputPrompt;
  const allow = { type: "approval", decision: "allow" } as const;
  const app = (surface: "desktop" | "cli" | "ios" | "web") => ({ surface, via: "app" as const });

  test("web may answer only read approvals and questions (§9.9)", () => {
    expect(requiredAuthority(approval("read"))).toBe("any");
    for (const c of ["write", "destructive", "network"]) expect(requiredAuthority(approval(c))).toBe("full");
    expect(checkResponse(approval("read"), allow, app("web"))).toEqual([]);
    expect(checkResponse(approval("write"), allow, app("web"))).not.toEqual([]);
    expect(checkResponse(approval("write"), allow, app("ios"))).toEqual([]);
    expect(checkResponse(question, { type: "question", answers: [{ selected: ["main"] }] }, app("web"))).toEqual([]);
  });

  test("the CLI answers questions and approvals (§16 M6)", () => {
    // §16 M6 "answer from CLI" (see README, open question Q2).
    expect(checkResponse(approval("destructive"), allow, app("cli"))).toEqual([]);
    expect(checkResponse(question, { type: "question", answers: [{ selected: ["main"] }] }, app("cli"))).toEqual([]);
  });

  test("always allow: only when offered, never destructive, never from web or a notification", () => {
    const always = { type: "approval", decision: "allow_always", grant: { tool: "Bash", pattern: "npm install", class: "write" } } as const;
    expect(checkResponse(approval("write"), always, app("desktop"))).toEqual([]);
    expect(checkResponse(approval("write", { offer_always: false }), always, app("desktop"))).not.toEqual([]);
    expect(checkResponse(approval("destructive"), always, app("desktop"))).not.toEqual([]);
    expect(checkResponse(approval("write"), always, { surface: "ios", via: "notification" })).not.toEqual([]);
    const other = { ...always, grant: { tool: "Write", pattern: null, class: "write" } } as const;
    expect(checkResponse(approval("write"), other, app("desktop"))).toContain("the grant must be for the requested tool");
  });

  test("lock screen: read/write approvals and short questions; destructive opens the app (§9.7)", () => {
    expect(answerableFromNotification(approval("read"))).toBe(true);
    expect(answerableFromNotification(approval("write"))).toBe(true);
    expect(answerableFromNotification(approval("destructive"))).toBe(false);
    expect(answerableFromNotification(approval("network"))).toBe(false);
    expect(answerableFromNotification(question)).toBe(true);
    expect(checkResponse(approval("destructive"), allow, { surface: "ios", via: "notification" })).not.toEqual([]);
  });

  test("question answers must match the options", () => {
    const q = F.questionPrompt({
      questions: [{ question: "Pick", options: [{ label: "a" }, { label: "b" }], multi_select: false, allow_freeform: false }],
    }) as InputPrompt;
    const ans = (selected: string[], text?: string): InputResponse => ({ type: "question", answers: [{ selected, ...(text ? { text } : {}) }] });
    expect(checkResponse(q, ans(["a"]), app("desktop"))).toEqual([]);
    expect(checkResponse(q, ans(["c"]), app("desktop"))).not.toEqual([]);
    expect(checkResponse(q, ans(["a", "b"]), app("desktop"))).not.toEqual([]);
    expect(checkResponse(q, ans([], "other"), app("desktop"))).not.toEqual([]);
    expect(checkResponse(q, allow, app("desktop"))).not.toEqual([]);
  });

  test("ambiguous-call prompts are stored as questions (§6 kind)", () => {
    const p = { type: "ambiguous_tool_call", tool: "Write", tool_call_id: F.TOOL_CALL, class: "write", input: F.inline({}) } as InputPrompt;
    expect(inputKindOf(p)).toBe("question");
    expect(inputKindOf(approval("read"))).toBe("approval");
  });
});

describe("runs", () => {
  test("active and terminal states partition RunState", () => {
    const all = [...ACTIVE_RUN_STATES, ...TERMINAL_RUN_STATES].sort();
    expect(all).toEqual([...RunState.options].sort());
    for (const s of RunState.options) expect(isTerminal(s)).toBe((TERMINAL_RUN_STATES as readonly string[]).includes(s));
  });

  test("terminal states have no way out; every active state can end", () => {
    for (const s of TERMINAL_RUN_STATES) expect(RUN_STATE_TRANSITIONS[s]).toEqual([]);
    for (const s of ACTIVE_RUN_STATES) expect(RUN_STATE_TRANSITIONS[s].some(isTerminal)).toBe(true);
    expect(canTransition("running", "waiting_input")).toBe(true);
    expect(canTransition("waiting_input", "pending")).toBe(true);
    expect(canTransition("pending", "succeeded")).toBe(false);
    expect(canTransition("succeeded", "running")).toBe(false);
  });

  test("authority is only ever downgraded (§9.9)", () => {
    expect(authorityAfterMessage("full", "web")).toBe("web_read_only");
    expect(authorityAfterMessage("full", "ios")).toBe("full");
    for (const s of ["desktop", "cli", "ios", "web"] as const) expect(authorityAfterMessage("web_read_only", s)).toBe("web_read_only");
  });
});
