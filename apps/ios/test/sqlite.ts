import { Database } from "bun:sqlite";
import type { SqlDb, SqlDriver } from "../src/cache";

/** The cache's driver over `bun:sqlite` (no SQLCipher: `PRAGMA key` is ignored, `cipher_version` is empty). */
export function bunDriver(path = ":memory:"): SqlDriver & { opened: number; db: Database | null } {
  const d = {
    opened: 0,
    db: null as Database | null,
    async open(): Promise<SqlDb> {
      // An in-memory database lives as long as its handle: keep one across reopenings.
      const db = path === ":memory:" ? (d.db ??= new Database(path)) : new Database(path);
      d.opened++;
      return {
        execAsync: async (sql) => void db.exec(sql),
        runAsync: async (sql, params) => db.query(sql).run(...params),
        getFirstAsync: async <T,>(sql: string, params: (string | number | null)[]) => (db.query(sql).get(...params) as T | null) ?? null,
        closeAsync: async () => {
          if (path !== ":memory:") db.close();
        },
      };
    },
    async remove() {
      d.db?.close();
      d.db = null;
    },
  };
  return d;
}
