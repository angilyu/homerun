-- Milestone 2: the §6 tables the runtime needs now. Later milestones add schedules, monitor_state
-- and tool_grants as new migrations. Columns marked "internal" are runtime bookkeeping that never
-- leaves homerund; the core types (packages/core) are what clients see.

CREATE TABLE device (
  device_id     TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  account_id    TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  task_id       TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES device(device_id),
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL,
  spec          TEXT NOT NULL,
  archived_at   INTEGER,
  created_at    INTEGER NOT NULL          -- internal: list order
);

CREATE TABLE task_versions (
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  version       INTEGER NOT NULL,
  spec          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (task_id, version)
);

CREATE TABLE threads (
  thread_id     TEXT PRIMARY KEY,
  task_id       TEXT REFERENCES tasks(task_id),
  title         TEXT,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX threads_task ON threads(task_id);

CREATE TABLE runs (
  run_id        TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  task_id       TEXT,
  task_version  INTEGER,
  sdk_session_id TEXT,
  device_id     TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  origin_device TEXT,
  authority     TEXT NOT NULL,
  scheduled_for INTEGER,
  dedupe_key    TEXT NOT NULL,
  attempt       INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL,
  started_at    INTEGER,
  ended_at      INTEGER,
  outcome       TEXT,
  error         TEXT,                     -- JSON RunError
  check_result  TEXT,                     -- JSON CheckResult (monitors)
  cost_usd      REAL,
  claude_pid    INTEGER,
  -- internal
  created_at    INTEGER NOT NULL,         -- queue order (FIFO), newest-first listing
  pool          TEXT NOT NULL,            -- 'session' | 'monitor' (§5.3 concurrency)
  origin_surface TEXT,                    -- surface of origin_device, for run.started
  claude_boot   INTEGER,                  -- boot time when claude_pid was recorded (PID-reuse guard)
  claude_started_at INTEGER,              -- when the group leader was spawned (PID-reuse guard)
  reap_pgid     INTEGER,                  -- group of a finished run still exiting; killed at startup if alive
  resume_count  INTEGER NOT NULL DEFAULT 0,
  resume_reason TEXT,                     -- set while requeued for a resume, e.g. runtime_restart
  resume_note   TEXT,                     -- continuation message for the next start
  stop_requested_at INTEGER,
  stop_by       TEXT,                     -- JSON Origin of the stop request; null when the runtime stopped it
  sdk_cost_baseline REAL,                 -- the session's total_cost_usd before this run
  sdk_cost_total REAL,                    -- latest total_cost_usd reported during this run
  UNIQUE (dedupe_key)
);

-- At most one active run per thread (§5.7). Starting a run is an INSERT that wins or fails here.
CREATE UNIQUE INDEX one_active_run_per_thread ON runs(thread_id)
  WHERE state IN ('pending', 'running', 'waiting_input');
CREATE INDEX runs_state ON runs(state, pool, created_at);
CREATE INDEX runs_thread ON runs(thread_id, created_at);

CREATE TABLE thread_events (
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  seq           INTEGER NOT NULL,
  run_id        TEXT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);
CREATE INDEX thread_events_run ON thread_events(run_id, type);
-- Every tool call is recorded once, before dispatch, and gets at most one result (§5.4).
CREATE UNIQUE INDEX thread_events_tool_call ON thread_events(thread_id, json_extract(payload, '$.tool_call_id'))
  WHERE type = 'tool.call';
CREATE UNIQUE INDEX thread_events_tool_result ON thread_events(thread_id, json_extract(payload, '$.tool_call_id'))
  WHERE type = 'tool.result';
-- messages.send is idempotent on client_msg_id.
CREATE UNIQUE INDEX thread_events_client_msg ON thread_events(thread_id, json_extract(payload, '$.client_msg_id'))
  WHERE type = 'user.message';

CREATE TABLE blobs (
  sha256        TEXT PRIMARY KEY,
  bytes         BLOB NOT NULL,
  size          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER
);

-- Internal: user input for a run and whether claude has consumed it, so a message pushed just
-- before a crash is delivered again on resume, and held messages wait for the answer (§5.7).
CREATE TABLE run_inputs (
  uuid          TEXT PRIMARY KEY,         -- client_msg_id for user messages
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  held          INTEGER NOT NULL DEFAULT 0,
  text          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);
CREATE INDEX run_inputs_run ON run_inputs(run_id, created_at);

CREATE TABLE sdk_transcripts (
  project_key   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  subpath       TEXT NOT NULL DEFAULT '',
  seq           INTEGER NOT NULL,
  uuid          TEXT,
  entry         TEXT NOT NULL,
  PRIMARY KEY (project_key, session_id, subpath, seq)
);
CREATE UNIQUE INDEX sdk_transcripts_uuid
  ON sdk_transcripts(project_key, session_id, subpath, uuid)
  WHERE uuid IS NOT NULL;

-- Session summaries for the SDK's SessionStore.listSessionSummaries, folded on append.
CREATE TABLE sdk_session_summaries (
  project_key   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  mtime         INTEGER NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (project_key, session_id)
);

CREATE TABLE input_requests (
  request_id    TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(run_id),
  kind          TEXT NOT NULL,
  tool_call_id  TEXT,
  prompt        TEXT NOT NULL,
  state         TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  expires_at    INTEGER,
  answered_at   INTEGER,
  response      TEXT,
  answered_by   TEXT
);
CREATE INDEX input_requests_run ON input_requests(run_id, state);
CREATE INDEX input_requests_state ON input_requests(state, requested_at);
