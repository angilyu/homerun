import { describe, test } from "bun:test";
import { sweep, TIMEOUT } from "./harness";

/**
 * Kill at every boundary of an approval or a question (design §5.6, §16 row 6). The same sweep as
 * crash.test.ts, with the gate live instead of `--dev-auto-approve`: the request row written, the
 * answer committed, the answer applied, the call deferred and the run relaunched for it are each
 * boundaries of their own kind, so `sample` mode always draws one of each (`sampler.ts`).
 *
 * `wait` answers while the process holds the call (the short wait); `defer` lets the process go
 * at once and answers with no process alive, as an overnight approval does (§8.3).
 */

/** In `sample` mode: boundaries per phase of a sweep, and how many ambiguous first crashes get a second. */
const BUDGET = { kill: 16, die: 12, secondAfter: 1, second: 12 };

describe("kill at every approval boundary (§5.6)", () => {
  test("approve, short wait: an approval, a question and a write", () => sweep({ scenario: "approve", approvals: "wait" }, BUDGET), TIMEOUT);
  test("approve, deferred: the same with no process while it waits", () => sweep({ scenario: "approve", approvals: "defer" }, BUDGET), TIMEOUT);
  test("parallel gated calls: one waits, the sibling is denied and asked again (F3)", () => sweep({ scenario: "approve-parallel", approvals: "defer" }, BUDGET), TIMEOUT);
});
