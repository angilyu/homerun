import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { AccountStatus, DiagnosticFile, VersionGateStatus, VersionPolicy } from "@homerun/core";
import type { Store } from "../store/store";
import { osName, readSpool } from "./crash";
import { newRedactor, redactLogLine, redactText, type Redactor } from "./scrub";
import { zip } from "./zip";

/**
 * The diagnostic bundle (§11): a zip the user saves and chooses to share. Nothing is uploaded.
 *
 * It holds what explains a misbehaving install, and none of the user's content: versions; the
 * runtime's, shell's and supervisor's logs redacted line by line (`redactLogLine`); the schema
 * version and row counts; the scheduler's timing state with every id hashed; the relay link's
 * state without keys or the account's email; the version policy; spooled crash reports, which are
 * allowlisted already. Every id is hashed with a salt made for this bundle, so lines still
 * correlate inside it but not with another bundle.
 */

/** The tail of each log in the bundle. */
export const LOG_TAIL_BYTES = 2 * 1024 * 1024;

export interface BundleSources {
  store: Store;
  dataDir: string;
  logsDir: string;
  userHome: string;
  now: () => number;
  versions: { runtime: string; build: string; channel: string };
  versionStatus: () => VersionGateStatus | null;
  versionPolicy: () => VersionPolicy | null;
  account: () => AccountStatus | null;
}

export interface BundleFile extends DiagnosticFile {
  data: Uint8Array;
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2) + "\n");

/** The log files the bundle reads, relative to the logs directory, and their names in it. */
const LOGS: Array<{ file: string; name: string; description: string }> = [
  { file: "homerund.log", name: "logs/homerund.log", description: "Runtime and shell log, redacted" },
  { file: "homerund.log.1", name: "logs/homerund.log.1", description: "Previous runtime and shell log, redacted" },
  { file: "supervisor.jsonl", name: "logs/supervisor.jsonl", description: "Runtime status history kept by the shell, redacted" },
];

/** The bundle's contents, redacted, in order. */
export function collect(s: BundleSources): BundleFile[] {
  const r = newRedactor(s.userHome);
  const files: BundleFile[] = [];
  const add = (name: string, description: string, data: Uint8Array) => files.push({ name, description, bytes: data.length, data });

  add("versions.json", "Homerun, OS and architecture versions", json(versions(s)));
  for (const l of LOGS) {
    const text = tail(join(s.logsDir, l.file));
    if (text === null) continue;
    add(l.name, l.description, new TextEncoder().encode(redactLog(text, r)));
  }
  add("database.json", "Schema version and the number of rows in each table; no contents", json(database(s.store)));
  add("scheduler.json", "Schedules' timing and state, ids hashed; no task names or prompts", json(scheduler(s.store, r)));
  add("relay.json", "Remote access link state; no keys, tokens or email", json(relay(s, r)));
  add("version-policy.json", "The minimum-version policy in effect", json({ status: s.versionStatus(), policy: s.versionPolicy() }));
  for (const { path, report } of readSpool(s.dataDir, s.now())) {
    add(`crash-reports/${basename(path)}`, "A crash report: exception type and stack frames only", json(report));
  }
  const manifest = { created_at: new Date(s.now()).toISOString(), files: files.map(({ name, bytes, description }) => ({ name, bytes, description })) };
  files.unshift({ name: "manifest.json", description: "This list", bytes: 0, data: json(manifest) });
  files[0]!.bytes = files[0]!.data.length;
  return files;
}

export function preview(s: BundleSources): DiagnosticFile[] {
  return collect(s).map(({ name, bytes, description }) => ({ name, bytes, description }));
}

export class BundleTargetError extends Error {}

/**
 * Write a new bundle. With no path, a new file in Downloads (or the home folder when there is
 * none). An explicit path must be absolute and new: the save dialog has already asked about
 * replacing a file, and the shell removed it then.
 */
