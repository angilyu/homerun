import { randomUUID } from "node:crypto";
import { InputRequest, requiredAuthority, type AmbiguousCallPrompt } from "@homerun/core";
import { log } from "../log";
import { contentValue, toContent } from "../store/content";
import { appendEvent, callsWithoutResult, findToolEvent, runEvents, type EventOf } from "../store/events";
import { getRunRow, insertInputRequest, setRunState } from "../store/rows";
import type { Store } from "../store/store";
import { allToolUseIds, chainTools, sessionView } from "../store/transcript";
import { finishRun } from "./finish";
import { UNKNOWN_TEXT } from "./resume";

/**
 * Crash recovery for one run (§5.4 steps 5–7). Used at startup for every run left `running`,
 * and when `claude` dies while the runtime keeps going (reason `agent_exited`).
 *
 * The run's process group must already be gone. Recovery reads only SQLite:
 * 1. A `tool.call` with no `tool.result` whose result the SDK did mirror gets that result.
 * 2. The rest are ambiguous: they may or may not have happened.
 *    - none: the run is requeued and resumes from the stored session with a continuation note;
 *    - only read-class calls: each gets `interrupted_retryable`, and the run is requeued with a
 *      note saying they may be retried;
 *    - any other call: the run parks in `waiting_input` with a "Did this happen?" request per
 *      call. The answer is applied by `AmbiguityResolver` (ambiguity.ts).
 * 3. A run that keeps crashing is abandoned with `resume_loop` after RESUME_LIMIT resumes
 *    without a completed turn.
 *
 * Recovery writes only events and the run row. The transcript is brought in line when the run
 * resumes (`prepareResume`): each dangling `tool_use` gets the result recorded here.
 */

export const RESUME_LIMIT = 3;

export const RESTART_NOTE = "Homerun restarted while you were working. Your last step may not have finished; continue the task.";
export const AGENT_EXITED_NOTE = "Your process stopped unexpectedly while you were working. Your last step may not have finished; continue the task.";

export type RecoveryReason = "runtime_restart" | "agent_exited";

export type RecoveryOutcome =
  | { kind: "requeued"; retried: string[] }
  | { kind: "waiting_input"; requests: string[] }
  | { kind: "abandoned" }
  | { kind: "cancelled" };

export function recoverRun(store: Store, runId: string, reason: RecoveryReason, now = Date.now()): RecoveryOutcome {
  return store.tx(() => {
    const row = getRunRow(store, runId);
    if (!row || row.state !== "running") throw new Error(`recoverRun: run ${runId} is not running`);
    const view = row.sdk_session_id ? sessionView(store, row.sdk_session_id, row.resume_at) : null;
    const transcript = view ? chainTools(view.chain) : null;

    // 1. Results the SDK mirrored but we never wrote (the Post hook never reached us).
    for (const call of callsWithoutResult(store, runId)) {
      const r = transcript?.results.get(call.payload.tool_call_id);
      if (!r) continue;
      appendEvent(store, row.thread_id, runId, "tool.result", {
        tool_call_id: call.payload.tool_call_id,
        status: r.isError ? "error" : "ok",
        output: r.isError ? null : toContent(store, r.content, now),
        ...(r.isError ? { error: errorText(r.content) } : {}),
      }, now);
    }

    // Calls that finished but whose tool_use the transcript lost with the process: the model
    // does not know it made them. The note tells it, so it does not make them again.
    const unseen: EventOf<"tool.call">[] = [];
    if (row.sdk_session_id) {
      const ids = allToolUseIds(store, row.sdk_session_id);
      const results = new Set(runEvents(store, runId, "tool.result").map((e) => e.payload.tool_call_id));
      for (const call of runEvents(store, runId, "tool.call")) {
        if (results.has(call.payload.tool_call_id) && !ids.has(call.payload.tool_call_id) && !call.payload.parent_tool_call_id) unseen.push(call);
      }
    }

    const ambiguous = callsWithoutResult(store, runId);

    if (row.stop_requested_at) {
      // The user had asked to stop: finish the cancellation instead of resuming.
      finishRun(store, runId, "cancelled", null, { now, unresolved: UNKNOWN_TEXT });
      return { kind: "cancelled" };
    }

    if (row.resume_count >= RESUME_LIMIT) {
      finishRun(store, runId, "abandoned", { code: "resume_loop", message: `The run was interrupted ${row.resume_count + 1} times without finishing a turn.` }, { now, unresolved: UNKNOWN_TEXT });
      log.warn("run abandoned after repeated resumes", { run_id: runId });
      return { kind: "abandoned" };
    }

    const reads = ambiguous.filter((c) => c.payload.class === "read");
    const others = ambiguous.filter((c) => c.payload.class !== "read");
    for (const c of reads) {
      appendEvent(store, row.thread_id, runId, "tool.result", {
        tool_call_id: c.payload.tool_call_id,
        status: "interrupted_retryable",
        output: null,
        error: "Interrupted when Homerun restarted. It only reads, so it is safe to run again.",
      }, now);
    }

    const note = mergeNotes(row.resume_note, continuationNote(reason, reads, unseen, store));
    if (others.length === 0) {
      setRunState(store, runId, "pending", {
        claude_pid: null,
        resume_count: row.resume_count + 1,
        resume_reason: reason,
        resume_note: note,
      });
      return { kind: "requeued", retried: reads.map((c) => c.payload.tool_call_id) };
    }

    setRunState(store, runId, "waiting_input", { claude_pid: null, resume_reason: "ambiguity_resolved", resume_note: note });
    const requests: string[] = [];
    for (const c of others) {
      const prompt: AmbiguousCallPrompt = {
        type: "ambiguous_tool_call",
        tool: c.payload.tool,
        tool_call_id: c.payload.tool_call_id,
        class: c.payload.class,
        input: c.payload.input,
      };
      const req = InputRequest.parse({
        request_id: randomUUID(),
        run_id: runId,
        kind: "question",
        tool_call_id: c.payload.tool_call_id,
        prompt,
        state: "pending",
        requested_at: now,
        expires_at: null,
        answered_at: null,
        response: null,
        answered_by: null,
      });
      insertInputRequest(store, req);
      appendEvent(store, row.thread_id, runId, "input.requested", {
        request_id: req.request_id,
        prompt: req.prompt,
        required_authority: requiredAuthority(req.prompt),
        expires_at: null,
      }, now);
      requests.push(req.request_id);
    }
    return { kind: "waiting_input", requests };
  });
}

