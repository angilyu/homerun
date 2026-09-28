import { afterEach, describe, expect, test } from "bun:test";
import { NOT_STARTED_TEXT, prepareResume } from "../../src/runs/resume";
import type { RunRow } from "../../src/store/rows";
import { appendTranscript, PROJECT_KEY } from "../../src/store/session-store";
import { chainEntries, chainTo, chainTools, injectResults, sessionView, truncationPoint, type Entry } from "../../src/store/transcript";
import { testRuntime, type TestRuntime } from "../helpers";

let t: TestRuntime;
afterEach(() => t?.close());

const SID = "session-1";

function write(...entries: Entry[]) {
  appendTranscript(t.store, { projectKey: PROJECT_KEY, sessionId: SID }, entries as never);
}

function user(uuid: string, parentUuid: string | null, content: unknown = "hi"): Entry {
  return { type: "user", uuid, parentUuid, isSidechain: false, sessionId: SID, cwd: "/w", message: { role: "user", content } };
}

function assistant(uuid: string, parentUuid: string, msgId: string, content: unknown[]): Entry {
  return { type: "assistant", uuid, parentUuid, isSidechain: false, sessionId: SID, cwd: "/w", message: { id: msgId, role: "assistant", content } };
}

const use = (id: string) => ({ type: "tool_use", id, name: "Bash", input: {} });
const result = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });
const uuids = (chain: { uuid: string }[]) => chain.map((e) => e.uuid);

describe("the stored transcript (§5.4)", () => {
  test("the chain walks parentUuid back from the newest entry; bookkeeping and sidechains are not in it", () => {
    t = testRuntime();
    write(
      user("u1", null),
      { type: "queue-operation", operation: "enqueue" },
      assistant("a1", "u1", "m1", [{ type: "text", text: "x" }]),
      { ...assistant("s1", "a1", "m9", []), isSidechain: true },
      user("u2", "a1"),
      // A branch from u1 written later is the live conversation.
      assistant("a2", "u1", "m2", [{ type: "text", text: "y" }]),
    );
    const entries = chainEntries(t.store, SID);
    expect(uuids(entries)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(uuids(chainTo(entries))).toEqual(["u1", "a2"]);
    expect(uuids(chainTo(entries, "u2"))).toEqual(["u1", "a1", "u2"]);
  });

  test("a pending truncation ends the view at its point until claude writes the new branch", () => {
    t = testRuntime();
    write(user("u1", null), assistant("a1", "u1", "m1", [use("b1")]));
    expect(sessionView(t.store, SID, "u1")).toMatchObject({ resumeAt: "u1" });
    expect(uuids(sessionView(t.store, SID, "u1").chain)).toEqual(["u1"]);
    // An injected entry after the discarded branch does not spend the truncation.
    write(user("r1", "a1", [result("b1")]));
    expect(sessionView(t.store, SID, "u1").resumeAt).toBe("u1");
    write(user("u2", "u1", "continue"));
    expect(sessionView(t.store, SID, "u1")).toMatchObject({ resumeAt: null });
    expect(uuids(sessionView(t.store, SID, "u1").chain)).toEqual(["u1", "u2"]);
    expect(sessionView(t.store, SID, "gone").resumeAt).toBeNull();
  });

  test("results are injected for dangling tool_uses only, chained after the leaf, in claude's shape", () => {
    t = testRuntime();
    write(user("u1", null), assistant("a1", "u1", "m1", [use("b1")]), assistant("a2", "a1", "m1", [use("b2")]), user("r2", "a2", [result("b2")]));
    const chain = chainTo(chainEntries(t.store, SID));
    expect(chainTools(chain).dangling.map((u) => u.id)).toEqual(["b1"]);
    const done = injectResults(t.store, SID, chain, [
      { toolUseId: "b1", text: "it ran", isError: false },
      { toolUseId: "b2", text: "twice", isError: false },
      { toolUseId: "nope", text: "?", isError: true },
    ]);
    expect(done).toEqual(["b1"]);
    const after = chainTo(chainEntries(t.store, SID));
    expect(after.at(-2)!.uuid).toBe("r2");
    expect(after.at(-1)!.entry).toMatchObject({
      type: "user",
      parentUuid: "r2",
      sessionId: SID,
      cwd: "/w",
      sourceToolAssistantUUID: "a1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "it ran", is_error: false }] },
    });
    expect(chainTools(after).dangling).toEqual([]);
    expect(injectResults(t.store, SID, after, [{ toolUseId: "b1", text: "again", isError: false }])).toEqual([]);
  });

  test("the truncation point is before the whole assistant message, not just the entry with the call", () => {
    t = testRuntime();
    write(user("u1", null), assistant("a1", "u1", "m1", [{ type: "text", text: "on it" }]), assistant("a2", "a1", "m1", [use("b1")]), assistant("a3", "a2", "m1", [use("b2")]));
    const chain = chainTo(chainEntries(t.store, SID));
    expect(truncationPoint(chain, "b2")).toBe("u1");
    expect(truncationPoint(chain, "b1")).toBe("u1");
    expect(truncationPoint(chain, "nope")).toBeNull();
  });

  test("prepareResume: a call the gate never saw did not start; a pending truncation injects nothing; a spent one is cleared", () => {
    t = testRuntime();
    write(user("u1", null), assistant("a1", "u1", "m1", [use("b1")]));
    const row = { run_id: "r", thread_id: "th", sdk_session_id: SID, resume_at: "u1" } as unknown as RunRow;
    expect(prepareResume(t.store, row, SID)).toEqual({ resumeAt: "u1", injected: [] });
    expect(prepareResume(t.store, { ...row, resume_at: null }, SID)).toEqual({ resumeAt: null, injected: ["b1"] });
    expect(chainTo(chainEntries(t.store, SID)).at(-1)!.entry).toMatchObject({ message: { content: [{ tool_use_id: "b1", content: NOT_STARTED_TEXT, is_error: true }] } });
    // A different session (a fresh start) ignores the stored truncation point.
    expect(prepareResume(t.store, { ...row, sdk_session_id: "other" }, SID)).toEqual({ resumeAt: null, injected: [] });
  });
});