export function create(s: BundleSources, path?: string): { path: string; bytes: number; files: DiagnosticFile[] } {
  if (path !== undefined && (!isAbsolute(path) || !path.endsWith(".zip"))) throw new BundleTargetError("The bundle path must be an absolute path ending in .zip.");
  const files = collect(s);
  const data = zip(files.map((f) => ({ name: f.name, data: f.data })), new Date(s.now()));
  const target = path ?? defaultPath(s.userHome, s.now());
  let fd: number;
  try {
    fd = openSync(target, "wx", 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new BundleTargetError(code === "EEXIST" ? "A file with that name already exists." : code === "ENOENT" ? "That folder doesn't exist." : `Can't write there (${code ?? "error"}).`);
  }
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return { path: target, bytes: data.length, files: files.map(({ name, bytes, description }) => ({ name, bytes, description })) };
}

/** `~/Downloads/homerun-diagnostics-YYYYMMDD-HHMMSS.zip`, with a suffix if that exists. */
export function defaultPath(home: string, now: number): string {
  const downloads = join(home, "Downloads");
  const dir = existsSync(downloads) ? downloads : home;
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  const stem = `homerun-diagnostics-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  for (let i = 0; ; i++) {
    const candidate = join(dir, `${stem}${i ? `-${i}` : ""}.zip`);
    if (!existsSync(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- the files

function versions(s: BundleSources) {
  return {
    homerun: s.versions.runtime,
    build: s.versions.build,
    channel: s.versions.channel,
    os: osName(),
    os_release: release(),
    platform: platform(),
    arch: arch(),
    bun: typeof Bun !== "undefined" ? Bun.version : null,
  };
}

/** The last `LOG_TAIL_BYTES` of a file, starting at a line; null if there is none. */
export function tail(path: string, max = LOG_TAIL_BYTES): string | null {
  try {
    const size = statSync(path).size;
    const buf = readFileSync(path);
    if (size <= max) return buf.toString("utf8");
    const text = buf.subarray(size - max).toString("utf8");
    const nl = text.indexOf("\n");
    return nl < 0 ? "" : text.slice(nl + 1);
  } catch {
    return null;
  }
}

export function redactLog(text: string, r: Redactor): string {
  return text
    .split("\n")
    .map((l) => redactLogLine(l, r))
    .join("\n");
}

function database(store: Store) {
  const db = store.db;
  const schema = db.query<{ version: number; applied_at: number; runtime_version: string; min_reader: number }, []>("SELECT version, applied_at, runtime_version, min_reader FROM schema_version ORDER BY version").all();
  const tables = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((t) => t.name)
    .filter((n) => /^[a-z0-9_]+$/.test(n));
  const rows: Record<string, number> = {};
  for (const t of tables) rows[t] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t}"`).get()!.n;
  return { schema_version: schema.at(-1)?.version ?? null, migrations: schema, rows };
}

function scheduler(store: Store, r: Redactor) {
  const db = store.db;
  const schedules = db
    .query<
      {
        schedule_id: string;
        task_id: string;
        catchup: string;
        max_catchup: number;
        next_fire_at: number | null;
        last_fired_at: number | null;
        enabled: number;
        paused_reason: string | null;
        consecutive_failures: number;
        missed_since_last_run: number;
        interval: number;
      },
      []
    >(
      `SELECT schedule_id, task_id, catchup, max_catchup, next_fire_at, last_fired_at, enabled, paused_reason,
              consecutive_failures, missed_since_last_run, cron LIKE '@every %' AS interval
         FROM schedules ORDER BY next_fire_at`,
    )
    .all();
  const fires = db.query<{ schedule_id: string; state: string; n: number }, []>("SELECT schedule_id, state, count(*) AS n FROM schedule_fires GROUP BY schedule_id, state").all();
  const firesBy = new Map<string, Record<string, number>>();
  for (const f of fires) firesBy.set(f.schedule_id, { ...firesBy.get(f.schedule_id), [f.state]: f.n });
  return {
    schedules: schedules.map((x) => ({
      schedule_id: r.hash(x.schedule_id),
      task_id: r.hash(x.task_id),
      kind: x.interval ? "interval" : "cron",
      catchup: x.catchup,
      max_catchup: x.max_catchup,
      enabled: x.enabled === 1,
      paused_reason: x.paused_reason,
      next_fire_at: iso(x.next_fire_at),
      last_fired_at: iso(x.last_fired_at),
      consecutive_failures: x.consecutive_failures,
      missed_since_last_run: x.missed_since_last_run,
      fires: firesBy.get(x.schedule_id) ?? {},
    })),
    runs: db.query<{ trigger: string; state: string; n: number }, []>("SELECT trigger, state, count(*) AS n FROM runs GROUP BY trigger, state ORDER BY trigger, state").all(),
    runtime_lives: db
      .query<{ started_at: number; last_seen_at: number; stopped_at: number | null }, []>("SELECT started_at, last_seen_at, stopped_at FROM runtime_lives ORDER BY started_at DESC LIMIT 20")
      .all()
      .map((l) => ({ started_at: iso(l.started_at), last_seen_at: iso(l.last_seen_at), stopped_at: iso(l.stopped_at) })),
    downtime: db
      .query<{ start_at: number; end_at: number; cause: string; source: string }, []>("SELECT start_at, end_at, cause, source FROM downtime ORDER BY start_at DESC LIMIT 50")
      .all()
      .map((d) => ({ start_at: iso(d.start_at), end_at: iso(d.end_at), cause: d.cause, source: d.source })),
  };
}

function relay(s: BundleSources, r: Redactor) {
  const a = s.account();
  const devices = s.store.db.query<{ platform: string; n: number }, []>("SELECT platform, count(*) AS n FROM remote_devices GROUP BY platform").all();
  return {
    account: a
      ? {
          state: a.state,
          signed_in_with_email: a.email !== null,
          error: a.error === null ? null : redactText(a.error, r),
          relay: { state: a.relay.state, since: iso(a.relay.since), error: a.relay.error === null ? null : redactText(a.relay.error, r) },
          link_request_pending: a.link_request !== null,
        }
      : null,
    paired_devices: Object.fromEntries(devices.map((d) => [d.platform, d.n])),
  };
}

const iso = (t: number | null | undefined) => (typeof t === "number" ? new Date(t).toISOString() : null);
