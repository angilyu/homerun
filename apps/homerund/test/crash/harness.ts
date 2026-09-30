import { expect } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isTerminal, undeliveredMessages, type RunState, type ThreadEvent } from "@homerun/core";
import { Bus } from "../../src/bus";
import { NOT_RUN_TEXT } from "../../src/runs/resume";
import { Store } from "../../src/store/store";
import { chainEntries, chainTo, chainTools } from "../../src/store/transcript";
import { crashSeed, sampleBoundaries, sampleItems, sweepMode } from "./sampler";
import { CLIENT_MSG_ID, HELD_MSG_ID, SCENARIOS, type ChildArgs } from "./scenarios";
import { INTERRUPTED, NO_EFFECT } from "./sim-claude";

/** The crash sweep shared by crash.test.ts and approval.test.ts (§16.2). */

const CHILD = resolve(import.meta.dir, "child.ts");
export const MODE = sweepMode();
export const SEED = crashSeed();
/** In `sample` mode: boundaries per phase of a sweep, and how many ambiguous first crashes get a second. */
export interface Budget {
  kill: number;
  die: number;
  secondAfter: number;
  second: number;
}
const POOL = Math.max(2, Math.min(8, availableParallelism()));
export const TIMEOUT = 600_000;

interface ChildResult {
  code: number | null;
  signal: string | null;
  points: number | null;
  kinds: string[] | null;
  stderr: string;
}

async function life(a: ChildArgs): Promise<ChildResult> {
  const p = Bun.spawn([process.execPath, CHILD, JSON.stringify(a)], { stdout: "pipe", stderr: "pipe", cwd: resolve(import.meta.dir, "..", "..") });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  const m = /^\{"points":.*\}$/m.exec(out);
  const r = m ? (JSON.parse(m[0]) as { points: number; kinds?: string[] }) : null;
  return { code: p.exitCode, signal: p.signalCode, points: r?.points ?? null, kinds: r?.kinds ?? null, stderr: err };
}

/** The kind of each boundary of a life on `dir`, which is used up. */
async function boundaryKinds(a: ChildArgs): Promise<string[]> {
  const r = await life({ ...a, label: true });
  rmSync(a.dir, { recursive: true, force: true });
  expect(r.code).toBe(0);
  expect(r.kinds?.length).toBe(r.points!);
  return r.kinds!;
}

