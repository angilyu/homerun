import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RPC_ERROR, type CrashReportSettings, type DiagnosticFile } from "@homerun/core";
import { CrashReporter, crashDir, envelope, MAX_AGE_MS, MAX_SPOOLED, parseDsn, readSpool, spoolError, spoolReport } from "../../src/diagnostics/crash";
import { defaultPath } from "../../src/diagnostics/bundle";
import { crashReport, newRedactor, parseCrashReport, parseStack, redactLogLine, redactText, relativeModule, type BuildInfo } from "../../src/diagnostics/scrub";
import { unzip, zip } from "../../src/diagnostics/zip";
import { RpcCallError } from "../../src/rpc/client";
import { FakeClock } from "../../src/schedule/clock";
import { MOCK_KEY, testRuntime, uuid, type TestRuntime } from "../helpers";
import { every5, MIN, rig, type Rig } from "./schedule/rig";

const BUILD: BuildInfo = { app: "homerund", os: "macos", arch: "arm64", version: "0.3.0", channel: "stable" };
const HOME = "/Users/alice";
// What must never leave the machine.
const SECRETS = [
  // Assembled at run time so the repository secret scan (scripts/check-no-secrets.sh) passes.
  ["sk", "ant", "api03", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-"),
  "ghp_0123456789abcdefghijABCDEFGHIJ012345",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
  "alice@example.com",
  "/Users/alice",
  "payroll-2026.xlsx",
  "https://internal.example.com/admin?token=",
  "Summarise my medical records",
];
const leaks = (text: string) => SECRETS.filter((s) => text.includes(s));

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "hr-diag-"));
  dirs.push(d);
  return d;
};
let t: TestRuntime | null = null;
let r: Rig | null = null;
afterEach(async () => {
  t?.close();
  t = null;
  await r?.close();
  r = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An error whose message, name and stack all carry things that must not be sent. */
function nastyError(): Error {
  const e = new Error(`ENOENT: open '/Users/alice/Documents/payroll-2026.xlsx' with key ${SECRETS[0]}\n    at fake (/Users/alice/evil.ts:1:1)`);
  e.stack = [
    `Error: ${e.message}`,
    "    at readSheet (/Users/alice/Code/homerun/apps/homerund/src/tools/read.ts:42:7)",
    "    at <anonymous> (/$bunfs/root/homerund:1234:5)",
    "    at runTool (/Users/alice/Documents/payroll-2026.xlsx:9:9)",
    `    at Object.${SECRETS[0]} (/opt/homebrew/lib/node_modules/x/index.js:1:1)`,
    "    at processTicksAndRejections (native:7:39)",
    "    at C:\\Users\\alice\\AppData\\Local\\Homerun\\x.js:3:3",
    "    at ../../../Users/alice/secret.ts:4:4",
    "fetchPolicy@https://internal.example.com/admin?token=abc:1:2",
  ].join("\n");
  return e;
}

describe("the crash report allowlist (§11)", () => {
  test("an adversarial error keeps only its type and frames, with paths relative to the bundle", () => {
    const rep = crashReport(nastyError(), "runtime_exception", BUILD, 1);
    const text = JSON.stringify(rep);
    expect(leaks(text)).toEqual([]);
    expect(text).not.toContain("fake");
    expect(text).not.toContain("alice");
    expect(rep.exception_type).toBe("Error");
    expect(rep.frames).toEqual([
      { function: "readSheet", module: "apps/homerund/src/tools/read.ts", lineno: 42 },
      { function: "<anonymous>", module: "homerund", lineno: 1234 },
      { function: "runTool", module: "<external>", lineno: 9 },
      { function: "?", module: "node_modules/x/index.js", lineno: 1 },
      { function: "processTicksAndRejections", module: "<native>", lineno: 7 },
      { function: "?", module: "<external>", lineno: 3 },
      { function: "?", module: "<external>", lineno: 4 },
      { function: "fetchPolicy", module: "<external>", lineno: 1 },
    ]);
  });

  test("names, non-errors and thrown objects say only what type they are", () => {
    const e = new Error("x");
    e.name = `TokenError ${SECRETS[1]}`;
    expect(crashReport(e, "runtime_exception", BUILD, 1).exception_type).toBe("Error");
    expect(crashReport("a string with alice@example.com", "runtime_exception", BUILD, 1)).toMatchObject({ exception_type: "NonError", frames: [] });
    expect(crashReport({ name: "Weird", stack: "at x (/Users/alice/a.ts:1:1)", prompt: SECRETS[7] }, "runtime_exception", BUILD, 1)).toMatchObject({ exception_type: "Weird", frames: [{ function: "x", module: "<external>", lineno: 1 }] });
    class SessionExpired extends Error {}
    expect(crashReport(new SessionExpired("t"), "runtime_exception", BUILD, 1).exception_type).toBe("Error");
    const named = new SessionExpired("t");
    named.name = "SessionExpired";
    expect(crashReport(named, "runtime_exception", BUILD, 1).exception_type).toBe("SessionExpired");
  });

  test("a build tag that isn't a plain tag becomes unknown", () => {
    expect(crashReport(new Error(), "runtime_exception", { ...BUILD, version: "0.3.0 /Users/alice", channel: "a b" }, 1)).toMatchObject({ version: "unknown", channel: "unknown" });
  });

  test("module paths", () => {
    expect(relativeModule("/Users/alice/Code/homerun/packages/core/src/x.ts")).toBe("packages/core/src/x.ts");
    expect(relativeModule("file:///B:/~BUN/root/homerund.exe")).toBe("homerund.exe");
    expect(relativeModule("/Users/alice/.cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.0.0/src/lib.rs")).toBe("crates/tokio-1.0.0/src/lib.rs");
    expect(relativeModule("/rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/std/src/panicking.rs")).toBe("rustc/library/std/src/panicking.rs");
    expect(relativeModule("src/main.ts")).toBe("src/main.ts");
    expect(relativeModule("node:internal/process")).toBe("node/internal/process");
    for (const bad of ["/Users/alice/notes.md", "~/x.ts", "C:/Users/alice/x.js", "../../../private/tmp/x.ts", "apps/../../../etc/passwd", "Documents/payroll.xlsx", "src/a b.ts", "/home/alice/apps"]) {
      expect(relativeModule(bad)).toBe("<external>");
    }
  });

  test("a message spanning lines is never read as frames", () => {
    const msg = "bad input:\n    at stolen (/Users/alice/secret.ts:1:1)\nend";
    expect(parseStack(`Error: ${msg}\n    at real (src/a.ts:2:3)`, msg)).toEqual([{ function: "real", module: "src/a.ts", lineno: 2 }]);
  });

  test("a report read back from disk passes the allowlist again: extra fields reject it", () => {
    const rep = crashReport(new Error(), "runtime_exception", BUILD, 1);
    expect(parseCrashReport(rep)).toEqual(rep);
    expect(parseCrashReport({ ...rep, message: "hi" })).toBeNull();
    expect(parseCrashReport({ ...rep, frames: [{ function: "f", module: "/Users/alice/x", lineno: 1 }] })).toBeNull();
    expect(parseCrashReport({ ...rep, frames: [{ function: "f", module: "src/x.ts", lineno: 1, vars: {} }] })).toBeNull();
    expect(parseCrashReport({ ...rep, exception_type: "Error: alice@example.com" })).toBeNull();
  });
});

describe("log redaction for the bundle (§11)", () => {
  const red = newRedactor(HOME);

  test("free text loses secrets, URLs, emails and home paths", () => {
    const out = redactText(`token=${SECRETS[1]} Bearer ${SECRETS[2]} from ${SECRETS[3]} at ${HOME}/Documents/${SECRETS[5]} via ${SECRETS[6]}x and ${SECRETS[0]}`, red);
    expect(leaks(out)).toEqual([]);
    expect(out).toContain("at ~/[path] via");
  });

  test("a JSON log line keeps its shape; content-bearing fields are dropped, ids hashed", () => {
    const line = JSON.stringify({
      t: 1,
      level: "info",
      src: "homerund",
      msg: `run started for ${SECRETS[3]}`,
      run_id: "run-123",
      thread_id: "thr-9",
      text: SECRETS[7],
      prompt: SECRETS[7],
      path: `${HOME}/${SECRETS[5]}`,
      url: SECRETS[6],
      cost_usd: 0.12,
      err: { name: "Error", message: `open ${HOME}/${SECRETS[5]} failed`, stack: "at x (/Users/alice/a.ts:1:1)" },
      nested: { deep: { deeper: { deepest: SECRETS[0] } } },
      list: [SECRETS[0], 3],
    });
    const out = redactLogLine(line, red);
    expect(leaks(out)).toEqual([]);
    const rec = JSON.parse(out);
    expect(rec).toMatchObject({ t: 1, level: "info", src: "homerund", text: "[redacted]", prompt: "[redacted]", path: "[redacted]", url: "[redacted]", cost_usd: 0.12, list: ["[redacted]", 3] });
    expect(rec.msg).toBe("run started for [email]");
    expect(rec.run_id).toMatch(/^h:[0-9a-f]{12}$/);
    expect(redactLogLine(line, red)).toBe(out); // consistent within one bundle
    expect(JSON.parse(redactLogLine(line, newRedactor(HOME))).run_id).not.toBe(rec.run_id); // not across bundles
    expect(rec.err).toEqual({ name: "Error", message: "open ~/[path] failed" });
  });

  test("raw stderr keeps only stack frames and the banner; everything else only its length", () => {
    expect(redactLogLine(`claude says: ${SECRETS[7]}`, red)).toBe(`[text: ${`claude says: ${SECRETS[7]}`.length} chars]`);
    expect(redactLogLine(`    at x (${HOME}/a.ts:1:1)`, red)).toBe("    at x (~/[path])");
    expect(redactText("C:\\Users\\alice\\Documents\\payroll.xlsx and /home/bob/notes.md", red)).toBe("~/[path] and ~/[path]");
    expect(redactLogLine("Bun v1.4.2 (macOS arm64)", red)).toBe("Bun v1.4.2 (macOS arm64)");
    expect(redactLogLine("{not json " + SECRETS[0], red)).toMatch(/^\[text: \d+ chars\]$/);
    expect(redactLogLine("", red)).toBe("");
  });
});

describe("the crash spool and opt-in sending (§11)", () => {
  test("reports are written private, capped at 20, aged out after 30 days, and re-checked on read", () => {
    const dir = tmp();
    for (let i = 0; i < MAX_SPOOLED + 5; i++) spoolReport(dir, crashReport(new Error(), "runtime_exception", BUILD, 1_000_000 + i));
    expect(readdirSync(crashDir(dir)).length).toBe(MAX_SPOOLED);
    const tampered = join(crashDir(dir), "9999999999999-x.json");
    writeFileSync(tampered, JSON.stringify({ ...crashReport(new Error(), "runtime_exception", BUILD, 2_000_000), message: SECRETS[7] }));
    writeFileSync(join(crashDir(dir), "9999999999998-y.json"), "not json");
    const spool = readSpool(dir, 2_000_000);
    expect(spool.length).toBe(MAX_SPOOLED);
    expect(existsSync(tampered)).toBe(false);
    expect(readSpool(dir, 1_000_000 + MAX_AGE_MS + 10)).toHaveLength(MAX_SPOOLED - 5);
    if (process.platform !== "win32") {
      const { statSync } = require("node:fs") as typeof import("node:fs");
      expect(statSync(spool.at(-1)!.path).mode & 0o077).toBe(0);
    }
  });

  test("the DSN", () => {
    expect(parseDsn("https://pub123@o1.ingest.sentry.io/4507")).toEqual({ key: "pub123", envelopeUrl: "https://o1.ingest.sentry.io/api/4507/envelope/" });
    expect(parseDsn("https://k@example.com/sentry/12")?.envelopeUrl).toBe("https://example.com/sentry/api/12/envelope/");
    for (const bad of [null, "", "http://k@example.com/1", "https://example.com/1", "https://k@example.com/abc", "nope"]) expect(parseDsn(bad)).toBeNull();
  });

  test("the envelope carries the allowlisted fields and nothing else", () => {
    const rep = crashReport(nastyError(), "runtime_exception", BUILD, 1_700_000_000_000);
    const env = envelope(rep, 1_700_000_001_000);
    expect(leaks(env)).toEqual([]);
    const [header, item, body] = env.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(header).toEqual({ event_id: rep.id, sent_at: "2023-11-14T22:13:21.000Z" });
    expect(item).toEqual({ type: "event", length: Buffer.byteLength(JSON.stringify(body)) });
    expect(Object.keys(body).sort()).toEqual(["contexts", "environment", "event_id", "exception", "level", "logger", "platform", "release", "tags", "timestamp"]);
    expect(body.exception.values[0].value).toBe("");
    expect(body.exception.values[0].stacktrace.frames[0]).toMatchObject({ function: "fetchPolicy", in_app: false });
    expect(body.exception.values[0].stacktrace.frames.at(-1)).toMatchObject({ function: "readSheet", in_app: true });
  });

  function reporter(dsn: string | null) {
    t ??= testRuntime();
    const clock = new FakeClock(1_000_000);
    const posted: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
    let status = 200;
    const fetch = (async (url: string, init: RequestInit) => {
      posted.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("", { status });
    }) as unknown as typeof globalThis.fetch;
    const rep = new CrashReporter({ store: t.store, dataDir: t.dir, dsn, clock, version: "0.3.0", fetch });
    return { rep, clock, posted, setStatus: (s: number) => (status = s), dir: t.dir };
  }

  test("without a DSN the setting doesn't exist", () => {
    const { rep } = reporter(null);
    expect(rep.settings()).toEqual({ available: false, enabled: false });
    expect(rep.set(true)).toBeNull();
  });

  test("off by default; turning it on sends only crashes from then on, and only allowlisted fields", async () => {
    const { rep, clock, posted, dir } = reporter("https://pub@sentry.example/42");
    spoolError(dir, nastyError(), "runtime_exception", BUILD, clock.now() - 1);
    expect(rep.settings()).toEqual({ available: true, enabled: false });
    expect(await rep.flush()).toBe(0);
    expect(posted).toEqual([]);

    expect(rep.set(true)).toEqual({ available: true, enabled: true });
    await rep.flush();
    expect(posted).toEqual([]); // the crash from before opting in stays local
    clock.sleep(1000);
    spoolError(dir, nastyError(), "runtime_exception", BUILD, clock.now());
    expect(await rep.flush()).toBe(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe("https://sentry.example/api/42/envelope/");
    expect(posted[0]!.headers["x-sentry-auth"]).toContain("sentry_key=pub");
    expect(leaks(posted[0]!.body)).toEqual([]);
    expect(readSpool(dir, clock.now())).toHaveLength(1); // sent → deleted; the old one remains

    rep.set(false);
    spoolError(dir, new Error(), "runtime_exception", BUILD, clock.now() + 1);
    expect(await rep.flush()).toBe(0);
    expect(posted).toHaveLength(1);
  });

  test("rate limits and server errors retry later; other refusals drop the report", async () => {
    const { rep, clock, posted, setStatus, dir } = reporter("https://pub@sentry.example/42");
    rep.set(true);
    await rep.flush();
    clock.sleep(10);
    spoolError(dir, new Error(), "runtime_exception", BUILD, clock.now());
    for (const s of [429, 503]) {
      setStatus(s);
      expect(await rep.flush()).toBe(0);
      expect(readSpool(dir, clock.now())).toHaveLength(1);
    }
    setStatus(400);
    expect(await rep.flush()).toBe(0);
    expect(readSpool(dir, clock.now())).toHaveLength(0);
    expect(posted).toHaveLength(3);
  });
});

describe("the zip writer", () => {
  test("round trips, and the system unzip reads it", async () => {
    const dir = tmp();
    const big = new TextEncoder().encode("line\n".repeat(10_000));
    const data = zip([
      { name: "a.json", data: new TextEncoder().encode('{"a":1}\n') },
      { name: "logs/big.log", data: big },
      { name: "empty.txt", data: new Uint8Array() },
      { name: "ünï.txt", data: new TextEncoder().encode("x") },
    ]);
    const back = unzip(data);
    expect([...back.keys()]).toEqual(["a.json", "logs/big.log", "empty.txt", "ünï.txt"]);
    expect(back.get("logs/big.log")).toEqual(big);
    expect(data.length).toBeLessThan(big.length / 10);
    const path = join(dir, "t.zip");
    writeFileSync(path, data);
    const p = Bun.spawnSync(["unzip", "-t", path]);
    if (p.exitCode !== null && existsSync("/usr/bin/unzip")) expect(p.stdout.toString()).toContain("No errors detected");
  });
});

describe("the diagnostic bundle (§11)", () => {
  async function seeded() {
    r = await rig({ start: Date.UTC(2026, 0, 5, 0, 1), env: { HOMERUN_SENTRY_DSN: "https://pub@sentry.example/42" } });
    const home = r.sr.dir;
    // A monitor whose name and prompt are private, a run, and a chat with a secret in it.
    const m = await r.fileMonitor(every5(), { name: `${SECRETS[5]} for ${SECRETS[3]}` });
    await r.step(4 * MIN);
    const { thread } = (await r.shell.call("threads.create", { title: SECRETS[7] })) as { thread: { thread_id: string } };
    await r.shell.call("messages.send", { thread_id: thread.thread_id, client_msg_id: uuid(), text: `${SECRETS[7]} with ${SECRETS[0]} at ${SECRETS[6]}` });
    await r.idle();
    // Logs as the shell writes them, with secrets in every shape.
    const logs = join(home, "logs");
    mkdirSync(logs, { recursive: true });
    writeFileSync(
      join(logs, "homerund.log"),
      [
        JSON.stringify({ t: 1, level: "info", src: "homerund", msg: "run started", run_id: "r1", text: SECRETS[7] }),
        JSON.stringify({ t: 2, level: "warn", src: "shell", msg: `spawned ${home}/x with token=${SECRETS[1]}` }),
        `Prompt was: ${SECRETS[7]} ${SECRETS[0]}`,
        `    at x (${home}/Documents/${SECRETS[5]}:1:1)`,
      ].join("\n"),
    );
    writeFileSync(join(logs, "supervisor.jsonl"), JSON.stringify({ t: 3, src: "shell", state: "running", detail: `email ${SECRETS[3]} key ${SECRETS[2]}` }) + "\n");
    spoolError(home, nastyError(), "runtime_exception", BUILD, Date.now());
    return { home, m };
  }

  const extract = (path: string) => {
    const files = unzip(new Uint8Array(require("node:fs").readFileSync(path)));
    const text = [...files.values()].map((b) => new TextDecoder().decode(b)).join("\n");
    return { files, text };
  };

  test("holds what explains the install and none of the user's content", async () => {
    const { home, m } = await seeded();
    const { files: listed } = (await r!.shell.call("diagnostics.preview", {})) as { files: DiagnosticFile[] };
    const names = listed.map((f) => f.name);
    expect(names.slice(0, 9)).toEqual(["manifest.json", "versions.json", "logs/homerund.log", "logs/supervisor.jsonl", "database.json", "scheduler.json", "relay.json", "version-policy.json", names[8]!]);
    expect(names[8]).toMatch(/^crash-reports\/\d+-[0-9a-f]{32}\.json$/);
    for (const f of listed) expect(f.bytes).toBeGreaterThan(0);

    const out = join(home, "bundle.zip");
    const res = (await r!.shell.call("diagnostics.create", { path: out })) as { path: string; bytes: number; files: DiagnosticFile[] };
    expect(res.path).toBe(out);
    expect(res.files.map((f) => f.name)).toEqual(names);
    const { files, text } = extract(out);
    expect([...files.keys()]).toEqual(names);
    expect(leaks(text)).toEqual([]);
    expect(text).not.toContain(home);
    expect(text).not.toContain(MOCK_KEY);
    expect(text).not.toContain(m.taskId);
    expect(text).not.toContain(m.threadId);

    const db = JSON.parse(new TextDecoder().decode(files.get("database.json")!));
    expect(db.schema_version).toBeNumber();
    expect(db.rows.tasks).toBe(1);
    const sched = JSON.parse(new TextDecoder().decode(files.get("scheduler.json")!));
    expect(sched.schedules[0]).toMatchObject({ task_id: expect.stringMatching(/^h:[0-9a-f]{12}$/), kind: "cron", enabled: true, fires: { done: 1 } });
    expect(sched.schedules[0].next_fire_at).toBeString();
  });

  test("nothing is overwritten; paths must be absolute zips; with none, Downloads", async () => {
    const { home } = await seeded();
    const fail = async (params: { path?: string }, code: number = RPC_ERROR.VALIDATION_FAILED) => {
      const e = await r!.shell.call("diagnostics.create", params).then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(RpcCallError);
      expect((e as RpcCallError).code).toBe(code);
      return (e as RpcCallError).message;
    };
    writeFileSync(join(home, "taken.zip"), "mine");
    expect(await fail({ path: join(home, "taken.zip") })).toContain("already exists");
    expect(require("node:fs").readFileSync(join(home, "taken.zip"), "utf8")).toBe("mine");
    expect(await fail({ path: join(home, "nope", "b.zip") })).toContain("doesn't exist");
    await fail({ path: "relative.zip" });
    await fail({ path: join(home, "b.txt") }, RPC_ERROR.INVALID_PARAMS);

    mkdirSync(join(home, "Downloads"));
    const a = (await r!.shell.call("diagnostics.create", {})) as { path: string };
    const b = (await r!.shell.call("diagnostics.create", {})) as { path: string };
    expect(a.path.startsWith(join(home, "Downloads", "homerun-diagnostics-"))).toBe(true);
    expect(b.path).not.toBe(a.path);
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
    expect(defaultPath(join(home, "no-downloads"), 0)).toStartWith(join(home, "no-downloads", "homerun-diagnostics-"));
  });

  test("the crash report setting over RPC", async () => {
    await seeded();
    const get = async () => ((await r!.shell.call("diagnostics.crash_reports.get", {})) as { settings: CrashReportSettings }).settings;
    expect(await get()).toEqual({ available: true, enabled: false });
    await r!.shell.call("diagnostics.crash_reports.set", { enabled: true });
    expect(await get()).toEqual({ available: true, enabled: true });
  });
});

describe("the crash report setting without a DSN", () => {
  test("is unavailable, and can't be turned on", async () => {
    r = await rig({ start: Date.UTC(2026, 0, 5, 0, 1) });
    expect(await r.shell.call("diagnostics.crash_reports.get", {})).toEqual({ settings: { available: false, enabled: false } });
    const e = await r.shell.call("diagnostics.crash_reports.set", { enabled: true }).then(() => null, (x: unknown) => x);
    expect((e as RpcCallError).code).toBe(RPC_ERROR.VALIDATION_FAILED);
  });
});

