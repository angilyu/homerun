import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { ES_CONTINUOUS, ES_SYSTEM_REQUIRED, setThreadExecutionState } from "@homerun/win32";
import { log } from "../log";

/**
 * Keeping the computer awake while a run is in progress (§8.1). The runtime holds at most one
 * assertion at a time; callers acquire it when the first run starts and release it when the last
 * one ends. Runs waiting for input hold nothing (§5.6).
 */
export interface PowerAssertions {
  /** Take the assertion. The returned function releases it; calling it twice is harmless. */
  acquire(reason: string): () => void;
}

export const CAFFEINATE = "/usr/bin/caffeinate";

const released = () => {};

/**
 * macOS: `caffeinate -i -w <our pid>` holds a PreventUserIdleSystemSleep assertion. With `-w` it
 * exits by itself when the runtime dies, so a crash never leaves the computer unable to sleep.
 *
 * Best-effort (§8.1): caffeinate ships with macOS, but if it is missing, not executable, fails to
 * start or exits while held, this logs one warning and stops trying for the rest of the runtime's
 * life. Runs carry on as normal either way; acquiring never throws and never waits.
 */
export class CaffeinateAssertions implements PowerAssertions {
  private failure: string | null = null;

  constructor(
    private path = CAFFEINATE,
    private pid = process.pid,
  ) {}

  /** Why keeping awake was given up, or null while it works. */
  get unavailable(): string | null {
    return this.failure;
  }

  acquire(reason: string): () => void {
    if (this.failure) return released;
    try {
      accessSync(this.path, constants.X_OK);
    } catch {
      this.giveUp(`${this.path} is missing or not executable`);
      return released;
    }
    let child: ChildProcess;
    try {
      child = spawn(this.path, ["-i", "-w", String(this.pid)], { stdio: "ignore", detached: false });
    } catch (e) {
      this.giveUp(`${this.path} could not start: ${e instanceof Error ? e.message : String(e)}`);
      return released;
    }
    let done = false;
    child.on("error", (e) => this.giveUp(`${this.path} could not start: ${e.message}`));
    child.on("exit", (code, signal) => {
      if (!done) this.giveUp(`${this.path} exited while held (${signal ?? `code ${code}`})`);
    });
    log.debug("power assertion taken", { reason, pid: child.pid });
    return () => {
      if (done) return;
      done = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      log.debug("power assertion released", { reason });
    };
  }

  private giveUp(why: string): void {
    if (this.failure) return;
    this.failure = why;
    log.warn("cannot keep the computer awake during runs; runs continue without it", { reason: why });
  }
}

/**
 * Windows: `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` on the runtime's main
 * thread keeps the system from idle sleep, like `caffeinate -i`; `ES_CONTINUOUS` alone clears
 * it. The state belongs to the thread, so a runtime that dies can't leave it set. Best-effort in
 * the same way: a failed call warns once and keeping awake is given up.
 */
export class ExecutionStateAssertions implements PowerAssertions {
  private failure: string | null = null;
  private holders = 0;

  constructor(private set: (flags: number) => number = setThreadExecutionState) {}

  get unavailable(): string | null {
    return this.failure;
  }

  acquire(reason: string): () => void {
    if (this.failure) return released;
    if (this.holders === 0 && this.set(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) === 0) {
      this.failure = "SetThreadExecutionState failed";
      log.warn("cannot keep the computer awake during runs; runs continue without it", { reason: this.failure });
      return released;
    }
    this.holders++;
    log.debug("power assertion taken", { reason });
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.holders === 0) this.set(ES_CONTINUOUS);
      log.debug("power assertion released", { reason });
    };
  }
}

export class NoopAssertions implements PowerAssertions {
  acquire(): () => void {
    return () => {};
  }
}

/** Tests: records when the assertion was held. */
export class FakeAssertions implements PowerAssertions {
  readonly timeline: Array<{ at: number; held: boolean; reason?: string }> = [];
  private count = 0;

  constructor(private now: () => number = Date.now) {}

  get held(): boolean {
    return this.count > 0;
  }

  acquire(reason: string): () => void {
    this.count++;
    this.timeline.push({ at: this.now(), held: true, reason });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count--;
      this.timeline.push({ at: this.now(), held: this.count > 0 });
    };
  }
}

/** The platform's assertions: caffeinate on macOS, the thread's execution state on Windows. */
export function platformAssertions(): PowerAssertions {
  if (process.platform === "darwin") return new CaffeinateAssertions();
  if (process.platform === "win32") return new ExecutionStateAssertions();
  return new NoopAssertions();
}
