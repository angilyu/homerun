/**
 * The relay core's storage: a small synchronous SQL interface that both the Durable Object's
 * SQLite (`ctx.storage.sql`) and `bun:sqlite` satisfy. Bindings are strings, numbers and null.
 */

export type SqlValue = string | number | null;

export interface Sql {
  all<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
  run(query: string, ...params: SqlValue[]): void;
  /** Runs `f` atomically. */
  tx<T>(f: () => T): T;
}

export const one = <T>(rows: T[]): T | null => rows[0] ?? null;

/**
 * §10.7's tables, per account. The account itself is the storage (one Durable Object per
 * account), so `accounts` is the single `meta` row `account`. Push tokens and the message
 * queue live beside it; nothing here is readable content.
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
    `CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      static_public_key TEXT NOT NULL,
      signing_public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    )`,
    `CREATE TABLE links (
      desktop_device_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      statement TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (desktop_device_id, device_id)
    )`,
    `CREATE INDEX links_device ON links (device_id)`,
    `CREATE TABLE push_tokens (
      device_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      environment TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE queue (
      id TEXT PRIMARY KEY,
      msg_id TEXT NOT NULL,
      to_device_id TEXT NOT NULL,
      from_device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      envelope TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (to_device_id, msg_id)
    )`,
    `CREATE INDEX queue_expiry ON queue (expires_at)`,
    `CREATE TABLE pushed (
      to_device_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (to_device_id, msg_id)
    )`,
    `CREATE TABLE offers (offer TEXT PRIMARY KEY, desktop_device_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    `CREATE TABLE rendezvous (
      session TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      initiator TEXT NOT NULL,
      responder TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE rate (k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, n INTEGER NOT NULL)`,
  ],
];

export function migrate(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)`);
  const current = one(sql.all<{ v: number }>(`SELECT v FROM schema_version`))?.v ?? 0;
  if (current >= MIGRATIONS.length) return;
  sql.tx(() => {
    for (const step of MIGRATIONS.slice(current)) for (const s of step) sql.run(s);
    sql.run(`DELETE FROM schema_version`);
    sql.run(`INSERT INTO schema_version (v) VALUES (?)`, MIGRATIONS.length);
  });
}

/** Drops everything (account deletion, in adapters without `deleteAll`). */
export function dropAll(sql: Sql): void {
  const tables = sql.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`);
  sql.tx(() => {
    for (const t of tables) sql.run(`DROP TABLE IF EXISTS "${t.name}"`);
  });
}
