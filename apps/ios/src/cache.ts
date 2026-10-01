import type { ThreadSummary } from "@homerun/core";
import { CACHED_THREADS, type CachedThread, type ThreadCache } from "@homerun/app-state";

/**
 * The iPhone's history cache at rest (§9.8): one SQLCipher database (expo-sqlite built with
 * `useSQLCipher`), keyed with 32 random bytes from the Keychain (`WhenUnlockedThisDeviceOnly`),
 * in a file the Complete data-protection class makes unreadable while the phone is locked. It
 * holds each desktop's first thread-list page and each opened thread's newest events, so the app
 * opens to readable history offline; the desktop stays the source of truth. The database is
 * closed when the app leaves the foreground and opened again on use; every failure costs only
 * the head start.
 */

export type SqlValue = string | number | null;

/** The part of expo-sqlite's `SQLiteDatabase` the cache uses; `bun:sqlite` in tests. */
export interface SqlDb {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: SqlValue[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: SqlValue[]): Promise<T | null>;
  closeAsync(): Promise<void>;
}

export interface SqlDriver {
  open(): Promise<SqlDb>;
  /** Deletes the database file. */
  remove(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (desktop TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (desktop TEXT NOT NULL, thread_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (desktop, thread_id));
`;

export class HistoryCache {
  private db: Promise<SqlDb> | null = null;

  /**
   * @param key the SQLCipher key, 64 hex digits
   * @param requireCipher refuse a database that isn't encrypted (true in the app; the tests' SQLite has no cipher)
   */
  constructor(
    private readonly driver: SqlDriver,
    private readonly key: () => Promise<string>,
    private readonly requireCipher = true,
  ) {}

  /** The cache for one desktop's threads. */
  forDesktop(desktopId: string): ThreadCache {
    return {
      loadThread: (id) => this.read<CachedThread>("SELECT data FROM threads WHERE desktop = ? AND thread_id = ?", [desktopId, id]),
      saveThread: (id, t) => this.write("INSERT OR REPLACE INTO threads (desktop, thread_id, data) VALUES (?, ?, ?)", [desktopId, id, JSON.stringify(t)]),
      loadList: () => this.read<ThreadSummary[]>("SELECT data FROM lists WHERE desktop = ?", [desktopId]),
      saveList: async (threads) => {
        const kept = threads.slice(0, CACHED_THREADS);
        await this.write("INSERT OR REPLACE INTO lists (desktop, data) VALUES (?, ?)", [desktopId, JSON.stringify(kept)]);
        // Threads that fell off the first page go: the cache holds what the app opens to.
        const ids = kept.map((t) => t.thread_id);
        await this.write(`DELETE FROM threads WHERE desktop = ? AND thread_id NOT IN (${ids.map(() => "?").join(",")})`, [desktopId, ...ids]);
      },
    };
  }

  /** Forgets one desktop's history (after unpairing it). */
  async forget(desktopId: string): Promise<void> {
    await this.write("DELETE FROM lists WHERE desktop = ?", [desktopId]);
    await this.write("DELETE FROM threads WHERE desktop = ?", [desktopId]);
  }

  /** Closes the file; the next use opens it again. */
  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (db) await db.then((d) => d.closeAsync()).catch(() => {});
  }

  /** Deletes the database (sign-out as a different person, account deletion). */
  async wipe(): Promise<void> {
    await this.close();
    await this.driver.remove().catch(() => {});
  }

  private open(): Promise<SqlDb> {
    this.db ??= (async () => {
      const db = await this.driver.open();
      try {
        const key = await this.key();
        if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("bad cache key");
        // A raw key: SQLCipher skips its key derivation. Must be the first statement.
        await db.execAsync(`PRAGMA key = "x'${key}'";`);
        if (this.requireCipher && !(await db.getFirstAsync<{ cipher_version: string }>("PRAGMA cipher_version", []))) throw new Error("the cache isn't encrypted");
        await db.execAsync(SCHEMA);
        return db;
      } catch (e) {
        await db.closeAsync().catch(() => {});
        throw e;
      }
    })();
    const opening = this.db;
    // A failed open is retried on the next use.
    opening.catch(() => {
      if (this.db === opening) this.db = null;
    });
    return opening;
  }

  private async read<T>(sql: string, params: SqlValue[]): Promise<T | null> {
    try {
      const row = await (await this.open()).getFirstAsync<{ data: string }>(sql, params);
      return row ? (JSON.parse(row.data) as T) : null;
    } catch {
      return null;
    }
  }

  private async write(sql: string, params: SqlValue[]): Promise<void> {
    try {
      await (await this.open()).runAsync(sql, params);
    } catch {
      // best effort: see `ThreadCache`
    }
  }
}
