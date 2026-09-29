-- Milestone 6: approvals and questions (§5.5, §5.6).

-- "Always allow" and "Trust this tool": one task, one tool, optionally one argument pattern.
-- The §5.6 columns, plus the request an "Always allow" answer came from (null from settings).
CREATE TABLE tool_grants (
  grant_id      TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  tool          TEXT NOT NULL,
  pattern       TEXT,                     -- command or domain pattern; null = any use of this tool
  class         TEXT NOT NULL,            -- 'read' | 'write' | 'network'; never 'destructive'
  granted_by    TEXT NOT NULL,            -- device_id
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  source_request_id TEXT
);
CREATE INDEX tool_grants_task ON tool_grants(task_id, revoked_at);

-- When the run first ingested untrusted content (§5.5 taint). Written before the call that
-- brings it in is dispatched; a resumed session carries its taint into the next run.
ALTER TABLE runs ADD COLUMN tainted_at INTEGER;

-- An approval or question gates a tool call (§5.6). `applied_at`: the answer was handed to the
-- agent, so an allowed call may have started. `deferred_at`: the agent reported the call
-- deferred (`tool_deferred`), so resuming the session re-asks the gate for it.
ALTER TABLE input_requests ADD COLUMN applied_at INTEGER;
ALTER TABLE input_requests ADD COLUMN deferred_at INTEGER;
CREATE INDEX input_requests_call ON input_requests(tool_call_id);
