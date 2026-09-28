import { z } from "zod";
import { named } from "./registry";
import { Content, DeviceId, RequestId, RunId, TimestampMs, ToolCallId } from "./common";
import { GrantProposal } from "./grants";
import { ToolClass, ToolName } from "./tools";
import { SURFACE_OF_ROLE, type CallerRole } from "./protocol/handshake";

// ---------------------------------------------------------------- prompts (§5.6)

export const ApprovalReason = named(
  "ApprovalReason",
  z.enum([
    "not_allowlisted", // outside the task's allowlist
    "untrusted_tool", // third-party MCP tool not yet trusted
    "destructive", // destructive calls are approved one at a time
    "tainted_egress", // network request outside the egress allowlist in a tainted run
    "web_read_only", // run downgraded to web_read_only authority (§9.9)
  ]),
);

export const ApprovalPrompt = named(
  "ApprovalPrompt",
  z.object({
    type: z.literal("approval"),
    tool: ToolName,
    tool_call_id: ToolCallId,
    class: ToolClass,
    /** The exact arguments, as the user must see them. */
    input: Content,
    /** Full URL including the query string, for network requests (§5.5). */
    url: z.string().max(8192).optional(),
    reason: ApprovalReason,
    /** Whether "Always allow" may be offered; never for destructive calls. */
    offer_always: z.boolean(),
    /** The pattern pre-filled in the "Always allow" editor. */
    suggested_grant: GrantProposal.optional(),
  }),
);
export type ApprovalPrompt = z.infer<typeof ApprovalPrompt>;

export const QuestionOption = named("QuestionOption", z.object({ label: z.string().min(1).max(200), description: z.string().max(1000).optional() }));

/** One question, in the shape of the SDK's AskUserQuestion tool input. */
export const Question = named(
  "Question",
  z.object({
    question: z.string().min(1).max(4000),
    header: z.string().max(100).optional(),
    options: z.array(QuestionOption).min(2).max(4),
    multi_select: z.boolean(),
    allow_freeform: z.boolean(),
  }),
);
export type Question = z.infer<typeof Question>;

/** A question from the agent. AskUserQuestion carries 1–4 questions per call. */
export const QuestionPrompt = named(
  "QuestionPrompt",
  z.object({ type: z.literal("question"), tool_call_id: ToolCallId.optional(), questions: z.array(Question).min(1).max(4) }),
);
export type QuestionPrompt = z.infer<typeof QuestionPrompt>;

/** "Did this happen?" for a non-idempotent call interrupted by a crash (§5.4). Stored as kind 'question'. */
export const AmbiguousCallPrompt = named(
  "AmbiguousCallPrompt",
  z.object({ type: z.literal("ambiguous_tool_call"), tool: ToolName, tool_call_id: ToolCallId, class: ToolClass, input: Content }),
);
export type AmbiguousCallPrompt = z.infer<typeof AmbiguousCallPrompt>;

export const InputPrompt = named("InputPrompt", z.discriminatedUnion("type", [ApprovalPrompt, QuestionPrompt, AmbiguousCallPrompt]));
export type InputPrompt = z.infer<typeof InputPrompt>;

/** `input_requests.kind` (§6). */
export const InputKind = named("InputKind", z.enum(["approval", "question"]));
export type InputKind = z.infer<typeof InputKind>;

export function inputKindOf(p: InputPrompt): InputKind {
  return p.type === "approval" ? "approval" : "question";
}

// ---------------------------------------------------------------- responses

export const ApprovalResponse = named(
  "ApprovalResponse",
  z
    .object({ type: z.literal("approval"), decision: z.enum(["allow", "deny", "allow_always"]), grant: GrantProposal.optional() })
    .refine((r) => (r.decision === "allow_always") === (r.grant !== undefined), {
      message: "allow_always carries the confirmed grant, and only allow_always does",
      path: ["grant"],
    }),
);
export type ApprovalResponse = z.infer<typeof ApprovalResponse>;

export const QuestionAnswer = named(
  "QuestionAnswer",
  z
    .object({ selected: z.array(z.string().min(1).max(200)).max(4), text: z.string().min(1).max(10_000).optional() })
    .refine((a) => a.selected.length > 0 || a.text !== undefined, "choose an option or write an answer"),
);

export const QuestionResponse = named("QuestionResponse", z.object({ type: z.literal("question"), answers: z.array(QuestionAnswer).min(1).max(4) }));
export type QuestionResponse = z.infer<typeof QuestionResponse>;

/** The user's answer to "Did this happen?"; injected as the call's result (§5.4). */
export const AmbiguousCallResponse = named(
  "AmbiguousCallResponse",
  z.object({ type: z.literal("ambiguous_tool_call"), outcome: z.enum(["completed", "not_run"]) }),
);

export const InputResponse = named(
  "InputResponse",
  z.discriminatedUnion("type", [ApprovalResponse, QuestionResponse, AmbiguousCallResponse]),
);
export type InputResponse = z.infer<typeof InputResponse>;

/** How the answer was given. Grants are never created from notifications (§5.6). */
export const AnswerVia = named("AnswerVia", z.enum(["app", "notification"]));
export type AnswerVia = z.infer<typeof AnswerVia>;

// ---------------------------------------------------------------- rules

