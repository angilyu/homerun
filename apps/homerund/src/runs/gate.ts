import { Question, type ApprovalPrompt, type InputPrompt, type InputResponse, type QuestionPrompt, type TaskSpec, type ToolCallId } from "@homerun/core";
import type { ApprovalAsk } from "../agent/policy";

/**
 * Pieces of the approval and question flow (§5.6) shared by the driver, the answer path,
 * recovery and the timeout sweep: prompts from calls, answers into calls, and the texts the
 * model sees.
 */

export const DENIED_TEXT = "The user denied this call, so it was not run.";
/** The parallel-call rule (§5.6): one gated call waits; its gated siblings are denied. */
export const SIBLING_TEXT = "Not run; re-issue after the pending approval.";
export const EXPIRED_TEXT = "Nobody answered in time, so this call was not run.";
/** An approved call whose process was gone before the approval reached it (§5.4, §5.6). */
export const APPROVED_NOT_RUN_TEXT = "This call did not run: Homerun restarted while it waited for approval. The user approved it; run it again now.";
export const ANSWERED_NOTE = "The user answered while Homerun was restarting. The outcome of your pending call is in its result; continue the task.";
export const BAD_QUESTION_TEXT = "AskUserQuestion needs 1–4 questions, each with 2–4 options.";

/** The SDK's `AskUserQuestion` input as a core question prompt, or null when it is malformed. */
export function questionPrompt(toolCallId: string, input: unknown): QuestionPrompt | null {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return null;
  const questions: Question[] = [];
  for (const q of qs as Array<Record<string, unknown>>) {
    const parsed = Question.safeParse({
      question: q?.question,
      ...(typeof q?.header === "string" && q.header ? { header: q.header.slice(0, 100) } : {}),
      options: Array.isArray(q?.options)
        ? (q.options as Array<Record<string, unknown>>).map((o) => ({
            label: o?.label,
            ...(typeof o?.description === "string" && o.description ? { description: o.description.slice(0, 1000) } : {}),
          }))
        : q?.options,
      multi_select: q?.multiSelect === true,
      // The SDK always offers "Other" with a free answer.
      allow_freeform: true,
    });
    if (!parsed.success) return null;
    questions.push(parsed.data);
  }
  return { type: "question", tool_call_id: toolCallId as ToolCallId, questions };
}

/** `updatedInput.answers` for `AskUserQuestion`: question text → answer, multi-select joined by ", ". */
export function sdkAnswers(prompt: QuestionPrompt, r: Extract<InputResponse, { type: "question" }>): Record<string, string> {
  const out: Record<string, string> = {};
  prompt.questions.forEach((q, i) => {
    const a = r.answers[i];
    if (a) out[q.question] = [...a.selected, ...(a.text !== undefined ? [a.text] : [])].join(", ");
  });
  return out;
}

/** The result text of an answered question, when Homerun writes it itself (no process to hand it to). */
export function answerText(prompt: QuestionPrompt, r: Extract<InputResponse, { type: "question" }>): string {
  const a = sdkAnswers(prompt, r);
  return `User has answered your questions: ${Object.entries(a)
    .map(([q, v]) => `"${q}"="${v}"`)
    .join(", ")}. You can now continue with the user's answers in mind.`;
}

export function approvalPrompt(call: { toolCallId: string; tool: string; toolClass: ApprovalPrompt["class"]; input: ApprovalPrompt["input"] }, a: ApprovalAsk): ApprovalPrompt {
  return {
    type: "approval",
    tool: call.tool,
    tool_call_id: call.toolCallId as ToolCallId,
    class: call.toolClass,
    input: call.input,
    ...(a.url ? { url: a.url.slice(0, 8192) } : {}),
    reason: a.reason,
    offer_always: a.offerAlways,
    ...(a.offerAlways && a.suggestedGrant ? { suggested_grant: a.suggestedGrant } : {}),
    ...(a.offerAlways && a.suggestedGrant && a.suggestedGrantAll ? { suggested_grant_all: a.suggestedGrantAll } : {}),
  };
}

/** When a new request expires, from the task's `input_timeout` (§5.6). `wait` never expires. */
export function expiresAt(spec: Pick<TaskSpec, "policy">, now: number): number | null {
  const t = spec.policy.input_timeout;
  return t.action === "wait" ? null : now + t.after_ms;
}

export function isGatePrompt(p: InputPrompt): p is ApprovalPrompt | QuestionPrompt {
  return p.type === "approval" || p.type === "question";
}

export function denialText(r: InputResponse | null): string {
  return r?.type === "approval" && r.decision === "deny" ? DENIED_TEXT : EXPIRED_TEXT;
}
