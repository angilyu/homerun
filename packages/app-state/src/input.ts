import {
  BUILTIN_TOOL_CLASS,
  GrantProposal,
  alwaysAllowable,
  checkResponse,
  grantCovers,
  requiredAuthority,
  isBuiltinTool,
  type ApprovalPrompt,
  type GrantClass,
  type InputPrompt,
  type InputResponse,
  type QuestionPrompt,
  type Surface,
} from "@homerun/core";
import type { InputResolution } from "./threads/timeline";
import type { ClientRole } from "./transport";

/**
 * Answer drafts for input requests (§5.6): the "Always allow" grant editor and question answers.
 * The checks are core's, so the user sees exactly what the runtime will accept and enforce.
 */

// ---------------------------------------------------------------- approvals

export interface GrantDraft {
  /** The pattern as typed; empty means none (a third-party tool trusted for every call). */
  pattern: string;
  class: GrantClass;
}

export interface GrantEditor {
  /** The pattern can be edited (Bash commands, WebFetch domains). */
  pattern_editable: boolean;
  /** What the pattern is, for the field's label. */
  pattern_label: string;
  classes: readonly GrantClass[];
}

/**
 * Why this client can't answer a prompt, or null if it can (§9.9). The web client answers
 * questions and approves `read`-class calls only; the runtime enforces the same rule.
 */
export function cantAnswer(p: InputPrompt, role: ClientRole = "webview"): string | null {
  if (role === "web" && requiredAuthority(p) === "full") return "Approve on your phone or Mac";
  return null;
}

/** Whether to offer "Always allow" at all. The runtime decides; core double-checks. Never on the web (§9.9). */
export function offersAlways(p: ApprovalPrompt, role: ClientRole = "webview"): boolean {
  return role !== "web" && p.offer_always && alwaysAllowable(p);
}

export function grantEditor(p: ApprovalPrompt): GrantEditor {
  if (p.tool === "Bash") return { pattern_editable: true, pattern_label: "Command pattern (* matches anything)", classes: ["read", "write", "network"] };
  if (p.tool === "WebFetch") return { pattern_editable: true, pattern_label: "Domain", classes: ["network"] };
  if (isBuiltinTool(p.tool)) {
    const c = BUILTIN_TOOL_CLASS[p.tool];
    return { pattern_editable: false, pattern_label: "", classes: c === "destructive" ? [] : [c] };
  }
  return { pattern_editable: false, pattern_label: "", classes: ["read", "write", "network"] };
}

/** The editor's starting point: the runtime's suggestion, pre-filled (§5.6). */
export function initialGrant(p: ApprovalPrompt): GrantDraft {
  const s = p.suggested_grant;
  if (s) return { pattern: s.pattern ?? "", class: s.class };
  const cls = grantEditor(p).classes[0] ?? "read";
  return { pattern: "", class: cls };
}

export interface GrantCheck {
  proposal: GrantProposal | null;
  errors: string[];
  /** Whether it covers the call being approved; null when the input isn't available inline. */
  covers: boolean | null;
}

export function checkGrant(p: ApprovalPrompt, d: GrantDraft): GrantCheck {
  const pattern = d.pattern.trim() === "" ? null : d.pattern.trim();
  const parsed = GrantProposal.safeParse({ tool: p.tool, pattern, class: d.class });
  if (!parsed.success) return { proposal: null, errors: parsed.error.issues.map((i) => i.message), covers: null };
  const covers = p.input.kind === "inline" ? grantCovers(parsed.data, { tool: p.tool, input: p.input.value }) : null;
  const errors = covers === false ? ["This pattern doesn't cover the call you're approving."] : [];
  return { proposal: parsed.data, errors, covers };
}

export type ApprovalDecision = "allow" | "deny" | "allow_always";

export function approvalResponse(p: ApprovalPrompt, decision: ApprovalDecision, grant?: GrantDraft, role: ClientRole = "webview"): { response: InputResponse | null; errors: string[] } {
  if (decision !== "allow_always") {
    const response: InputResponse = { type: "approval", decision };
    const errs = checkResponse(p, response, { role, via: "app" });
    return errs.length ? { response: null, errors: errs } : { response, errors: [] };
  }
  if (!grant) return { response: null, errors: ["Confirm the pattern first."] };
  const c = checkGrant(p, grant);
  if (!c.proposal || c.errors.length) return { response: null, errors: c.errors };
  const response: InputResponse = { type: "approval", decision, grant: c.proposal };
  const errs = checkResponse(p, response, { role, via: "app" });
  return errs.length ? { response: null, errors: errs } : { response, errors: [] };
}

