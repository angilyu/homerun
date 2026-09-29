-- Milestone 7: per-device read markers for unread counts (§9.8 thread list).
-- A device has read a thread up to `seq`. Unread = assistant messages and input requests after it.
CREATE TABLE read_markers (
  thread_id     TEXT NOT NULL REFERENCES threads(thread_id),
  device_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (thread_id, device_id)
);

-- Threads that existed before this version count as read on this device, so an upgrade does
-- not mark every old thread unread.
INSERT INTO read_markers (thread_id, device_id, seq, updated_at)
  SELECT t.thread_id, d.device_id, t.last_seq, t.updated_at FROM threads t, (SELECT device_id FROM device LIMIT 1) d;