/** `any` = web may answer; `full` = desktop or iOS only (§5.6, §9.9). */
export type RequiredAuthority = "any" | "full";

export function requiredAuthority(p: InputPrompt): RequiredAuthority {
  switch (p.type) {
    // "Did this happen?" follows the call's class like an approval: "not run" makes the model
    // re-issue the call, which an existing grant could let through (D5).
    case "approval":
    case "ambiguous_tool_call":
      return p.class === "read" ? "any" : "full";
    case "question":
      return "any";
  }
}

export type InputPromptType = InputPrompt["type"];

/**
 * Which prompt types each caller role may answer at all, before the authority rules
 * (`requiredAuthority`) narrow the web client further.
 *
 * The release CLI answers questions only. Anything running as the user can invoke the CLI, and
 * approvals must happen in UI the user can see (§5.2 threat model). "Did this happen?" counts as
 * an approval here: answering it decides whether a side effect is repeated. The
 * development-mode CLI (`cli_dev`, refused by release builds) may answer everything, for §16 M6.
 */
export const INPUT_ANSWER_RIGHTS: Readonly<Record<CallerRole, readonly InputPromptType[]>> = {
  shell: ["approval", "question", "ambiguous_tool_call"],
  webview: ["approval", "question", "ambiguous_tool_call"],
  cli: ["question"],
  cli_dev: ["approval", "question", "ambiguous_tool_call"],
  ios: ["approval", "question", "ambiguous_tool_call"],
  web: ["approval", "question", "ambiguous_tool_call"],
};

export function mayAnswer(role: CallerRole, type: InputPromptType): boolean {
  return INPUT_ANSWER_RIGHTS[role].includes(type);
}

/** Checks a response against its prompt and the answering caller. Returns problems, or []. */
export function checkResponse(prompt: InputPrompt, response: InputResponse, from: { role: CallerRole; via: AnswerVia }): string[] {
  const errs: string[] = [];
  if (prompt.type !== response.type) return [`a ${prompt.type} prompt cannot take a ${response.type} response`];
  const surface = SURFACE_OF_ROLE[from.role];
  if (!mayAnswer(from.role, prompt.type)) errs.push("answer this in the Homerun app");
  if (surface === "web" && requiredAuthority(prompt) === "full") errs.push("approve on your phone or Mac");
  if (prompt.type === "approval" && response.type === "approval" && response.decision === "allow_always") {
    if (!prompt.offer_always || prompt.class === "destructive") errs.push("always allow is not offered for this request");
    if (surface === "web" || from.via === "notification") errs.push("grants need the full app on desktop or iOS");
    if (response.grant && response.grant.tool !== prompt.tool) errs.push("the grant must be for the requested tool");
  }
  if (from.via === "notification" && !answerableFromNotification(prompt)) errs.push("this request must be answered in the app");
  if (prompt.type === "question" && response.type === "question") {
    if (response.answers.length !== prompt.questions.length) errs.push("one answer per question");
    prompt.questions.forEach((q, i) => {
      const a = response.answers[i];
      if (!a) return;
      const labels = new Set(q.options.map((o) => o.label));
      if (a.selected.some((s) => !labels.has(s))) errs.push(`answer ${i}: unknown option`);
      if (!q.multi_select && a.selected.length > 1) errs.push(`answer ${i}: single choice`);
      if (a.text !== undefined && !q.allow_freeform) errs.push(`answer ${i}: freeform not allowed`);
    });
  }
  return errs;
}

/**
 * Whether a lock-screen action may answer this (§9.7): `read` / `write` approvals and questions
 * with short choices. Destructive approvals always open the app and require Face ID.
 */
export function answerableFromNotification(p: InputPrompt): boolean {
  switch (p.type) {
    case "approval":
      return p.class === "read" || p.class === "write";
    case "question":
      return p.questions.length === 1 && !p.questions[0]!.multi_select;
    case "ambiguous_tool_call":
      return false;
  }
}

// ---------------------------------------------------------------- row (§6 input_requests)

export const InputRequestState = named("InputRequestState", z.enum(["pending", "answered", "expired", "cancelled"]));
export type InputRequestState = z.infer<typeof InputRequestState>;

export const InputRequest = named(
  "InputRequest",
  z
    .object({
      request_id: RequestId,
      run_id: RunId,
      kind: InputKind,
      tool_call_id: ToolCallId.nullable(),
      prompt: InputPrompt,
      state: InputRequestState,
      requested_at: TimestampMs,
      expires_at: TimestampMs.nullable(),
      answered_at: TimestampMs.nullable(),
      response: InputResponse.nullable(),
      answered_by: DeviceId.nullable(),
    })
    .superRefine((r, ctx) => {
      if (r.kind !== inputKindOf(r.prompt)) ctx.addIssue({ code: "custom", path: ["kind"], message: "kind does not match prompt" });
      const answered = r.state === "answered";
      if (answered !== (r.response !== null) || answered !== (r.answered_by !== null) || answered !== (r.answered_at !== null))
        ctx.addIssue({ code: "custom", path: ["state"], message: "response, answered_by and answered_at are set exactly when answered" });
      if (r.response !== null && r.response.type !== r.prompt.type)
        ctx.addIssue({ code: "custom", path: ["response"], message: "response type does not match prompt" });
    }),
);
export type InputRequest = z.infer<typeof InputRequest>;
