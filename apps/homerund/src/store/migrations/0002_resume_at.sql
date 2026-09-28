-- Milestone 4 (§5.4): the transcript point a run resumes at when a "Did this happen?" answer
-- falls back to truncation. NULL resumes at the end of the transcript.
ALTER TABLE runs ADD COLUMN resume_at TEXT;
