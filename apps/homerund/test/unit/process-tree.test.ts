import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { descendants, escapedTools, killRunTree, listProcs, sessionMembers, sessionOf, type Proc } from "../../src/agent/claude/process-tree";
import { pidAlive } from "../../src/agent/claude/spawn";

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

describe("a dead claude's session (milestone 4)", () => {
  test("a tool in its own group that outlived its session leader is found by session id and killed", async () => {
    // Like claude: a session leader (detached = setsid) whose shell puts a job in its own group,
    // then dies before the job's command could show anything recognisable.
    const leader = spawn("/bin/bash", ["-c", "set -m; sleep 37 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const out = await new Promise<string>((res) => {
      let s = "";
      leader.stdout!.on("data", (d) => (s += String(d)));
      leader.on("exit", () => res(s));
    });
    const leaderPid = leader.pid!;
    const orphan = Number(out.trim());
    try {
      expect(pidAlive(leaderPid)).toBe(false);
      expect(pidAlive(orphan)).toBe(true);
      expect(sessionOf(orphan)).toBe(leaderPid);
      const found = sessionMembers(listProcs(), leaderPid);
      expect(found.map((p) => p.pid)).toEqual([orphan]);
      expect(found[0]!.pgid).toBe(orphan);
      expect(await killRunTree(leaderPid, "/no/such/claude", 3000)).toEqual([orphan]);
      expect(pidAlive(orphan)).toBe(false);
    } finally {
      try {
        process.kill(orphan, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  });

  test("while the leader lives, a leader that is not claude (a reused pid) keeps its session", async () => {
    const other = spawn("/bin/bash", ["-c", "set -m; sleep 38 & wait"], { detached: true, stdio: "ignore" });
    const leaderPid = other.pid!;
    try {
      let members: Proc[] = [];
      for (let i = 0; i < 100 && members.length === 0; i++) {
        members = sessionMembers(listProcs(), leaderPid);
        if (!members.length) await Bun.sleep(20);
      }
      expect(members).toHaveLength(1);
      // The leader is not claude: its group is killed as before, but its session is left alone.
      const job = members[0]!.pid;
      await killRunTree(leaderPid, "/no/such/claude", 1000).catch(() => []);
      expect(pidAlive(job)).toBe(true);
      process.kill(job, "SIGKILL");
    } finally {
      try {
        process.kill(-leaderPid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
  });
});
