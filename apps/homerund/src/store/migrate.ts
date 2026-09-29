import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import m0001 from "./migrations/0001_initial.sql" with { type: "text" };
import m0002 from "./migrations/0002_resume_at.sql" with { type: "text" };
import m0003 from "./migrations/0003_scheduler.sql" with { type: "text" };

/**
 * Forward-only, chained migrations (§6.3). Migration `i` takes the schema from version i-1 to i.
 * `minReader` is the oldest runtime schema that can still open the result; by default two
 * versions back (the expand/contract rollback window). A contract migration sets it higher.
 */
export interface Migration {
  version: number;
  sql: string;
  minReader?: number;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: m0001 },
  { version: 2, sql: m0002 },
  { version: 3, sql: m0003 },
];

export const SCHEMA_VERSION = MIGRATIONS.length;
export const BACKUPS_KEPT = 2;
/** A runtime opens a database at most this many versions newer than its own (§6.3). */
export const ROLLBACK_WINDOW = 2;

export type MigrateOutcome =
  | { status: "current"; version: number }
  | { status: "migrated"; from: number; to: number; backup: string | null }
  | { status: "newer_compatible"; version: number };

export class DatabaseTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly minReader: number,
    readonly ours: number,
    readonly backups: string[],
  ) {
    super(
      `This database was upgraded by a newer version of Homerun (schema ${dbVersion}, needs at least ${minReader}; this version reads ${ours}). ` +
        `Update Homerun, or restore a backup from before the upgrade${backups.length ? `: ${backups.join(", ")}` : ""} (activity since the upgrade would be lost).`,
    );
    this.name = "DatabaseTooNewError";
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    cause: unknown,
  ) {
    super(`migration ${version} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MigrationFailedError";
  }
}

const BOOTSTRAP = `CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  runtime_version TEXT NOT NULL,
  min_reader INTEGER NOT NULL
)`;

export function currentVersion(db: Database): { version: number; minReader: number } {
  const has = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get();
  if (!has) return { version: 0, minReader: 0 };
  const row = db.query<{ version: number; min_reader: number }, []>("SELECT version, min_reader FROM schema_version ORDER BY version DESC LIMIT 1").get();
  return row ? { version: row.version, minReader: row.min_reader } : { version: 0, minReader: 0 };
}

export function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((f) => /^homerun-v\d+-\d+\.db$/.test(f))
    .sort((a, b) => Number(a.split("-")[2]!.slice(0, -3)) - Number(b.split("-")[2]!.slice(0, -3)))
    .map((f) => join(backupDir, f));
}

/** Consistent copy of a live database (bun:sqlite has no online-backup API; VACUUM INTO is equivalent here). */
function backup(db: Database, backupDir: string, fromVersion: number, now: number): string {
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  let path = join(backupDir, `homerun-v${fromVersion}-${now}.db`);
  for (let n = now + 1; existsSync(path); n++) path = join(backupDir, `homerun-v${fromVersion}-${n}.db`);
  db.query("VACUUM INTO ?").run(path);
  const all = listBackups(backupDir);
  for (const old of all.slice(0, Math.max(0, all.length - BACKUPS_KEPT))) {
    if (basename(old) !== basename(path)) rmSync(old, { force: true });
  }
  return path;
}

export interface MigrateOptions {
  backupDir: string;
  runtimeVersion: string;
  migrations?: readonly Migration[];
  now?: () => number;
}

/**
 * Bring the database to this runtime's schema, before serving and before any run (§6.3):
 * refuse outside the rollback window, back up, then apply every pending migration in one
 * transaction. A failure rolls everything back.
 */
export function migrate(db: Database, opts: MigrateOptions): MigrateOutcome {
  const migrations = opts.migrations ?? MIGRATIONS;
  const target = migrations.length;
  const now = opts.now ?? Date.now;
  const { version, minReader } = currentVersion(db);

  if (version > target) {
    if (target < minReader || version > target + ROLLBACK_WINDOW) {
      throw new DatabaseTooNewError(version, Math.max(minReader, version - ROLLBACK_WINDOW), target, listBackups(opts.backupDir));
    }
    return { status: "newer_compatible", version };
  }
  if (version === target) return { status: "current", version };

  // A brand-new database has nothing worth backing up.
  const empty = version === 0 && !db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
  const backupPath = empty ? null : backup(db, opts.backupDir, version, now());

  let applying = version + 1;
  try {
    db.transaction(() => {
      db.exec(BOOTSTRAP);
      for (; applying <= target; applying++) {
        const m = migrations[applying - 1]!;
        if (m.version !== applying) throw new Error(`migration list out of order at ${applying}`);
        db.exec(m.sql);
        db.query("INSERT INTO schema_version (version, applied_at, runtime_version, min_reader) VALUES (?, ?, ?, ?)").run(
          m.version,
          now(),
          opts.runtimeVersion,
          m.minReader ?? Math.max(1, m.version - ROLLBACK_WINDOW),
        );
      }
    }).immediate();
  } catch (e) {
    throw new MigrationFailedError(applying, e);
  }
  return { status: "migrated", from: version, to: target, backup: backupPath };
}
