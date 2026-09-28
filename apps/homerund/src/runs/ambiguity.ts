import { checkResponse, type AnswerVia, type CallerRole, type InputRequest, type InputRequestState, type InputResponse, type Origin } from "@homerun/core";
import { appendEvent, findToolEvent } from "../store/events";
import { answerInputRequest, getInputRequest, getRunRow, pendingInputRequests, releaseHeldInputs, setRunState, updateRun } from "../store/rows";
import type { Store } from "../store/store";
import { chainTools, sessionView, truncationPoint } from "../store/transcript";
import { mergeNotes, outcomeSentence } from "./recovery";

/**
 * Applies the answer to "Did this happen?" (§5.4, milestone 4). A crash left a non-read call
 * without a result, and the run parked in `waiting_input` with one request per such call.
 *
 * One transaction per answer: the request becomes `answered` (first answer wins), the call gets
 * its `resolved_completed` / `resolved_not_run` result, and a sentence joins the run's
 * continuation note. When the last request of the run is answered, held messages are released
 * and the run is requeued. The launch then writes the result into the transcript as the call's
 * `tool_result` (`prepareResume`), with the note as an explicit continuation message.
 *
 * `truncate` (development only, `HOMERUN_DEV_AMBIGUITY_MODE`) is the fallback from the design:
 * resume from before the assistant message that made the first ambiguous call, so the model
 * never sees the calls, and let the note say what happened to each of them.
 */

export type AmbiguityMode = "inject" | "truncate";

export class AnswerRejected extends Error {
  constructor(
    readonly reason: "authority" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "AnswerRejected";
  }
}

export type AnswerResult = { status: "applied" } | { status: "already_resolved"; state: InputRequestState; answered_by: string | null };

export interface Answer {
  response: InputResponse;
  role: CallerRole;
  via: AnswerVia;
  origin: Origin;
}

/** Throws AnswerRejected when this caller may not give this answer. */
export function checkAnswer(req: InputRequest, a: Answer): void {
  const errs = checkResponse(req.prompt, a.response, { role: a.role, via: a.via });
  if (!errs.length) return;
  const wrongType = req.prompt.type !== a.response.type;
  throw new AnswerRejected(wrongType ? "invalid" : "authority", errs.join("; "));
}

export class AmbiguityResolver {
  constructor(
    private store: Store,
    private mode: AmbiguityMode,
    /** Called after the commit that requeues a run. */
    private onRequeued: () => void,
  ) {}

  answer(requestId: string, a: Answer, now = Date.now()): AnswerResult {
    const store = this.store;
    return store.tx((): AnswerResult => {
      const req = getInputRequest(store, requestId);
      if (!req) throw new Error(`no input request ${requestId}`);
      if (req.prompt.type !== "ambiguous_tool_call") throw new Error("not a 'Did this happen?' request");
      checkAnswer(req, a);
      if (a.response.type !== "ambiguous_tool_call") throw new AnswerRejected("invalid", "not a 'Did this happen?' answer");
      if (!answerInputRequest(store, requestId, a.response, a.origin.device_id, now)) {
        const cur = getInputRequest(store, requestId)!;
        return { status: "already_resolved", state: cur.state, answered_by: cur.answered_by };
      }
      const run = getRunRow(store, req.run_id)!;
      appendEvent(store, run.thread_id, run.run_id, "input.resolved", {
        request_id: requestId,
        state: "answered",
        response: a.response,
        answered_by: a.origin.device_id,
        surface: a.origin.surface,
        via: a.via,
      }, now);
      const completed = a.response.outcome === "completed";
      const callId = req.prompt.tool_call_id;
      if (!findToolEvent(store, run.thread_id, "tool.result", callId)) {
        appendEvent(store, run.thread_id, run.run_id, "tool.result", {
          tool_call_id: callId,
          status: completed ? "resolved_completed" : "resolved_not_run",
          output: null,
        }, now);
      }
      const call = findToolEvent(store, run.thread_id, "tool.call", callId);
      const note = call ? mergeNotes(run.resume_note, outcomeSentence(store, call, completed ? "resolved_completed" : "resolved_not_run")) : run.resume_note;
      updateRun(store, run.run_id, { resume_note: note });

      if (run.state === "waiting_input" && pendingInputRequests(store, { runId: run.run_id }).length === 0) {
        const cut = this.mode === "truncate" && run.sdk_session_id ? this.truncateAt(run.run_id, run.thread_id, run.sdk_session_id, run.resume_at) : null;
        releaseHeldInputs(store, run.run_id);
        setRunState(store, run.run_id, "pending", {
          resume_reason: "ambiguity_resolved",
          ...(cut ? { resume_at: cut.at, resume_note: cut.dropped.reduce<string | null>((n, d) => mergeNotes(n, d), note) } : {}),
        });
        store.afterCommit(this.onRequeued);
      }
      return { status: "applied" };
    });
  }

  /**
   * The earliest truncation point over the run's resolved calls still open in the transcript,
   * and a sentence for each other call the truncation hides that had already finished.
   */
  private truncateAt(runId: string, threadId: string, sessionId: string, current: string | null): { at: string; dropped: string[] } | null {
    const store = this.store;
    const view = sessionView(store, sessionId, current);
    const resolved = new Set(
      store.db
        .query<{ id: string }, [string]>(
          "SELECT json_extract(payload, '$.tool_call_id') AS id FROM thread_events WHERE run_id = ? AND type = 'tool.result' AND json_extract(payload, '$.status') IN ('resolved_completed', 'resolved_not_run')",
        )
        .all(runId)
        .map((r) => r.id),
    );
    const tools = chainTools(view.chain);
    const first = tools.dangling.find((u) => resolved.has(u.id));
    const at = first ? truncationPoint(view.chain, first.id) : null;
    if (!at) return null;
    const cutFrom = view.chain.findIndex((t) => t.uuid === at) + 1;
    const hidden = new Set(view.chain.slice(cutFrom).map((t) => t.uuid));
    const dropped: string[] = [];
    for (const u of tools.uses.values()) {
      if (!hidden.has(u.at.uuid) || resolved.has(u.id)) continue;
      const call = findToolEvent(store, threadId, "tool.call", u.id);
      const r = findToolEvent(store, threadId, "tool.result", u.id);
      if (!call || !r) continue;
      dropped.push(outcomeSentence(store, call, r.payload.status));
    }
    return { at, dropped };
  }
}

