import { describe, expect, test } from "bun:test";
import { descendants, escapedTools, type Proc } from "../../src/agent/claude/process-tree";

const p = (pid: number, ppid: number, pgid: number, command: string): Proc => ({ pid, ppid, pgid, command });

describe("process tree (F8)", () => {
  const procs = [
    p(10, 1, 10, "/app/claude --output-format stream-json"),
    p(11, 10, 11, "/bin/bash -c source /d/claude-config/shell-snapshots/s.sh && eval 'sleep 20'"),
    p(12, 11, 12, "sleep 20"),
    p(13, 10, 10, "node mcp-server.js"),
    p(20, 1, 20, "/bin/bash -c source /d/claude-config/shell-snapshots/t.sh"),
    p(21, 20, 21, "sleep 99"),
    p(30, 1, 30, "/bin/bash -c source /other/claude-config/shell-snapshots/u.sh"),
    p(31, 1, 31, "vim /d/claude-config-notes.txt"),
  ];

  test("descendants follow parent links across groups, not including the root", () => {
    expect(descendants(procs, [10]).map((x) => x.pid).sort((a, b) => a - b)).toEqual([11, 12, 13]);
    expect(descendants(procs, [99])).toEqual([]);
  });

  test("escaped tools are found by this data dir's config path, with their subtrees", () => {
    const found = escapedTools(procs, "/d/claude-config");
    expect(found.map((x) => x.pid).sort((a, b) => a - b)).toEqual([11, 12, 20, 21]);
    // Commands can hold tool input; they are not carried out.
    expect(found.every((x) => x.command === "")).toBe(true);
  });
});
