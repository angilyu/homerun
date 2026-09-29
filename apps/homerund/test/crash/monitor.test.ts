import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isTerminal, type RunState } from "@homerun/core";
import type { MonitorChildArgs } from "./monitor-child";

/**
 * Kill the scheduler at every boundary (design §8.2, §8.4, §16 row 5). A monitor was last checked
 * at 10:05, and Homerun then stayed stopped until 11:05, while the watched file changed. The life
 * under test claims the missed slots (run_all, max 3) and the on-time one, runs each check in
 * turn, acts once on the change, and saves the monitor state. It is SIGKILLed at every SQLite
 * commit and every point around the act's side effect; later lives on the same data dir recover
 * and finish. However the crash fell, each slot is claimed once and runs once, the missed slots
 * are reported once, the act's side effect happens once, and the state advances to the new file.
 */

const CHILD = resolve(import.meta.dir, "monitor-child.ts");
const POOL = Math.max(2, Math.min(8, availableParallelism()));
const TIMEOUT = 600_000;

interface Result {
  code: number | null;
  signal: string | null;
  points: number | null;
  stderr: string;
}

async function life(a: MonitorChildArgs): Promise<Result> {
  const p = Bun.spawn([process.execPath, CHILD, JSON.stringify(a)], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..", "..") });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const m = /\{"points":(\d+)\}/.exec(out);
  return { code: p.exitCode, signal: p.signalCode, points: m ? Number(m[1]) : null, stderr: err };
}

async function pool<T>(items: readonly T[], fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const fresh = () => mkdtempSync(join(tmpdir(), "hr-mcrash-"));
function copyDir(from: string): string {
  const to = fresh();
  for (const f of ["homerun.db", "homerun.db-wal", "homerun.db-shm", "ledger", "work"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f), { recursive: true });
  return to;
}

/** The problems with a settled data dir; [] when every invariant holds. */
function check(dir: string): string[] {
  const problems: string[] = [];
  const ledgerPath = join(dir, "ledger");
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : [];
  const acted = ledger.filter((l) => l.startsWith("report ")).length;
  if (acted !== 1) problems.push(`the act's side effect happened ${acted} times`);

  const db = new Database(join(dir, "homerun.db"), { readonly: true });
  try {
    const all = <T>(q: string) => db.query(q).all() as T[];
    // Normally 10:10–11:00 were missed (the last three caught up) and 11:05 runs on time. A crash
    // after the life began but before it claimed 11:05 leaves Homerun not running at 11:05 too, so
    // that slot is missed and caught up with the two before it.
    const shapes = [
      { fires: ["10:05 schedule", "10:50 catchup", "10:55 catchup", "11:00 catchup", "11:05 schedule"], ran: 2, missed: 11 },
      { fires: ["10:05 schedule", "10:55 catchup", "11:00 catchup", "11:05 catchup"], ran: 1, missed: 12 },
    ];
    const fires = all<{ scheduled_for: number; kind: string; state: string }>("SELECT scheduled_for, kind, state FROM schedule_fires ORDER BY scheduled_for");
    const got = fires.map((f) => `${new Date(f.scheduled_for).toISOString().slice(11, 16)} ${f.kind}${f.state === "done" ? "" : ` ${f.state}`}`);
    const shape = shapes.find((x) => x.fires.join() === got.join());
    if (!shape) problems.push(`fires ${got.join(", ")}`);
    else {
      const cov = all<{ expected: number; ran: number; missed_not_running: number; missed_asleep: number; merged: number }>("SELECT * FROM schedule_coverage");
      const c = cov[0];
      if (cov.length !== 1 || !c || c.expected !== 13 || c.ran !== shape.ran || c.missed_not_running !== shape.missed || c.missed_asleep || c.merged) problems.push(`coverage ${JSON.stringify(cov)}`);
      const missed = all<{ payload: string }>("SELECT payload FROM thread_events WHERE type = 'schedule.missed'").map((e) => JSON.parse(e.payload));
      if (missed.length !== 1 || missed[0].count !== shape.missed || missed[0].caught_up !== 3 || missed[0].reason !== "not_running") problems.push(`schedule.missed ${JSON.stringify(missed)}`);
    }

    const runs = all<{ run_id: string; state: string; outcome: string | null; dedupe_key: string | null }>("SELECT run_id, state, outcome, dedupe_key FROM runs ORDER BY created_at");
    for (const r of runs) {
      if (!isTerminal(r.state as RunState)) problems.push(`run ${r.run_id} is ${r.state}`);
      const n = all<{ n: number }>(`SELECT count(*) AS n FROM thread_events WHERE run_id = '${r.run_id}' AND type = 'run.end'`)[0]!.n;
      const any = all<{ n: number }>(`SELECT count(*) AS n FROM thread_events WHERE run_id = '${r.run_id}'`)[0]!.n;
      if (any && n !== 1) problems.push(`run ${r.run_id} has ${n} run.end`);
    }
    const keys = runs.map((r) => r.dedupe_key).filter(Boolean);
    if (new Set(keys).size !== keys.length) problems.push("two runs share a dedupe key");
    const changed = runs.filter((r) => r.outcome === "changed").length;
    if (changed !== 1) problems.push(`${changed} runs report a change`);
    const unfinished = runs.filter((r) => r.state !== "succeeded").map((r) => r.state);
    if (unfinished.length) problems.push(`runs ended ${unfinished.join(", ")}`);

    const st = all<{ state: string; version: number }>("SELECT state, version FROM monitor_state");
    const hash = createHash("sha256").update(readFileSync(join(dir, "work", "watched.txt"))).digest("hex");
    if (st.length !== 1 || st[0]!.version !== 2 || !st[0]!.state.includes(hash)) problems.push(`monitor state ${JSON.stringify(st)} (file ${hash})`);
  } finally {
    db.close();
  }
  return problems;
}

/** Run lives until one ends on its own; the first is killed at `killAt`. */
async function trial(template: string, lagging: boolean, killAt?: number): Promise<{ dir: string; lives: Result[] }> {
  const dir = copyDir(template);
  const lives: Result[] = [];
  for (let n = 1; n <= 4; n++) {
    const r = await life({ dir, life: n, lagging, ...(n === 1 && killAt ? { killAt } : {}) });
    lives.push(r);
    if (r.signal === "SIGKILL") continue;
    break;
  }
  return { dir, lives };
}

async function sweep(lagging: boolean): Promise<void> {
  const template = fresh();
  const setup = await life({ dir: template, setup: true });
  expect(setup.stderr).toBe("");
  expect(setup.code).toBe(0);

  const clean = await trial(template, lagging);
  expect(clean.lives.map((l) => l.code)).toEqual([0]);
  expect(check(clean.dir)).toEqual([]);
  const total = clean.lives[0]!.points!;
  expect(total).toBeGreaterThan(20);
  rmSync(clean.dir, { recursive: true, force: true });

  const failures: string[] = [];
  await pool(
    Array.from({ length: total }, (_, i) => i + 1),
    async (k) => {
      const t = await trial(template, lagging, k);
      const last = t.lives.at(-1)!;
      if (t.lives[0]!.signal !== "SIGKILL") failures.push(`k=${k}: the first life was not killed (${t.lives[0]!.code})`);
      else if (last.code !== 0) failures.push(`k=${k}: the last life exited ${last.code ?? last.signal}: ${last.stderr.slice(0, 600)}`);
      else for (const p of check(t.dir)) failures.push(`k=${k}: ${p}`);
      rmSync(t.dir, { recursive: true, force: true });
    },
  );
  rmSync(template, { recursive: true, force: true });
  expect(failures).toEqual([]);
}

describe("the scheduler survives a crash at every boundary", () => {
  test("claiming missed and on-time fires, running the checks, acting and saving monitor state", () => sweep(false), TIMEOUT);
  test("the act step with a lagging mirror: nothing of its conversation is stored before its Write", () => sweep(true), TIMEOUT);
});
