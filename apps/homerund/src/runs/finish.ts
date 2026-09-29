import type { Origin, RunError, TerminalRunState } from "@homerun/core";
import { appendEvent, callsWithoutResult } from "../store/events";
import { getRunRow, pendingInputRequests, runErrorJson, setInputRequestState, setRunState, type RunRow } from "../store/rows";
import type { Store } from "../store/store";
import { completeMonitorRun, ensureRunStarted, isQuiet, monitorOutcome } from "../monitors/complete";

/**
 * Put a run in a terminal state and append its single `run.end` (§5.7). Pending input requests
 * are cancelled with `input.resolved`. With `unresolved`, each `tool.call` still without a result
 * gets an error result with that text first, so a finished run leaves no call open.
 *
 * A monitor run also saves its state, settles its fire and records its outcome in the same
 * transaction (§8.3 step 5). One that succeeded with no change writes no thread events.
 */
export function finishRun(
  store: Store,
  runId: string,
  state: TerminalRunState,
  error: RunError | null,
  opts: { now: number; reapPgid?: number | null; unresolved?: string },
): RunRow {
  return store.tx(() => {
    const cur = getRunRow(store, runId)!;
    const quiet = isQuiet(cur, state);
    if (cur.monitor_phase && !quiet) ensureRunStarted(store, cur, opts.now);
    if (opts.unresolved) {
      for (const c of callsWithoutResult(store, runId)) {
        appendEvent(store, cur.thread_id, runId, "tool.result", { tool_call_id: c.payload.tool_call_id, status: "error", output: null, error: opts.unresolved }, opts.now);
      }
    }
    cancelInputRequests(store, cur, opts.now);
    const row = setRunState(store, runId, state, {
      ended_at: opts.now,
      claude_pid: null,
      reap_pgid: opts.reapPgid ?? null,
      error: state === "failed" || state === "abandoned" ? runErrorJson(error) : null,
      outcome: monitorOutcome(cur, state),
      ...(cur.started_at === null && quiet ? { started_at: opts.now } : {}),
    });
    completeMonitorRun(store, row, state, opts.now);
    if (quiet) return row;
    appendEvent(
      store,
      row.thread_id,
      runId,
      "run.end",
      {
        state,
        outcome: row.outcome as "changed" | null,
        error: state === "failed" || state === "abandoned" ? error : null,
        authority: row.authority as "full" | "web_read_only",
        cost_usd: row.cost_usd,
      },
      opts.now,
    );
    return row;
  });
}

export function cancelInputRequests(store: Store, run: RunRow, now: number): void {
  for (const r of pendingInputRequests(store, { runId: run.run_id })) {
    setInputRequestState(store, r.request_id, "cancelled");
    appendEvent(
      store,
      run.thread_id,
      run.run_id,
      "input.resolved",
      { request_id: r.request_id, state: "cancelled", response: null, answered_by: null, surface: null, via: null },
      now,
    );
  }
}

/** `runs.stop_by` holds the JSON Origin of whoever stopped the run. */
export function stopByOf(row: RunRow): Origin | null {
  return row.stop_by ? (JSON.parse(row.stop_by) as Origin) : null;
}
