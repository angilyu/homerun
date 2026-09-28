import { randomUUID } from "node:crypto";
import { InputRequest, requiredAuthority, type AmbiguousCallPrompt } from "@homerun/core";
import { log } from "../log";
import { toContent } from "../store/content";
import { appendEvent, callsWithoutResult, runEvents, type EventOf } from "../store/events";
import { getRunRow, insertInputRequest, setRunState, type RunRow } from "../store/rows";
import { transcriptToolState } from "../store/session-store";
import type { Store } from "../store/store";
import { finishRun } from "./finish";

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
 *      call. Resolving it is milestone 4 (`AmbiguityResolver`).
 * 3. A run that keeps crashing is abandoned with `resume_loop` after RESUME_LIMIT resumes
 *    without a completed turn.
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

/**
 * Milestone 4 applies the user's "Did this happen?" answer: it injects the decision as the
 * call's `tool_result` in the stored transcript (truncating if the SDK rejects it), writes
 * `resolved_completed` or `resolved_not_run`, and resumes with `run.resumed{ambiguity_resolved}`.
 */
export interface AmbiguityResolver {
  apply(request: InputRequest, outcome: "completed" | "not_run"): Promise<void>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} arrives in a later version of Homerun`);
    this.name = "NotImplementedError";
  }
}

export const ambiguityResolver: AmbiguityResolver = {
  apply: async () => {
    throw new NotImplementedError("Resolving an interrupted tool call");
  },
};

interface LostResult {
  call: EventOf<"tool.call">;
  status: "ok" | "error";
}

export function recoverRun(store: Store, runId: string, reason: RecoveryReason, now = Date.now()): RecoveryOutcome {
  return store.tx(() => {
    const row = getRunRow(store, runId);
    if (!row || row.state !== "running") throw new Error(`recoverRun: run ${runId} is not running`);
    const transcript = row.sdk_session_id ? transcriptToolState(store.db, row.sdk_session_id) : null;

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

    // Results we wrote whose mirrored tool_result was lost with the process: the call finished,
    // but the model will see claude's synthetic "interrupted" result. It is told the outcome.
    const lost: LostResult[] = [];
    if (transcript) {
      const results = new Map(runEvents(store, runId, "tool.result").map((e) => [e.payload.tool_call_id as string, e.payload.status]));
      for (const call of runEvents(store, runId, "tool.call")) {
        const id = call.payload.tool_call_id as string;
        const status = results.get(id);
        if ((status === "ok" || status === "error") && transcript.uses.has(id) && !transcript.results.has(id)) lost.push({ call, status });
      }
    }

    const ambiguous = callsWithoutResult(store, runId);

    if (row.stop_requested_at) {
      // The user had asked to stop: finish the cancellation instead of resuming.
      for (const c of ambiguous) writeUnknown(store, row, c, "Homerun restarted before this call reported a result.", now);
      finishRun(store, runId, "cancelled", null, { now });
      return { kind: "cancelled" };
    }

    if (row.resume_count >= RESUME_LIMIT) {
      for (const c of ambiguous) writeUnknown(store, row, c, "Homerun could not tell whether this call finished; the run was abandoned.", now);
      finishRun(store, runId, "abandoned", { code: "resume_loop", message: `The run was interrupted ${row.resume_count + 1} times without finishing a turn.` }, { now });
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

    const note = continuationNote(reason, reads, lost);
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

function continuationNote(reason: RecoveryReason, retryable: EventOf<"tool.call">[], lost: LostResult[]): string {
  const parts = [reason === "runtime_restart" ? RESTART_NOTE : AGENT_EXITED_NOTE];
  if (retryable.length) parts.push(`These calls were interrupted and only read, so you may run them again: ${retryable.map((c) => `${c.payload.tool} (${c.payload.tool_call_id})`).join(", ")}.`);
  for (const l of lost) {
    parts.push(
      `Your ${l.call.payload.tool} call ${l.call.payload.tool_call_id} did finish (${l.status === "ok" ? "successfully" : "with an error"}) even though it shows as interrupted. Do not run it again.`,
    );
  }
  return parts.join("\n\n");
}

function writeUnknown(store: Store, row: RunRow, c: EventOf<"tool.call">, message: string, now: number) {
  appendEvent(store, row.thread_id, row.run_id, "tool.result", { tool_call_id: c.payload.tool_call_id, status: "error", output: null, error: message }, now);
}

export function errorText(content: unknown): string {
  const s = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b as { text?: string }).text ?? "").join("\n") : JSON.stringify(content);
  return (s || "error").slice(0, 10_000);
}
