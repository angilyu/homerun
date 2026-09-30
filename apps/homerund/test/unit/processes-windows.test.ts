import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { pidAlive, terminateProcess, type ProcEntry } from "@homerun/win32";
import { sameBoot, treeBelow, windowsProcesses } from "../../src/platform/windows-processes";
import { until } from "../helpers";

const WINDOWS = process.platform === "win32";
const FIXTURE = join(import.meta.dir, "..", "fixtures", "win-tree.ts");

describe("the tree below claude, from a snapshot", () => {
  const e = (pid: number, ppid: number): ProcEntry => ({ pid, ppid, exe: "x.exe" });
  const born: Record<number, bigint | null> = { 10: 100n, 11: 110n, 12: 120n, 13: 90n, 14: null, 15: 130n, 20: 50n };
  const createdOf = (pid: number) => born[pid] ?? null;

  test("follows parent pids, but not to a process older than its recorded parent (a reused pid)", () => {
    const procs = [e(10, 4), e(11, 10), e(12, 11), e(13, 10), e(14, 10), e(15, 13), e(20, 4)];
    // 13 predates 10, so 10 is not its parent (and 15 below it is not ours); 14 can't be read.
    expect(treeBelow(procs, 10, createdOf).sort((a, b) => a - b)).toEqual([11, 12]);
    expect(treeBelow(procs, 99, createdOf)).toEqual([]);
  });

  test("a root whose creation time can't be read adopts nothing; cycles end", () => {
    expect(treeBelow([e(11, 14)], 14, createdOf)).toEqual([]);
    expect(treeBelow([e(11, 10), e(10, 11)], 10, createdOf)).toEqual([11]);
  });

  test("boot times within two seconds are the same boot", () => {
    expect(sameBoot(1000, 1002)).toBe(true);
    expect(sameBoot(1000, 997)).toBe(false);
  });
});

const children: ChildProcess[] = [];
const extra: number[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill();
  if (WINDOWS) for (const pid of extra.splice(0)) terminateProcess(pid);
});

async function firstLine(c: ChildProcess): Promise<number> {
  return new Promise((res, rej) => {
    let s = "";
    c.stdout!.on("data", (d) => {
      s += String(d);
      const n = s.indexOf("\n");
      if (n >= 0) res(Number(s.slice(0, n).trim()));
    });
    c.on("exit", () => rej(new Error(`exited before printing: ${s}`)));
  });
}

describe.skipIf(!WINDOWS)("job objects (Windows)", () => {
  test("killing a run takes claude and a detached grandchild; the job holds what escaped libuv", async () => {
    const abort = new AbortController();
    let pid = 0;
    const opts = { command: process.execPath, args: [FIXTURE, "tree"], cwd: import.meta.dir, env: { ...process.env }, signal: abort.signal } as unknown as SpawnOptions;
    const child = windowsProcesses.spawnClaude(opts, (p) => (pid = p)) as unknown as ChildProcess;
    children.push(child);
    const grandchild = await firstLine(child);
    extra.push(grandchild);
    expect(pidAlive(pid)).toBe(true);
    expect(pidAlive(grandchild)).toBe(true);
    const killed = await windowsProcesses.killRunTree(pid, process.execPath, 5000);
    expect(killed).toContain(pid);
    expect(pidAlive(pid)).toBe(false);
    expect(pidAlive(grandchild)).toBe(false);
  });

  test("aborting the spawn kills the tree too", async () => {
    const abort = new AbortController();
    let pid = 0;
    const opts = { command: process.execPath, args: [FIXTURE, "tree"], cwd: import.meta.dir, env: { ...process.env }, signal: abort.signal } as unknown as SpawnOptions;
    const child = windowsProcesses.spawnClaude(opts, (p) => (pid = p)) as unknown as ChildProcess;
    children.push(child);
    const grandchild = await firstLine(child);
    extra.push(grandchild);
    abort.abort();
    await until(() => !pidAlive(pid) && !pidAlive(grandchild), 5000);
  });

  test("a pid without a job whose image is not claude is left alone", async () => {
    const c = spawn(process.execPath, [FIXTURE, "sleep"], { stdio: "ignore", windowsHide: true });
    children.push(c);
    await until(() => pidAlive(c.pid!), 5000);
    expect(await windowsProcesses.killRunTree(c.pid!, "C:\\nowhere\\claude.exe", 1000)).toEqual([]);
    expect(pidAlive(c.pid!)).toBe(true);
  });

  test("a stale claude is killed only on the same boot and when its image matches", async () => {
    const c = spawn(process.execPath, [FIXTURE, "tree"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    children.push(c);
    const grandchild = await firstLine(c);
    extra.push(grandchild);
    const boot = windowsProcesses.bootTime();
    expect(await windowsProcesses.killStaleGroup(c.pid!, boot - 1000, boot, [], process.execPath)).toBe(false);
    expect(await windowsProcesses.killStaleGroup(c.pid!, boot, boot, [], "C:\\nowhere\\claude.exe")).toBe(false);
    expect(pidAlive(c.pid!)).toBe(true);
    expect(await windowsProcesses.killStaleGroup(c.pid!, boot, boot, [], process.execPath.toUpperCase())).toBe(true);
    // Without a job, the snapshot sweep finds the detached grandchild by its parent pid.
    await until(() => !pidAlive(grandchild), 5000);
  });

  test("a runtime that dies takes everything it started, through its own job", async () => {
    const c = spawn(process.execPath, [FIXTURE, "adopt"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    children.push(c);
    const grandchild = await firstLine(c);
    extra.push(grandchild);
    expect(pidAlive(grandchild)).toBe(true);
    terminateProcess(c.pid!);
    await until(() => !pidAlive(grandchild), 5000);
  });
});