function continuationNote(reason: RecoveryReason, retryable: EventOf<"tool.call">[], unseen: EventOf<"tool.call">[], store: Store): string {
  const parts = [reason === "runtime_restart" ? RESTART_NOTE : AGENT_EXITED_NOTE];
  if (retryable.length) parts.push(`These calls were interrupted and only read, so you may run them again: ${retryable.map((c) => `${c.payload.tool} (${c.payload.tool_call_id})`).join(", ")}.`);
  for (const c of unseen) {
    const r = findToolEvent(store, c.thread_id, "tool.result", c.payload.tool_call_id);
    if (r) parts.push(outcomeSentence(store, c, r.payload.status));
  }
  return parts.join("\n\n");
}

/**
 * What happened to a call, for a continuation note: used when the transcript the model resumes
 * from does not show the call's result (its `tool_use` was lost, or a truncating resume hides it).
 */
export function outcomeSentence(store: Store, c: EventOf<"tool.call">, status: EventOf<"tool.result">["payload"]["status"]): string {
  const call = `${c.payload.tool} with input ${inputPreview(store, c)}`;
  switch (status) {
    case "ok":
      return `Before the restart you called ${call}, and it finished successfully. Do not run it again.`;
    case "error":
      return `Before the restart you called ${call}, and it failed.`;
    case "denied":
      return `Before the restart you called ${call}, and it was denied.`;
    case "interrupted_retryable":
      return `Before the restart you called ${call}, and it was interrupted. It only reads, so you may run it again.`;
    case "resolved_completed":
      return `Just before the restart you called ${call}. The user confirmed that it completed: its effect happened, so do not run it again.`;
    case "resolved_not_run":
      return `Just before the restart you called ${call}. The user confirmed that it did not run; run it again if the task still needs it.`;
  }
}

/**
 * A note not yet delivered when the run was interrupted again still holds (a decision, a call
 * the model never saw), so the new one extends it. Paragraphs already there are not repeated.
 */
export function mergeNotes(prev: string | null, next: string): string {
  if (!prev) return next;
  const have = prev.split("\n\n");
  return [...have, ...next.split("\n\n").filter((p) => !have.includes(p))].join("\n\n");
}

export function inputPreview(store: Store, c: EventOf<"tool.call">): string {
  const s = JSON.stringify(contentValue(store, c.payload.input)) ?? "null";
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

export function errorText(content: unknown): string {
  const s = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? "").join("\n") : JSON.stringify(content);
  return (s || "error").slice(0, 10_000);
}
