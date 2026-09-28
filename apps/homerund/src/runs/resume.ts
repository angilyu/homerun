import type { Content } from "@homerun/core";
import { contentValue } from "../store/content";
import { findToolEvent, type EventOf } from "../store/events";
import { updateRun, type RunRow } from "../store/rows";
import type { Store } from "../store/store";
import { chainTools, injectResults, sessionView, type Injection } from "../store/transcript";

/**
 * Before `claude` resumes a stored session, every `tool_use` left without a `tool_result` gets
 * the outcome Homerun recorded (§5.4). Otherwise `claude` writes its own "interrupted" result on
 * resume (F7), and to the model "interrupted" reads as "run it again".
 *
 * Covers every way a call can be left dangling: a crash or a dead `claude` mid-call (the user's
 * "Did this happen?" answer, or `interrupted_retryable` for a read), a result the SDK never
 * mirrored before the process died, and a run that ended (stopped, cancelled while waiting,
 * abandoned) before the call reported. It is idempotent: once written, the call is not dangling.
 */

/** The injected result when the user says the call completed. Not an error: its effect happened. */
export const COMPLETED_TEXT =
  "Homerun restarted while this call was running, so its output was lost. The user confirmed that it completed: its effect happened. Do not run it again.";
/** The injected result when the user says the call did not run. */
export const NOT_RUN_TEXT = "Homerun restarted while this call was running. The user confirmed that it did not run. Run it again if the task still needs it.";
/** A call the gate never allowed (no `tool.call`): the PreToolUse hook blocks, so it cannot have run. */
export const NOT_STARTED_TEXT = "Homerun restarted before this call started, so it did not run. Run it again if the task still needs it.";
/** The result of a call whose run ended while nobody knew whether it ran. */
export const UNKNOWN_TEXT =
  "The run stopped before anyone confirmed whether this call ran, so its outcome is unknown. Check whether its effect happened before running it again.";

const MAX_TEXT = 30_000;

export interface ResumePlan {
  /** Pass as `resumeSessionAt`, or null to resume at the end. */
  resumeAt: string | null;
  /** tool_use ids that got a result written now. */
  injected: string[];
}

export function prepareResume(store: Store, row: RunRow, sessionId: string, now = Date.now()): ResumePlan {
  return store.tx(() => {
    const view = sessionView(store, sessionId, row.sdk_session_id === sessionId ? row.resume_at : null);
    if (row.resume_at && !view.resumeAt) updateRun(store, row.run_id, { resume_at: null });
    if (view.resumeAt) return { resumeAt: view.resumeAt, injected: [] };
    const items: Injection[] = [];
    for (const u of chainTools(view.chain).dangling) {
      const result = findToolEvent(store, row.thread_id, "tool.result", u.id);
      if (result) items.push(injectionFor(store, result));
      else if (!findToolEvent(store, row.thread_id, "tool.call", u.id)) items.push({ toolUseId: u.id, text: NOT_STARTED_TEXT, isError: true });
    }
    return { resumeAt: null, injected: items.length ? injectResults(store, sessionId, view.chain, items, now) : [] };
  });
}

export function injectionFor(store: Store, r: EventOf<"tool.result">): Injection {
  const p = r.payload;
  const id = p.tool_call_id;
  switch (p.status) {
    case "ok":
      return { toolUseId: id, text: outputText(store, p.output) || "(no output)", isError: false };
    case "resolved_completed":
      return { toolUseId: id, text: COMPLETED_TEXT, isError: false };
    case "resolved_not_run":
      return { toolUseId: id, text: NOT_RUN_TEXT, isError: true };
    default:
      return { toolUseId: id, text: (p.error ?? "error").slice(0, MAX_TEXT), isError: true };
  }
}

/** A recorded tool output as text for the model: a string as is, Bash's stdout/stderr, else JSON. */
export function outputText(store: Store, c: Content | null): string {
  if (!c) return "";
  const v = contentValue(store, c);
  let s: string;
  if (typeof v === "string") s = v;
  else if (v && typeof v === "object" && typeof (v as { stdout?: unknown }).stdout === "string") {
    const o = v as { stdout: string; stderr?: unknown };
    s = [o.stdout, typeof o.stderr === "string" ? o.stderr : ""].filter(Boolean).join("\n");
  } else s = v === null || v === undefined ? "" : JSON.stringify(v);
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[truncated]` : s;
}
