-- Milestone 5: the scheduler and monitors (§6, §8).

-- One per monitor (v1 allows one schedule per monitor). The §6 columns, plus scheduler
-- bookkeeping. `cron` holds `@every <n>m` for an interval schedule (core's scheduleCronColumn);
-- an interval's `timezone` is the device's at the time it was set, for coverage days only.
CREATE TABLE schedules (
  schedule_id   TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  cron          TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  catchup       TEXT NOT NULL,
  max_catchup   INTEGER NOT NULL DEFAULT 1,
  next_fire_at  INTEGER,
  last_fired_at INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  spec          TEXT NOT NULL,            -- JSON ScheduleSpec
  anchor_at     INTEGER NOT NULL,         -- interval schedules count elapsed time from here
  last_evaluated_at INTEGER NOT NULL,     -- slots up to here have been claimed or recorded as missed
  paused_reason TEXT,                     -- 'user' | 'failures' | 'budget_cap' | 'archived'
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  missed_since_last_run INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX schedules_task ON schedules(task_id);

-- The monitor's explicit saved state (§8.3). `state` is null after a reset.
CREATE TABLE monitor_state (
  task_id       TEXT PRIMARY KEY REFERENCES tasks(task_id),
  state         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  last_run_id   TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Per schedule, per day in its timezone (§8.4). `merged` counts fires merged into a later one.
CREATE TABLE schedule_coverage (
  schedule_id        TEXT NOT NULL REFERENCES schedules(schedule_id),
  day                TEXT NOT NULL,
  expected           INTEGER NOT NULL DEFAULT 0,
  ran                INTEGER NOT NULL DEFAULT 0,
  missed_asleep      INTEGER NOT NULL DEFAULT 0,
  missed_not_running INTEGER NOT NULL DEFAULT 0,
  merged             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (schedule_id, day)
);

-- Internal: the durable claim of one fire. The primary key makes a slot claimable once, so a
-- crash between claiming and running can neither lose nor repeat it. Retries are new attempts of
-- the same fire (runs.dedupe_key = 'fire:<schedule_id>:<scheduled_for>:<attempt>').
CREATE TABLE schedule_fires (
  schedule_id   TEXT NOT NULL REFERENCES schedules(schedule_id),
  scheduled_for INTEGER NOT NULL,
  kind          TEXT NOT NULL,            -- 'schedule' (on time) | 'catchup'
  state         TEXT NOT NULL,            -- 'queued' | 'started' | 'done' | 'failed' | 'merged' | 'cancelled'
  attempt       INTEGER NOT NULL DEFAULT 0,
  run_id        TEXT,                     -- the current attempt's run
  not_before    INTEGER,                  -- a retry waits until then (§5.3 backoff)
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (schedule_id, scheduled_for)
);
CREATE INDEX schedule_fires_state ON schedule_fires(state, schedule_id, scheduled_for);

-- Internal: when the computer was asleep or Homerun was not running (§8.4).
CREATE TABLE downtime (
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  cause         TEXT NOT NULL,            -- 'asleep' | 'not_running'
  source        TEXT NOT NULL,            -- 'os' (shell notification) | 'gap' (missed ticks) | 'restart'
  PRIMARY KEY (start_at, cause)
);

-- Internal: each runtime life, so the next start knows how long Homerun was not running.
CREATE TABLE runtime_lives (
  started_at    INTEGER PRIMARY KEY,
  last_seen_at  INTEGER NOT NULL,
  stopped_at    INTEGER
);

-- Daily health digests as generated (§8.3).
CREATE TABLE health_digests (
  to_at         INTEGER PRIMARY KEY,
  from_at       INTEGER NOT NULL,
  generated_at  INTEGER NOT NULL,
  digest        TEXT NOT NULL             -- JSON HealthDigest
);

-- Internal: small runtime settings, JSON values ('health' → HealthSettings).
CREATE TABLE app_settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- Monitor runs (§8.3): which step the run is in, the check's own SDK session (never the act's),
-- and the monitor_state version the check read, so an edit made meanwhile wins.
ALTER TABLE runs ADD COLUMN monitor_phase TEXT;       -- 'rule_check' | 'model_check' | 'act'; null otherwise
ALTER TABLE runs ADD COLUMN check_session_id TEXT;
ALTER TABLE runs ADD COLUMN state_version INTEGER;
