import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BLOB_INLINE_MAX_BYTES, type ThreadEvent } from "@homerun/core";
import { Bus } from "../../src/bus";
import { contentValue, toContent } from "../../src/store/content";
import { openDb } from "../../src/store/db";
import { appendEvent, callsWithoutResult, eventsAfter, historyPage } from "../../src/store/events";
import { currentVersion, DatabaseTooNewError, listBackups, migrate, MigrationFailedError, MIGRATIONS, type Migration } from "../../src/store/migrate";
import { createThread, ensureDevice, tryInsertRun, type NewRun } from "../../src/store/rows";
import { SqliteSessionStore } from "../../src/store/session-store";
import { Store } from "../../src/store/store";

let dir = "";
let db: Database | null = null;
afterEach(() => {
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function fresh(): { db: Database; backups: string; store: Store } {
  dir = mkdtempSync(join(tmpdir(), "hr-store-"));
  db = openDb(join(dir, "homerun.db"));
  const backups = join(dir, "backups");
  migrate(db, { backupDir: backups, runtimeVersion: "test" });
  return { db, backups, store: new Store(db, new Bus()) };
}

/** The shipped schema version; test migrations come after it. */
const N = MIGRATIONS.length;
const extra = (n: number, sql = `CREATE TABLE extra_${n} (x INTEGER)`): Migration => ({ version: n, sql });

describe("migrations (§6.3)", () => {
  test("a fresh database is migrated without a backup; a second start is current", () => {
    dir = mkdtempSync(join(tmpdir(), "hr-store-"));
    db = openDb(join(dir, "homerun.db"));
    expect(migrate(db, { backupDir: join(dir, "b"), runtimeVersion: "t" })).toEqual({ status: "migrated", from: 0, to: MIGRATIONS.length, backup: null });
    expect(migrate(db, { backupDir: join(dir, "b"), runtimeVersion: "t" })).toEqual({ status: "current", version: MIGRATIONS.length });
    expect(existsSync(join(dir, "b"))).toBe(false);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  test("upgrading backs up first, chains every pending migration, and keeps the last two backups", () => {
    const { db, backups } = fresh();
    let t = 1000;
    const now = () => t++;
    const v2 = [...MIGRATIONS, extra(N + 1)];
    const r = migrate(db, { backupDir: backups, runtimeVersion: "t", migrations: v2, now });
    expect(r).toMatchObject({ status: "migrated", from: N, to: N + 1 });
    const b = (r as { backup: string }).backup;
    expect(currentVersion(new Database(b, { readonly: true })).version).toBe(N);
    migrate(db, { backupDir: backups, runtimeVersion: "t", migrations: [...v2, extra(N + 2), extra(N + 3)], now });
    expect(currentVersion(db).version).toBe(N + 3);
    migrate(db, { backupDir: backups, runtimeVersion: "t", migrations: [...v2, extra(N + 2), extra(N + 3), extra(N + 4)], now });
    expect(listBackups(backups).map((p) => p.split("/").at(-1)!.split("-")[1])).toEqual([`v${N + 1}`, `v${N + 3}`]);
  });

  test("a failed migration rolls every step back and leaves the version unchanged", () => {
    const { db, backups } = fresh();
    const bad = [...MIGRATIONS, extra(N + 1), extra(N + 2, "CREATE TABLE nope (")];
    expect(() => migrate(db, { backupDir: backups, runtimeVersion: "t", migrations: bad })).toThrow(MigrationFailedError);
    expect(currentVersion(db).version).toBe(N);
    expect(db.query(`SELECT 1 FROM sqlite_master WHERE name = 'extra_${N + 1}'`).get()).toBeNull();
  });

  test("a database newer than the rollback window is refused, naming the backups", () => {
    const { db, backups } = fresh();
    migrate(db, { backupDir: backups, runtimeVersion: "t", migrations: [...MIGRATIONS, extra(N + 1), extra(N + 2), extra(N + 3)] });
    expect(() => migrate(db, { backupDir: backups, runtimeVersion: "t" })).toThrow(DatabaseTooNewError);
    // Within the window it opens.
    const db2 = openDb(join(dir, "second.db"));
    const b2 = join(dir, "b2");
    migrate(db2, { backupDir: b2, runtimeVersion: "t", migrations: [...MIGRATIONS, extra(N + 1)] });
    expect(migrate(db2, { backupDir: b2, runtimeVersion: "t" })).toEqual({ status: "newer_compatible", version: N + 1 });
    db2.close();
  });
});

describe("thread_events", () => {
  test("seq is gap-free per thread; events publish only after commit; a rollback leaves no trace", () => {
    const { store } = fresh();
    const a = createThread(store);
    const b = createThread(store);
    const seen: ThreadEvent[] = [];
    store.bus.subscribeAll((e) => seen.push(e));
    const origin = { device_id: ensureDevice(store).device_id, surface: "desktop" as const };
    const msg = (text: string) => ({ client_msg_id: crypto.randomUUID(), text, origin, disposition: "started_run" as const });
    appendEvent(store, a.thread_id, null, "user.message", msg("1"));
    appendEvent(store, b.thread_id, null, "user.message", msg("1"));
    expect(() =>
      store.tx(() => {
        appendEvent(store, a.thread_id, null, "user.message", msg("2"));
        expect(seen).toHaveLength(2);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    appendEvent(store, a.thread_id, null, "user.message", msg("3"));
    expect(eventsAfter(store, a.thread_id, 0).map((e) => [e.seq, (e.payload as { text: string }).text])).toEqual([
      [1, "1"],
      [2, "3"],
    ]);
    expect(seen.map((e) => e.thread_id)).toEqual([a.thread_id, b.thread_id, a.thread_id]);
    expect(historyPage(store, a.thread_id, undefined, 1)).toMatchObject({ has_more: true, events: [{ seq: 2 }] });
  });

  test("payloads are validated against core; a tool call is recorded once per id", () => {
    const { store } = fresh();
    const t = createThread(store);
    expect(() => appendEvent(store, t.thread_id, null, "user.message", { text: "" } as never)).toThrow();
    const call = { tool_call_id: "toolu_1", tool: "Bash", class: "destructive" as const, input: { kind: "inline" as const, value: {} }, policy: "allowed" as const };
    appendEvent(store, t.thread_id, null, "tool.call", call);
    expect(() => appendEvent(store, t.thread_id, null, "tool.call", call)).toThrow(/UNIQUE/);
    appendEvent(store, t.thread_id, null, "tool.result", { tool_call_id: "toolu_1", status: "ok", output: null });
    expect(() => appendEvent(store, t.thread_id, null, "tool.result", { tool_call_id: "toolu_1", status: "ok", output: null })).toThrow(/UNIQUE/);
    expect(eventsAfter(store, t.thread_id, 0).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("callsWithoutResult finds exactly the calls with no result", () => {
    const { store } = fresh();
    const t = createThread(store);
    const dev = ensureDevice(store);
    const run = tryInsertRun(store, newRun(t.thread_id, dev.device_id))!;
    for (const id of ["a", "b"]) {
      appendEvent(store, t.thread_id, run.run_id, "tool.call", { tool_call_id: id, tool: "Read", class: "read", input: { kind: "inline", value: {} }, policy: "allowed" });
    }
    appendEvent(store, t.thread_id, run.run_id, "tool.result", { tool_call_id: "a", status: "ok", output: null });
    expect(callsWithoutResult(store, run.run_id).map((c) => String(c.payload.tool_call_id))).toEqual(["b"]);
  });
});

function newRun(threadId: string, deviceId: string): NewRun {
  return { threadId, taskId: null, taskVersion: null, deviceId, trigger: "message", originDevice: deviceId, originSurface: "desktop", authority: "full", pool: "session", now: 1 };
}

describe("runs", () => {
  test("one active run per thread: the partial unique index refuses a second (R8)", () => {
    const { store } = fresh();
    const dev = ensureDevice(store);
    const t = createThread(store);
    const first = tryInsertRun(store, newRun(t.thread_id, dev.device_id));
    expect(first).not.toBeNull();
    expect(tryInsertRun(store, newRun(t.thread_id, dev.device_id))).toBeNull();
    // Another thread is unaffected; a finished run frees the thread.
    expect(tryInsertRun(store, newRun(createThread(store).thread_id, dev.device_id))).not.toBeNull();
    store.db.query("UPDATE runs SET state = 'succeeded' WHERE run_id = ?").run(first!.run_id);
    expect(tryInsertRun(store, newRun(t.thread_id, dev.device_id))).not.toBeNull();
  });
});

describe("content and blobs (§6.1)", () => {
  test("up to 4 KB of JSON is inline; more goes to blobs once, by SHA-256, with a preview", () => {
    const { store } = fresh();
    // A JSON string of n characters is n + 2 bytes.
    const atLimit = "x".repeat(BLOB_INLINE_MAX_BYTES - 2);
    expect(toContent(store, atLimit)).toEqual({ kind: "inline", value: atLimit });
    const over = "y".repeat(BLOB_INLINE_MAX_BYTES - 1);
    const c = toContent(store, over);
    expect(c).toMatchObject({ kind: "blob", size: over.length, expired: false });
    expect(c.kind === "blob" && c.preview.length).toBe(500);
    expect(toContent(store, over)).toEqual(c);
    expect(store.db.query("SELECT COUNT(*) AS n FROM blobs").get()).toEqual({ n: 1 });
    expect(contentValue(store, c)).toBe(over);
    const obj = { stdout: "z".repeat(5000), code: 0 };
    expect(contentValue(store, toContent(store, obj))).toEqual(obj);
    expect(toContent(store, undefined)).toEqual({ kind: "inline", value: null });
  });
});

describe("the SDK session store (F1, F2)", () => {
  test("append is idempotent by uuid, keeps order, and separates subagent subpaths", async () => {
    const { db } = fresh();
    const s = new SqliteSessionStore(db);
    const key = { projectKey: "homerun", sessionId: "s1" };
    const e = (uuid: string, n: number) => ({ type: "user", uuid, n }) as never;
    await s.append(key, [e("u1", 1), e("u2", 2)]);
    await s.append(key, [e("u2", 2), e("u3", 3)]);
    await s.append({ ...key, subpath: "subagents/a" }, [e("u9", 9)]);
    expect(((await s.load(key)) ?? []).map((x) => (x as unknown as { n: number }).n)).toEqual([1, 2, 3]);
    expect(await s.listSubkeys(key)).toEqual(["subagents/a"]);
    expect((await s.listSessions("homerun")).map((x) => x.sessionId)).toEqual(["s1"]);
    await s.delete(key);
    expect(await s.load(key)).toBeNull();
    expect(await s.load({ ...key, subpath: "subagents/a" })).toBeNull();
  });
});
