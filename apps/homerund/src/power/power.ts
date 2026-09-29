import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

/**
 * macOS: `caffeinate -i -w <our pid>` holds a PreventUserIdleSystemSleep assertion. With `-w` it
 * exits by itself when the runtime dies, so a crash never leaves the computer unable to sleep.
 */
export class CaffeinateAssertions implements PowerAssertions {
  constructor(
    private path = CAFFEINATE,
    private pid = process.pid,
  ) {}

  acquire(reason: string): () => void {
    let child: ChildProcess | null = null;
    try {
      child = spawn(this.path, ["-i", "-w", String(this.pid)], { stdio: "ignore", detached: false });
      child.on("error", (e) => log.warn("caffeinate failed", { error: e.message }));
      log.debug("power assertion taken", { reason, pid: child.pid });
    } catch (e) {
      log.warn("could not keep the computer awake", { error: e instanceof Error ? e.message : String(e) });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (child && child.exitCode === null) child.kill("SIGTERM");
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

/** The platform's assertions: caffeinate on macOS, nothing elsewhere for now. */
export function platformAssertions(): PowerAssertions {
  if (process.platform === "darwin" && existsSync(CAFFEINATE)) return new CaffeinateAssertions();
  return new NoopAssertions();
}
