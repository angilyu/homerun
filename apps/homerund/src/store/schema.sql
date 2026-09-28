-- Subset of docs/design.md §6 needed by milestone 0.
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Backing store for the Agent SDK's sessionStore adapter (§5.3).
CREATE TABLE IF NOT EXISTS sdk_transcripts (
  project_key   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  subpath       TEXT NOT NULL DEFAULT '',
  seq           INTEGER NOT NULL,
  uuid          TEXT,                      -- spike addition: idempotency key for SDK retries
  entry         TEXT NOT NULL,
  PRIMARY KEY (project_key, session_id, subpath, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS sdk_transcripts_uuid
  ON sdk_transcripts(project_key, session_id, subpath, uuid) WHERE uuid IS NOT NULL;

-- Spike addition: incrementally folded summaries for listSessionSummaries().
CREATE TABLE IF NOT EXISTS sdk_session_summaries (
  project_key   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  mtime         INTEGER NOT NULL,
  data          TEXT NOT NULL,
  PRIMARY KEY (project_key, session_id)
);

CREATE TABLE IF NOT EXISTS thread_events (
  thread_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  run_id        TEXT,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  PRIMARY KEY (thread_id, seq)
);

CREATE TABLE IF NOT EXISTS input_requests (
  request_id    TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
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

-- Minimal run registry for the spike runtime (subset of §6 `runs`).
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  status        TEXT NOT NULL,             -- queued | running | completed | failed
  session_id    TEXT,
  prompt        TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  runtime_pid   INTEGER,
  runtime_version TEXT,
  resumes       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  result        TEXT
);
