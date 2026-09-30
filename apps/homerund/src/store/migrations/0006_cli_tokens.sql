-- Milestone 8a: command-line access (§5.2). One row per approved CLI.
-- The runtime keeps only the SHA-256 of the token, never the token: a token is 256 random bits,
-- so a fast hash is enough, and a copy of this database authenticates nothing.
CREATE TABLE cli_tokens (
  token_id        TEXT PRIMARY KEY,
  token_sha256    TEXT NOT NULL UNIQUE,
  client_name     TEXT NOT NULL,
  client_version  TEXT NOT NULL,
  hostname        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  revoked_at      INTEGER
);
