import { describe, test } from "bun:test";
import { sweep, TIMEOUT } from "./harness";

/**
 * Kill at every boundary (design §16.2, §16 row 4). A boundary is every SQLite commit homerund
 * makes (`Store.commitObserver`) and the points just before and after a tool's side effect. For
 * each boundary k of a scenario, homerund runs in a child process that SIGKILLs itself at k; a
 * second life on the same data dir recovers, answers "Did this happen?" truthfully (from the
 * ledger the fake tools write, as the user would know), and finishes. The user also sends a
 * message while the run waits, which is held. Then invariants that must hold however the crash
 * fell are checked: every side effect happened exactly once, every call has one result, the
 * transcript the model resumes from never shows a call as merely "interrupted", the held message
 * reaches the model once and is not shown as undelivered, and the thread ends with a succeeded run.
 *
 * The same sweep runs with `claude` dying alone at each boundary (homerund keeps running), and in
 * the truncate fallback mode. A second crash during the recovery life is swept for the first
 * crashes that leave an ambiguous call.
 *
 * `HOMERUN_CRASH_SWEEP` picks the boundaries (`sampler.ts`): every one (`full`, the default), a
 * seeded sample that still covers every kind of boundary (`sample`, CI on each pull request), or
 * `exhaustive`, which also crashes again after every first crash.
 */

/** In `sample` mode: boundaries per phase of a sweep, and how many ambiguous first crashes get a second. */
const BUDGET = { kill: 20, die: 18, secondAfter: 1, second: 20 };

describe("kill at every boundary (§16.2)", () => {
  test("serial: a read, a destructive command, and a write the mirror records late", () => sweep({ scenario: "serial" }, BUDGET), TIMEOUT);
  test("parallel: destructive calls in one assistant message", () => sweep({ scenario: "parallel" }, BUDGET), TIMEOUT);
  test("truncate mode: the fallback resumes from before the ambiguous message", () => sweep({ scenario: "parallel", mode: "truncate" }, BUDGET), TIMEOUT);
  test("a lagging mirror: nothing of the conversation is stored before the first side effect", () => sweep({ scenario: "lagging" }, BUDGET), TIMEOUT);
  test("a lagging mirror in truncate mode", () => sweep({ scenario: "lagging", mode: "truncate" }, BUDGET), TIMEOUT);
});
