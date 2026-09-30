/**
 * The bindings against the real system. Windows only (CI's windows-latest); elsewhere the tests
 * are skipped and nothing here runs, not even setup.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assignToJob,
  authenticode,
  closeHandle,
  createJob,
  credDelete,
  credRead,
  credWrite,
  currentUserSid,
  ES_CONTINUOUS,
  ES_SYSTEM_REQUIRED,
  GENERIC_READ,
  jobPids,
  openPipe,
  pidAlive,
  pipeSddl,
  pipeServerPid,
  privacyProblems,
  privateDirSddl,
  processCreationTime,
  processImagePath,
  processSnapshot,
  processUserSid,
  READ_CONTROL,
  readPathSecurity,
  readSecurity,
  setPathProtectedDacl,
  setProtectedDacl,
  setThreadExecutionState,
  SID,
  terminateJob,
  TRUST_E_NOSIGNATURE,
  Win32Error,
  WRITE_DAC,
} from "../src";

const WINDOWS = process.platform === "win32";
const win = describe.skipIf(!WINDOWS);

function listen(name: string): Promise<net.Server> {
  return new Promise((res, rej) => {
    const s = net.createServer((c) => c.on("error", () => {}));
    s.once("error", rej);
    s.listen(name, () => res(s));
  });
}

async function diesWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!pidAlive(pid)) return true;
    await Bun.sleep(25);
  }
  return false;
}

/** A child bun that spawns a grandchild and waits; resolves with both pids. */
function tree(): Promise<{ pid: number; grandchild: number; kill: () => void }> {
  const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const c = spawn(process.execPath, ["-e", script], { windowsHide: true });
  return new Promise((res, rej) => {
    let s = "";
    c.stdout.on("data", (d) => {
      s += d;
      if (s.includes("\n")) res({ pid: c.pid!, grandchild: Number(s.trim()), kill: () => c.kill() });
    });
    setTimeout(() => rej(new Error("child did not report")), 10_000);
  });
}

win("a pipe locked to the user (§5.2)", () => {
  test("the default DACL fails the check; the runtime's passes, read back through a client handle", async () => {
    const me = currentUserSid();
    expect(me).toMatch(/^S-1-5-21-/);
    const name = `\\\\.\\pipe\\hr-win32-test-${randomBytes(8).toString("hex")}`;
    const server = await listen(name);
    try {
      const h = await openPipe(name, READ_CONTROL | WRITE_DAC);
      try {
        expect(privacyProblems(readSecurity(h), me, { networkDeny: true, protected: true })).not.toEqual([]);
        setProtectedDacl(h, pipeSddl(me));
        expect(privacyProblems(readSecurity(h), me, { networkDeny: true, protected: true })).toEqual([]);
        expect(pipeServerPid(h)).toBe(process.pid);
      } finally {
        closeHandle(h);
      }
    } finally {
      server.close();
    }
  });
  test("a pipe nobody serves is a Win32Error, not a hang", async () => {
    const err = await openPipe(`\\\\.\\pipe\\hr-win32-none-${randomBytes(8).toString("hex")}`, GENERIC_READ).catch((e) => e);
    expect(err).toBeInstanceOf(Win32Error);
    expect((err as Win32Error).code).toBe(2);
  });
});

