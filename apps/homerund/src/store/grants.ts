import { randomUUID } from "node:crypto";
import { ToolGrant, type GrantProposal } from "@homerun/core";
import type { Store } from "./store";

/** `tool_grants` (§5.6): "Always allow" and "Trust this tool", one task and one tool each. */

interface GrantRow {
  grant_id: string;
  task_id: string;
  tool: string;
  pattern: string | null;
  class: string;
  granted_by: string;
  granted_at: number;
  revoked_at: number | null;
  source_request_id: string | null;
}

function toGrant(r: GrantRow): ToolGrant {
  const { source_request_id: _s, ...g } = r;
  return ToolGrant.parse(g);
}

export function listGrants(store: Store, taskId: string, includeRevoked = false): ToolGrant[] {
  return store.db
    .query<GrantRow, [string]>(`SELECT * FROM tool_grants WHERE task_id = ? ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY granted_at, rowid`)
    .all(taskId)
    .map(toGrant);
}

export function getGrant(store: Store, grantId: string): ToolGrant | null {
  const r = store.db.query<GrantRow, [string]>("SELECT * FROM tool_grants WHERE grant_id = ?").get(grantId);
  return r ? toGrant(r) : null;
}

/**
 * Add a grant. An identical active grant (same tool, pattern and class) is returned instead of
 * a duplicate, so answering twice or re-trusting a tool leaves one row.
 */
export function insertGrant(store: Store, taskId: string, p: GrantProposal, grantedBy: string, now: number, sourceRequestId: string | null = null): ToolGrant {
  return store.tx(() => {
    const same = store.db
      .query<GrantRow, [string, string, string, string | null]>(
        "SELECT * FROM tool_grants WHERE task_id = ? AND tool = ? AND class = ? AND pattern IS ? AND revoked_at IS NULL LIMIT 1",
      )
      .get(taskId, p.tool, p.class, p.pattern);
    if (same) return toGrant(same);
    const g = ToolGrant.parse({ grant_id: randomUUID(), task_id: taskId, tool: p.tool, pattern: p.pattern, class: p.class, granted_by: grantedBy, granted_at: now, revoked_at: null });
    store.db
      .query("INSERT INTO tool_grants (grant_id, task_id, tool, pattern, class, granted_by, granted_at, revoked_at, source_request_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)")
      .run(g.grant_id, g.task_id, g.tool, g.pattern, g.class, g.granted_by, g.granted_at, sourceRequestId);
    return g;
  });
}

/** Revoke a grant; returns when it was revoked (the first revocation's time if already revoked). */
export function revokeGrant(store: Store, grantId: string, now: number): number | null {
  return store.tx(() => {
    store.db.query("UPDATE tool_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(now, grantId);
    return store.db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM tool_grants WHERE grant_id = ?").get(grantId)?.revoked_at ?? null;
  });
}
