import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLogSink } from "../../src/log";
import { CaffeinateAssertions } from "../../src/power/power";
import { MOCK_KEY, socketRuntime, until, uuid, type SocketRuntime } from "../helpers";

/**
 * Keeping awake is best-effort (§8.1): whatever goes wrong with caffeinate, one warning, no
 * retries, and runs carry on. The binary is injected, so this runs on Linux too.
 */
let dir: string;
let warnings: string[];
let srt: SocketRuntime | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hr-power-"));
  warnings = [];
  setLogSink((line) => {
    const rec = JSON.parse(line) as { level: string; reason?: string };
    if (rec.level === "warn") warnings.push(rec.reason ?? line);
  }, "debug");
});

afterEach(async () => {
  await srt?.close();
  srt = null;
  rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for caffeinate that records each start in `starts`, then runs `body`. */
function fakeCaffeinate(body: string, mode = 0o755): { path: string; starts: () => number } {
  const path = join(dir, "caffeinate");
  const log = join(dir, "starts");
  writeFileSync(path, `#!/bin/sh\necho started >> '${log}'\n${body}\n`);
  chmodSync(path, mode);
  return { path, starts: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length };
}

describe("caffeinate is best-effort (§8.1)", () => {
  test("a missing binary: one warning, and later runs don't try again", () => {
    const a = new CaffeinateAssertions(join(dir, "nope"));
    for (let i = 0; i < 3; i++) {
      const release = a.acquire("run");
      release();
      release();
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing or not executable");
    expect(a.unavailable).not.toBeNull();
  });

  test("a binary that is not executable counts as missing", () => {
    const f = fakeCaffeinate("exec sleep 30", 0o644);
    cycle(new CaffeinateAssertions(f.path), 2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("missing or not executable");
  });

  test("a caffeinate that exits immediately: one warning, and it is not started again", async () => {
    const f = fakeCaffeinate("exit 3");
    const a = new CaffeinateAssertions(f.path);
    const release = a.acquire("run");
    await until(() => a.unavailable !== null, 5000, "the early exit to be noticed");
    expect(warnings).toEqual([expect.stringContaining("exited while held (code 3)")]);
    release();
    cycle(a, 3);
    expect(f.starts()).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  test("a working caffeinate is held until released, then stopped, with no warning", async () => {
    const f = fakeCaffeinate("exec sleep 30");
    const a = new CaffeinateAssertions(f.path);
    const release = a.acquire("run");
    await until(() => {
      try {
        return f.starts() === 1;
      } catch {
        return false;
      }
    }, 5000, "caffeinate to start");
    release();
    await Bun.sleep(100);
    const again = a.acquire("run");
    again();
    await Bun.sleep(100);
    expect(a.unavailable).toBeNull();
    expect(warnings).toEqual([]);
  });

  test("a run succeeds while keeping awake is unavailable", async () => {
    srt = await socketRuntime({ power: new CaffeinateAssertions(join(dir, "nope")) });
    const shell = await srt.shell();
    await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
    const { thread } = await shell.call("threads.create", { title: "t" });
    const sent = await shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: "hi" });
    const state = () => srt!.rt.store.db.query<{ state: string }, [string]>("SELECT state FROM runs WHERE run_id = ?").get(sent.run_id)?.state;
    await until(() => state() === "succeeded", 5000, "the run to succeed");
  });
});

function cycle(a: CaffeinateAssertions, times: number): void {
  for (let i = 0; i < times; i++) a.acquire("run")();
}