win("a private directory", () => {
  test("a temp directory inherits more than the user; after the protected DACL, only the user and SYSTEM", () => {
    const me = currentUserSid();
    const dir = mkdtempSync(join(tmpdir(), "hr-win32-"));
    try {
      const before = readPathSecurity(dir);
      expect(before.dacl?.protected).toBe(false);
      expect(privacyProblems(before, me, { protected: true })).not.toEqual([]);
      setPathProtectedDacl(dir, privateDirSddl(me));
      const after = readPathSecurity(dir);
      expect(privacyProblems(after, me, { protected: true })).toEqual([]);
      expect(after.dacl!.aces.map((a) => a.sid).sort()).toEqual([me, SID.SYSTEM].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

win("processes", () => {
  test("this process: user, image, creation time, and a snapshot entry", () => {
    expect(processUserSid(process.pid)).toBe(currentUserSid());
    const real = (p: string) => realpathSync.native(p).toLowerCase();
    expect(real(processImagePath(process.pid))).toBe(real(process.execPath));
    const created = processCreationTime(process.pid);
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(process.pid, created)).toBe(true);
    expect(pidAlive(process.pid, created + 1n)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(0x7fff_fff0)).toBe(false);
    const self = processSnapshot().find((p) => p.pid === process.pid);
    expect(self?.exe.toLowerCase()).toBe("bun.exe");
    expect(self?.ppid).toBe(process.ppid);
  });
  test("a job assigned before the grandchild exists takes it, and TerminateJobObject kills them all", async () => {
    const job = createJob({ killOnClose: false });
    // Assign first, then let the child spawn: a child that waits for stdin.
    const script = `process.stdin.once("data", () => { const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true, windowsHide: true }); console.log(c.pid); }); setInterval(() => {}, 1000);`;
    const c = spawn(process.execPath, ["-e", script], { windowsHide: true });
    try {
      assignToJob(job, c.pid!);
      c.stdin.write("go\n");
      const grandchild = await new Promise<number>((res) => c.stdout.on("data", (d) => res(Number(String(d).trim()))));
      expect(jobPids(job)).toEqual(expect.arrayContaining([c.pid!, grandchild]));
      terminateJob(job);
      expect(await diesWithin(c.pid!, 5000)).toBe(true);
      expect(await diesWithin(grandchild, 5000)).toBe(true);
    } finally {
      c.kill();
      closeHandle(job);
    }
  });
  test("closing a kill-on-close job's last handle kills what is in it", async () => {
    const t = await tree();
    const job = createJob({ killOnClose: true });
    try {
      assignToJob(job, t.pid);
    } catch (e) {
      t.kill();
      throw e;
    }
    closeHandle(job);
    expect(await diesWithin(t.pid, 5000)).toBe(true);
    // Spawned before the assignment and detached: outside the job (the runtime's Toolhelp sweep covers it).
    if (pidAlive(t.grandchild)) process.kill(t.grandchild);
  });
});

win("Credential Manager", () => {
  test("write, read, overwrite, delete", () => {
    const target = `Homerun-test/${randomBytes(8).toString("hex")}`;
    try {
      expect(credRead(target)).toBeNull();
      credWrite(target, "homerun-test", new TextEncoder().encode("sk-ant-mock-not-a-real-key"));
      expect(new TextDecoder().decode(credRead(target)!)).toBe("sk-ant-mock-not-a-real-key");
      credWrite(target, "homerun-test", new TextEncoder().encode("second"));
      expect(new TextDecoder().decode(credRead(target)!)).toBe("second");
      expect(credDelete(target)).toBe(true);
      expect(credRead(target)).toBeNull();
      expect(credDelete(target)).toBe(false);
    } finally {
      credDelete(target);
    }
  });
});

win("power", () => {
  test("SetThreadExecutionState keeps the system awake, then lets it go", () => {
    expect(setThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)).not.toBe(0);
    expect(setThreadExecutionState(ES_CONTINUOUS)).not.toBe(0);
  });
});

win("Authenticode", () => {
  test("an unsigned file has no signature; PowerShell 7 verifies and names Microsoft", () => {
    const dir = mkdtempSync(join(tmpdir(), "hr-wt-"));
    try {
      const f = join(dir, "unsigned.exe");
      writeFileSync(f, "MZ not really a program");
      expect(authenticode(f)).toEqual({ status: TRUST_E_NOSIGNATURE, subject: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const pwsh = join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
    if (!existsSync(pwsh)) return;
    expect(authenticode(pwsh)).toEqual({ status: 0, subject: "Microsoft Corporation" });
  });
});

describe("off Windows", () => {
  test.skipIf(WINDOWS)("a call throws instead of loading a DLL", () => {
    expect(() => currentUserSid()).toThrow(/called on/);
  });
});