// ---------------------------------------------------------------- questions

export interface QuestionDraft {
  answers: { selected: string[]; text: string }[];
}

export function initialAnswers(p: QuestionPrompt): QuestionDraft {
  return { answers: p.questions.map(() => ({ selected: [], text: "" })) };
}

/** Pick an option: single choice replaces, multiple choice toggles. */
export function toggleOption(p: QuestionPrompt, d: QuestionDraft, qi: number, label: string): QuestionDraft {
  const q = p.questions[qi];
  if (!q) return d;
  return {
    answers: d.answers.map((a, i) => {
      if (i !== qi) return a;
      const has = a.selected.includes(label);
      if (!q.multi_select) return { ...a, selected: has ? [] : [label] };
      return { ...a, selected: has ? a.selected.filter((s) => s !== label) : [...a.selected, label] };
    }),
  };
}

export function setFreeform(d: QuestionDraft, qi: number, text: string): QuestionDraft {
  return { answers: d.answers.map((a, i) => (i === qi ? { ...a, text } : a)) };
}

/** The response, or null until every question has an answer. */
export function questionResponse(p: QuestionPrompt, d: QuestionDraft, role: ClientRole = "webview"): InputResponse | null {
  const answers = p.questions.map((q, i) => {
    const a = d.answers[i] ?? { selected: [], text: "" };
    const text = q.allow_freeform && a.text.trim() !== "" ? a.text.trim() : undefined;
    return { selected: a.selected, ...(text !== undefined ? { text } : {}) };
  });
  if (answers.some((a) => a.selected.length === 0 && a.text === undefined)) return null;
  const response: InputResponse = { type: "question", answers };
  return checkResponse(p, response, { role, via: "app" }).length ? null : response;
}

// ---------------------------------------------------------------- after the fact

export const SURFACE_NAME: Readonly<Record<Surface, string>> = {
  desktop: "a Mac",
  cli: "the command line",
  ios: "iPhone",
  web: "the web",
};

/** The device this client runs on, as its own answers name it. */
export const THIS_DEVICE: Readonly<Record<ClientRole, string>> = {
  webview: "this Mac",
  ios: "this iPhone",
  web: "this browser",
};

/**
 * "Allowed on this Mac", "Answered on iPhone", "Expired" (§5.6: first answer wins). `deviceId` is
 * this client's own device (`RuntimeStatus.device_id`), which `answered_by` names when it answered.
 */
export function describeResolution(prompt: InputPrompt, r: InputResolution, deviceId: string | null, role: ClientRole = "webview"): string {
  if (r.state === "expired") return "Expired without an answer";
  if (r.state === "cancelled") return "Cancelled";
  const where = r.answered_by !== null && r.answered_by === deviceId ? `on ${THIS_DEVICE[role]}` : r.surface ? `on ${SURFACE_NAME[r.surface]}` : "";
  return `${answerVerb(prompt, r.response)} ${where}`.trim();
}

export function answerVerb(prompt: InputPrompt, response: InputResponse | null): string {
  if (!response) return "Answered";
  switch (response.type) {
    case "approval":
      return response.decision === "allow" ? "Allowed once" : response.decision === "deny" ? "Denied" : "Always allowed";
    case "question":
      return "Answered";
    case "ambiguous_tool_call":
      return response.outcome === "completed" ? "Marked as done" : "Marked as not run";
  }
}

/** Who answered first when this device was too late (`already_resolved`). */
export function alreadyAnswered(state: string, answeredBy: string | null, deviceId: string | null, role: ClientRole = "webview"): string {
  if (state === "expired") return "This request expired before your answer arrived.";
  if (state === "cancelled") return "This request was cancelled before your answer arrived.";
  if (answeredBy !== null && answeredBy === deviceId) return `You already answered this on ${THIS_DEVICE[role]}.`;
  return "This was already answered on another device.";
}
