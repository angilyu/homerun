import { grantCovers, type InputRequest } from "@homerun/core";
import { contentValue, toContent } from "../store/content";
import { appendEvent, findToolEvent } from "../store/events";
import { insertGrant } from "../store/grants";
import {
  answerInputRequest,
  getGateRequest,
  getRunRow,
  markRequestApplied,
  pendingInputRequests,
  releaseHeldInputs,
  setRunState,
  updateRun,
  type GateRequest,
  type RunRow,
} from "../store/rows";
import type { Store } from "../store/store";
import { AnswerRejected, checkAnswer, type Answer, type AnswerResult } from "./ambiguity";
import { ANSWERED_NOTE, APPROVED_NOT_RUN_TEXT, answerText, denialText } from "./gate";
import { mergeNotes } from "./recovery";

/**
 * The answer path for approvals and questions (§5.6). One transaction per answer:
 * - first answer wins (`WHERE state = 'pending'`); a late answer learns who answered;
 * - "Always allow" creates its grant in the same transaction (`input.resolved.grant_id`);
 * - then the answer goes where the call is:
 *   - a live process waiting for it (short wait): the driver applies it after the commit;
 *   - a process that is deferring the call right now: the driver requeues the run once the
 *     deferral is recorded;
 *   - no process: the run is requeued (held messages released) once nothing else is pending.
 *     A deferred call is re-asked by `claude` on resume and gets the stored answer; a call whose
 *     process died before it deferred gets its result written now (`settleWithoutProcess`).
 */

/** What the live driver of a run is doing with a request. */
export type LiveGate = "waiting" | "deferring" | null;

export interface GateHooks {
  /** The live driver's relation to this request. */
  liveGate(runId: string, requestId: string): LiveGate;
  /** After the commit: hand the answer to the waiting driver. */
  wake(runId: string, requestId: string): void;
  /** After a commit that requeued a run. */
  requeued(): void;
}

export class GateResolver {
  constructor(
    private store: Store,
    private hooks: GateHooks,
  ) {}

  answer(requestId: string, a: Answer, now: number): AnswerResult & { grant_id?: string } {
    const store = this.store;
    return store.tx(() => {
      const gr = getGateRequest(store, requestId);
      if (!gr) throw new Error(`no input request ${requestId}`);
      const req = gr.req;
      checkAnswer(req, a);
      const run = getRunRow(store, req.run_id)!;
      const r = a.response;
      if (r.type === "approval" && r.decision === "allow_always") {
        if (!run.task_id) throw new AnswerRejected("invalid", "always allow needs a task to hold the grant");
        const call = req.tool_call_id ? findToolEvent(store, run.thread_id, "tool.call", req.tool_call_id) : null;
        if (!call || !grantCovers(r.grant!, { tool: call.payload.tool, input: contentValue(store, call.payload.input) }))
          throw new AnswerRejected("invalid", "the grant must cover the requested call");
      }
      if (!answerInputRequest(store, requestId, r, a.origin.device_id, now)) {
        const cur = getGateRequest(store, requestId)!.req;
        return { status: "already_resolved" as const, state: cur.state, answered_by: cur.answered_by };
      }
      const grant = r.type === "approval" && r.decision === "allow_always" ? insertGrant(store, run.task_id!, r.grant!, a.origin.device_id, now, requestId) : null;
      appendEvent(store, run.thread_id, run.run_id, "input.resolved", {
        request_id: requestId,
        state: "answered",
        response: r,
        answered_by: a.origin.device_id,
        surface: a.origin.surface,
        via: a.via,
        ...(grant ? { grant_id: grant.grant_id } : {}),
      }, now);
      this.route(run, requestId, now);
      return { status: "applied" as const, ...(grant ? { grant_id: grant.grant_id } : {}) };
    });
  }

  /** After a request left `pending` (answered or expired): deliver it. Inside the caller's tx. */
  route(run: RunRow, requestId: string, now: number): void {
    const live = this.hooks.liveGate(run.run_id, requestId);
    if (live === "waiting") this.store.afterCommit(() => this.hooks.wake(run.run_id, requestId));
    if (live !== null) return;
    const gr = getGateRequest(this.store, requestId)!;
    settleWithoutProcess(this.store, run, gr, now);
    if (requeueIfReady(this.store, run.run_id)) this.store.afterCommit(() => this.hooks.requeued());
  }
}

/**
 * An answered or expired gate request whose process is gone. A deferred call needs nothing now:
 * `claude` asks the gate again on resume. Otherwise the process died during the short wait and
 * `claude` would not re-ask (§5.4 F7), so the call gets its result: the answer to a question, a
 * denial, or, for an approval, "did not run; run it again" while the request stays unapplied as
 * a one-shot approval for the identical call (`oneShotApproval`).
 */
export function settleWithoutProcess(store: Store, run: RunRow, gr: GateRequest, now: number): void {
  const req = gr.req;
  const callId = req.tool_call_id;
  if (gr.deferred_at !== null || gr.applied_at !== null || !callId) return;
  if (!findToolEvent(store, run.thread_id, "tool.call", callId) || findToolEvent(store, run.thread_id, "tool.result", callId)) return;
  const r = req.response;
  if (req.state === "answered" && r?.type === "question" && req.prompt.type === "question") {
    appendEvent(store, run.thread_id, run.run_id, "tool.result", { tool_call_id: callId, status: "ok", output: toContent(store, answerText(req.prompt, r), now) }, now);
    markRequestApplied(store, req.request_id, now);
  } else if (req.state === "answered" && r?.type === "approval" && r.decision !== "deny") {
    appendEvent(store, run.thread_id, run.run_id, "tool.result", { tool_call_id: callId, status: "interrupted_retryable", output: null, error: APPROVED_NOT_RUN_TEXT }, now);
  } else {
    appendEvent(store, run.thread_id, run.run_id, "tool.result", { tool_call_id: callId, status: "denied", output: null, error: denialText(r) }, now);
    markRequestApplied(store, req.request_id, now);
  }
  updateRun(store, run.run_id, { resume_note: mergeNotes(getRunRow(store, run.run_id)!.resume_note, ANSWERED_NOTE) });
}

/** A parked run with nothing left pending goes back to the queue, its held messages released (§5.7). */
export function requeueIfReady(store: Store, runId: string): boolean {
  const run = getRunRow(store, runId)!;
  if (run.state !== "waiting_input" || pendingInputRequests(store, { runId }).length > 0) return false;
  releaseHeldInputs(store, runId);
  setRunState(store, runId, "pending", { resume_reason: run.resume_reason === "ambiguity_resolved" ? "ambiguity_resolved" : "input_answered" });
  return true;
}

/** Canonical JSON: key order does not matter when matching a re-issued call. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** An approval the user gave for a call that never ran, matching this re-issued call exactly. */
export function oneShotApproval(store: Store, runId: string, tool: string, input: unknown): InputRequest | null {
  const want = canonical(input);
  const rows = store.db
    .query<{ request_id: string }, [string]>(
      "SELECT request_id FROM input_requests WHERE run_id = ? AND state = 'answered' AND applied_at IS NULL AND deferred_at IS NULL AND json_extract(prompt, '$.type') = 'approval' AND json_extract(response, '$.decision') IN ('allow', 'allow_always') ORDER BY requested_at, rowid",
    )
    .all(runId);
  for (const { request_id } of rows) {
    const req = getGateRequest(store, request_id)!.req;
    if (req.prompt.type !== "approval" || req.prompt.tool !== tool) continue;
    if (canonical(contentValue(store, req.prompt.input)) === want) return req;
  }
  return null;
}
