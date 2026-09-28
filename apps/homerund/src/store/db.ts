import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

/**
 * Open the runtime database. homerund is the only writer (§5.7); bun:sqlite is synchronous, so
 * each transaction is atomic with respect to everything else in the process.
 */
export function openDb(path: string): Database {
  const fresh = path === ":memory:" || !existsSync(path);
  const db = new Database(path, { create: true, strict: true });
  // auto_vacuum only takes effect before the first table is created (§6.1 retention frees pages).
  if (fresh) db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** Run `fn` in a write transaction (BEGIN IMMEDIATE). Nested calls join the outer transaction. */
export function tx<T>(db: Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}
