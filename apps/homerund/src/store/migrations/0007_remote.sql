-- Milestone 9: remote access (§9.6, §10). Phones and browsers linked to this desktop, and the
-- sealed messages already applied. The device's own keys live in the Keychain or Credential
-- Manager, never here; a copy of this database holds only public keys.
CREATE TABLE remote_devices (
  device_id           TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  platform            TEXT NOT NULL CHECK (platform IN ('ios', 'web')),
  method              TEXT NOT NULL CHECK (method IN ('qr', 'code')),
  static_public_key   TEXT NOT NULL,
  signing_public_key  TEXT NOT NULL,
  paired_at           INTEGER NOT NULL,
  last_seen_at        INTEGER
);

-- Sealed messages opened here, kept until they would have expired anyway (§9.4 replay).
CREATE TABLE sealed_seen (
  msg_id  TEXT PRIMARY KEY,
  until   INTEGER NOT NULL
);
CREATE INDEX sealed_seen_until ON sealed_seen (until);
