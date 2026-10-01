import { describe, expect, test } from "bun:test";
import { Store } from "@homerun/app-state";
import { coalesced, type Timers } from "../src/coalesce";
import { AppLock, RELOCK_AFTER_MS } from "../src/lock";
import { PHONE_VECTOR_FILES, runSelfTest, selfTestLine } from "../src/selftest";
import { installRandomUUID, uuidV4 } from "../src/uuid";

class FakeTimers implements Timers {
  private next = 1;
  readonly due = new Map<number, () => void>();
  setTimeout(f: () => void): unknown {
    const id = this.next++;
    this.due.set(id, f);
    return id;
  }
  clearTimeout(t: unknown): void {
    this.due.delete(t as number);
  }
  /** Ends the current window. */
  tick(): void {
    const all = [...this.due.values()];
    this.due.clear();
    for (const f of all) f();
  }
}

describe("coalesced", () => {
  test("tells at once, then the latest of each window once, then stops", () => {
    const s = new Store(0);
    const t = new FakeTimers();
    let calls = 0;
    const off = coalesced(s.subscribe, 100, t)(() => calls++);
    s.set(1);
    expect(calls).toBe(1);
    for (let i = 2; i < 10; i++) s.set(i);
    expect(calls).toBe(1);
    t.tick();
    expect(calls).toBe(2);
    t.tick();
    expect(calls).toBe(2);
    expect(t.due.size).toBe(0);
    s.set(10);
    expect(calls).toBe(3);
    off();
    expect(t.due.size).toBe(0);
    s.set(11);
    t.tick();
    expect(calls).toBe(3);
  });
});

describe("AppLock", () => {
  const make = (answers: boolean[]) => {
    const kv = new Map<string, string>();
    let now = 1_000;
    const asked: string[] = [];
    const lock = new AppLock(
      { kvGet: async (k) => kv.get(k) ?? null, kvSet: async (k, v) => void (v === null ? kv.delete(k) : kv.set(k, v)) },
      async (reason) => {
        asked.push(reason);
        return answers.shift() ?? false;
      },
      () => now,
    );
    return { lock, kv, asked, advance: (ms: number) => (now += ms) };
  };

  test("off by default: never locked", async () => {
    const { lock } = make([]);
    await lock.load();
    expect(lock.locked.get()).toBe(false);
    lock.background();
    lock.foreground();
    expect(lock.locked.get()).toBe(false);
  });

  test("turning it on takes Face ID; a refusal leaves it off", async () => {
    const { lock, kv } = make([false, true]);
    await lock.load();
    expect(await lock.setEnabled(true)).toBe(false);
    expect(lock.enabled.get()).toBe(false);
    expect(await lock.setEnabled(true)).toBe(true);
    expect(kv.get("lock-on-open")).toBe("1");
  });

  test("on: locked at launch and after a minute away, not after a glance", async () => {
    const { lock, kv, advance } = make([false, true, true]);
    kv.set("lock-on-open", "1");
    await lock.load();
    expect(lock.locked.get()).toBe(true);
    expect(await lock.unlock()).toBe(false);
    expect(await lock.unlock()).toBe(true);
    lock.background();
    advance(5_000);
    lock.foreground();
    expect(lock.locked.get()).toBe(false);
    lock.background();
    advance(RELOCK_AFTER_MS);
    lock.foreground();
    expect(lock.locked.get()).toBe(true);
    expect(await lock.unlock()).toBe(true);
  });

  test("turning it off takes Face ID too", async () => {
    const { lock, kv, asked } = make([true, false]);
    kv.set("lock-on-open", "1");
    await lock.load();
    await lock.unlock();
    expect(await lock.setEnabled(false)).toBe(false);
    expect(lock.enabled.get()).toBe(true);
    expect(asked).toEqual(["Unlock Homerun", "Turn off the Face ID lock"]);
  });
});

describe("randomUUID polyfill", () => {
  test("version 4, RFC 4122 variant, from the given random bytes", () => {
    const u = uuidV4((a) => a.fill(0xff));
    expect(u).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidV4((a) => a.fill(0))).toBe("00000000-0000-4000-8000-000000000000");
    const r = uuidV4((a) => crypto.getRandomValues(a));
    expect(r).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("installs only where missing", () => {
    const bare: { getRandomValues: (a: Uint8Array) => Uint8Array; randomUUID?: () => string } = { getRandomValues: (a) => crypto.getRandomValues(a) };
    installRandomUUID(bare);
    expect(bare.randomUUID!()).not.toBe(bare.randomUUID!());
    const own = () => "mine";
    const has = { getRandomValues: bare.getRandomValues, randomUUID: own };
    installRandomUUID(has);
    expect(has.randomUUID).toBe(own);
  });
});

describe("self-test", () => {
  test("every vector file but App Attest passes", async () => {
    expect(PHONE_VECTOR_FILES).not.toContain("app-attest.json");
    expect(PHONE_VECTOR_FILES.length).toBeGreaterThan(5);
    const r = await runSelfTest();
    expect(r.failed).toEqual([]);
    expect(r.passed).toBeGreaterThan(20);
    expect(selfTestLine(r)).toBe(`vectors: ${r.passed} passed`);
    expect(selfTestLine({ passed: 1, failed: ["a.json: x"] })).toBe("vectors: 1 passed, 1 failed (a.json: x)");
  });
});