async function pool<T>(items: readonly T[], fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(POOL, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

const fresh = () => mkdtempSync(join(tmpdir(), "hr-crash-"));

/** A copy of a crashed data dir: the database and the ledger (the runtime recreates the rest). */
function copyDir(from: string): string {
  const to = fresh();
  for (const f of ["homerun.db", "homerun.db-wal", "homerun.db-shm", "ledger"]) if (existsSync(join(from, f))) cpSync(join(from, f), join(to, f));
  return to;
}

/** The problems with a settled data dir; [] when every invariant holds. */
function check(dir: string, scenario: string): string[] {
  const plan = SCENARIOS[scenario]!.plan;
  const problems: string[] = [];
  const ledgerPath = join(dir, "ledger");
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean) : [];
  const happened = new Set(ledger.map((l) => l.split(" ")[1]!));
  for (const s of plan) {
    if (NO_EFFECT.has(s.tool)) continue;
    const n = ledger.filter((l) => l.startsWith(`${s.name} `)).length;
    if (n !== 1) problems.push(`${s.name} happened ${n} times`);
  }

  const db = new Database(join(dir, "homerun.db"), { readonly: true });
  try {
    const store = new Store(db, new Bus());
    const count = (q: string, ...a: string[]) => (db.query(q).get(...a) as { n: number }).n;
    const threads = db.query<{ thread_id: string }, []>("SELECT thread_id FROM threads WHERE task_id IS NOT NULL").all();
    if (threads.length !== 1) return [...problems, `${threads.length} task threads`];
    const threadId = threads[0]!.thread_id;
    const runs = db.query<{ run_id: string; state: string; sdk_session_id: string | null }, [string]>("SELECT run_id, state, sdk_session_id FROM runs WHERE thread_id = ? ORDER BY created_at").all(threadId);
    if (!runs.length) problems.push("no run");
    for (const r of runs) {
      if (!isTerminal(r.state as RunState)) problems.push(`run ${r.run_id} is ${r.state}`);
      const ends = count("SELECT COUNT(*) AS n FROM thread_events WHERE run_id = ? AND type = 'run.end'", r.run_id);
      if (ends !== 1) problems.push(`run ${r.run_id} has ${ends} run.end`);
    }
    if (runs.at(-1)?.state !== "succeeded") problems.push(`the last run ended ${runs.at(-1)?.state}`);

    const calls = db.query<{ id: string; tool: string }, [string]>("SELECT json_extract(payload, '$.tool_call_id') AS id, json_extract(payload, '$.tool') AS tool FROM thread_events WHERE thread_id = ? AND type = 'tool.call'").all(threadId);
    for (const c of calls) {
      const n = count("SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ? AND type = 'tool.result' AND json_extract(payload, '$.tool_call_id') = ?", threadId, c.id);
      if (n !== 1) problems.push(`call ${c.tool} ${c.id} has ${n} results`);
    }
    const asked = db.query<{ id: string }, [string]>("SELECT json_extract(payload, '$.request_id') AS id FROM thread_events WHERE thread_id = ? AND type = 'input.requested'").all(threadId);
    for (const a of asked) {
      const n = count("SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ? AND type = 'input.resolved' AND json_extract(payload, '$.request_id') = ?", threadId, a.id);
      if (n !== 1) problems.push(`request ${a.id} resolved ${n} times`);
    }
    // Local notifications (§8.2): only for requests that committed, at most once per key per life.
    const notifiedPath = join(dir, "notified.ndjson");
    const notified = existsSync(notifiedPath)
      ? readFileSync(notifiedPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { life: number; method: string; key: string })
      : [];
    const perLife = new Set<string>();
    for (const n of notified) {
      if (n.method !== "notification.requested") continue;
      if (perLife.has(`${n.life} ${n.key}`)) problems.push(`notification ${n.key} sent twice in one life`);
      perLife.add(`${n.life} ${n.key}`);
      const id = n.key.startsWith("input:") ? n.key.slice("input:".length) : null;
      if (id && !count("SELECT COUNT(*) AS n FROM input_requests WHERE request_id = ?", id)) problems.push(`notification for request ${id}, which never committed`);
    }
    const pending = count("SELECT COUNT(*) AS n FROM input_requests WHERE state = 'pending'");
    if (pending) problems.push(`${pending} pending input requests`);
    const unconsumed = count("SELECT COUNT(*) AS n FROM run_inputs WHERE consumed_at IS NULL");
    if (unconsumed) problems.push(`${unconsumed} undelivered inputs`);
    const events = db
      .query<{ seq: number; run_id: string | null; ts: number; type: string; payload: string }, [string]>("SELECT seq, run_id, ts, type, payload FROM thread_events WHERE thread_id = ? ORDER BY seq")
      .all(threadId)
      .map((e) => ({ ...e, thread_id: threadId, payload: JSON.parse(e.payload) }) as ThreadEvent);
    const held = events.filter((e) => e.type === "user.message" && e.payload.client_msg_id === HELD_MSG_ID);
    if (held.length !== (asked.length ? 1 : 0)) problems.push(`the message sent while waiting is in the thread ${held.length} times`);
    if (held.some((e) => e.type === "user.message" && e.payload.disposition !== "held")) problems.push("the message sent while waiting was not held");
    const undelivered = undeliveredMessages(events).length;
    if (undelivered) problems.push(`${undelivered} message(s) shown as not delivered`);

    for (const sid of new Set(runs.map((r) => r.sdk_session_id).filter((s): s is string => !!s))) {
      const interrupted = count("SELECT COUNT(*) AS n FROM sdk_transcripts WHERE session_id = ? AND instr(entry, ?) > 0", sid, INTERRUPTED);
      if (interrupted) problems.push(`the transcript shows ${interrupted} call(s) as merely interrupted`);
      const chain = chainTo(chainEntries(store, sid));
      const tools = chainTools(chain);
      if (tools.dangling.length) problems.push(`${tools.dangling.length} tool_use(s) without a result in the final transcript`);
      for (const [id, r] of tools.results) {
        const use = tools.uses.get(id);
        if (!use || NO_EFFECT.has(use.name)) continue;
        if (!r.isError && !happened.has(id)) problems.push(`the transcript says ${use.name} ${id} ran; the ledger says it did not`);
        if (r.content === NOT_RUN_TEXT && happened.has(id)) problems.push(`the transcript says ${use.name} ${id} did not run; the ledger says it did`);
      }
      const prompts = chain.filter((t) => t.uuid === CLIENT_MSG_ID).length;
      if (prompts !== 1) problems.push(`the user's message is in the transcript ${prompts} times`);
      const heldIn = chain.filter((t) => t.uuid === HELD_MSG_ID).length;
      if (heldIn !== held.length) problems.push(`the held message is in the transcript ${heldIn} times`);
    }
  } finally {
    db.close();
  }
  return problems;
}

/** A first life that ends at `first`, then lives until one ends on its own. */
async function trial(base: ChildArgs, first: Partial<ChildArgs>, dir = fresh()): Promise<{ dir: string; problems: string[] }> {
  const a = await life({ ...base, dir, ...first });
  if (a.code !== 0 && a.signal !== "SIGKILL") return { dir, problems: [`first life failed (${a.code}): ${a.stderr.slice(-2000)}`] };
  if (a.code !== 0) {
    const b = await life({ ...base, dir });
    if (b.code !== 0) return { dir, problems: [`recovery life failed (${b.code ?? b.signal}): ${b.stderr.slice(-2000)}`] };
  }
  return { dir, problems: check(dir, base.scenario) };
}

function ambiguousAfterCrash(dir: string): boolean {
  const db = new Database(join(dir, "homerun.db"), { readonly: true });
  try {
    const q = `SELECT COUNT(*) AS n FROM thread_events c WHERE c.type = 'tool.call' AND NOT EXISTS (
      SELECT 1 FROM thread_events r WHERE r.type = 'tool.result' AND json_extract(r.payload, '$.tool_call_id') = json_extract(c.payload, '$.tool_call_id'))`;
    return (db.query(q).get() as { n: number }).n > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

const show = (ks: readonly number[], n: number) => (MODE === "sample" ? `[${ks.join(",")}] of ${n}` : `${n}`);

if (MODE !== "full") console.error(`crash sweep: ${MODE}${MODE === "sample" ? `, seed ${SEED} (HOMERUN_CRASH_SEED=${SEED} draws the same boundaries)` : ""}`);

export async function sweep(base: Omit<ChildArgs, "dir">, budget: Budget): Promise<void> {
  const name = `${base.scenario}${base.mode ? `/${base.mode}` : ""}${base.approvals ? `/${base.approvals}` : ""}`;
  const started = Date.now();
  const draw = (kinds: string[], stream: string, budget: number) => sampleBoundaries(kinds, { mode: MODE, seed: SEED, stream: `${name}/${stream}`, budget });
  const baseline = await trial(base as ChildArgs, {});
  expect(baseline.problems).toEqual([]);
  rmSync(baseline.dir, { recursive: true, force: true });
  const kinds = await boundaryKinds({ ...base, dir: fresh() });
  expect(kinds.length).toBeGreaterThan(10);
  const kills = draw(kinds, "kill", budget.kill);
  const deaths = draw(kinds, "die", budget.die);

  const failures: string[] = [];
  const ambiguous: Array<{ k: number; dir: string }> = [];
  await pool(kills, async (k) => {
    const dir = fresh();
    const a = await life({ ...base, dir, killAt: k });
    if (a.signal === "SIGKILL" && (MODE === "exhaustive" || ambiguousAfterCrash(dir))) {
      ambiguous.push({ k, dir: copyDir(dir) });
    }
    const t = await trial(base as ChildArgs, { killAt: 0 }, dir);
    if (t.problems.length) failures.push(`kill at ${k}: ${t.problems.join("; ")}`);
    else rmSync(dir, { recursive: true, force: true });
  });

  await pool(deaths, async (k) => {
    const t = await trial(base as ChildArgs, { dieAt: k });
    if (t.problems.length) failures.push(`claude dies at ${k}: ${t.problems.join("; ")}`);
    else rmSync(t.dir, { recursive: true, force: true });
  });

  // A second crash during recovery, at every boundary of the recovery life.
  ambiguous.sort((a, b) => a.k - b.k);
  expect(ambiguous.length).toBeGreaterThan(0);
  const firsts = sampleItems(ambiguous, budget.secondAfter, { mode: MODE, seed: SEED, stream: `${name}/second` });
  const pairs: Array<{ crashed: string; k: number; j: number }> = [];
  const seconds: string[] = [];
  await pool(firsts, async ({ k, dir: crashed }) => {
    const recovery = await boundaryKinds({ ...base, dir: copyDir(crashed) });
    const js = draw(recovery, `second/${k}`, budget.second);
    for (const j of js) pairs.push({ crashed, k, j });
    seconds.push(`after ${k}: ${show(js, recovery.length)}`);
  });
  await pool(pairs, async ({ crashed, k, j }) => {
    const t = await trial(base as ChildArgs, { killAt: j }, copyDir(crashed));
    if (t.problems.length) failures.push(`second kill at ${j} after a kill at ${k} (${crashed}): ${t.problems.join("; ")}`);
    else rmSync(t.dir, { recursive: true, force: true });
  });
  for (const a of ambiguous) if (!failures.length || !firsts.includes(a)) rmSync(a.dir, { recursive: true, force: true });

  console.error(
    MODE === "sample"
      ? `${name}: kills ${show(kills, kinds.length)}, agent deaths ${show(deaths, kinds.length)}, second crashes ${seconds.sort().join("; ")} (${firsts.length} of ${ambiguous.length} ambiguous first crashes)`
      : `${name}: ${kills.length} boundaries, ${deaths.length} agent deaths, ${pairs.length} second crashes over ${firsts.length} ambiguous first crashes`,
    `(${((Date.now() - started) / 1000).toFixed(1)} s)`,
  );
  expect(failures).toEqual([]);
}

