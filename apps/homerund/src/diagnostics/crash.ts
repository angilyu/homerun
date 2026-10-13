import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { CrashReportSettings } from "@homerun/core";
import { log } from "../log";
import { getSetting, putSetting } from "../store/schedule-rows";
import type { Clock } from "../schedule/clock";
import type { Store } from "../store/store";
import { crashReport, parseCrashReport, type BuildInfo, type CrashKind, type CrashReport } from "./scrub";

/**
 * Opt-in crash reporting (§11 "Diagnostics"). Off by default, and offered only in a build with a
 * Sentry DSN compiled in.
 *
 * Crashes are written, already scrubbed (`scrub.ts`), to `<data>/crash-reports/`: the runtime's
 * own uncaught errors, and the shell's panics and the runtime exits its supervisor observes (the
 * shell writes the same format). Nothing leaves the machine unless the user turned reports on:
 * then each report written since is parsed through the allowlist again and posted to Sentry as an
 * envelope, by hand: a fetch, not an SDK (§18). Sent reports are deleted; unsent ones stay for the
 * diagnostic bundle, at most 20 and for 30 days.
 */

export const CRASH_DIR = "crash-reports";
export const SETTINGS_KEY = "crash_reports";
/** Reports kept on disk, newest first. */
export const MAX_SPOOLED = 20;
/** Reports older than this are deleted unsent. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REPORT_BYTES = 64 * 1024;
const SEND_TIMEOUT_MS = 15_000;
const RETRY_MS = 60 * 60 * 1000;

interface Stored {
  enabled: boolean;
  /** Only reports written after this are sent: turning reports on doesn't send old crashes. */
  enabled_at: number | null;
}

export function runtimeBuild(version: string, channel: string): BuildInfo {
  return { app: "homerund", os: osName(), arch: arch(), version, channel };
}

export function osName(p: NodeJS.Platform = platform()): string {
  return p === "darwin" ? "macos" : p === "win32" ? "windows" : p;
}

// ---------------------------------------------------------------- the spool

export function crashDir(dataDir: string): string {
  return join(dataDir, CRASH_DIR);
}

/** Write a report. Synchronous, so it works in an uncaught-exception handler. Never throws. */
export function spoolReport(dataDir: string, report: CrashReport): string | null {
  try {
    const dir = crashDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${report.at}-${report.id}.json`);
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify(report));
    } finally {
      closeSync(fd);
    }
    prune(dir);
    return path;
  } catch {
    return null;
  }
}

/** Scrub and spool a thrown value. */
export function spoolError(dataDir: string, e: unknown, kind: CrashKind, build: BuildInfo, at = Date.now()): string | null {
  try {
    return spoolReport(dataDir, crashReport(e, kind, build, at));
  } catch {
    return null;
  }
}

/** Every valid report on disk, oldest first. Files that don't pass the allowlist, or are over 30 days old, are deleted. */
export function readSpool(dataDir: string, now = Date.now()): Array<{ path: string; report: CrashReport }> {
  const dir = crashDir(dataDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const out: Array<{ path: string; report: CrashReport }> = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      if (statSync(path).size > MAX_REPORT_BYTES) throw new Error("too large");
      const report = parseCrashReport(JSON.parse(readFileSync(path, "utf8")));
      if (!report) throw new Error("not a crash report");
      if (report.at < now - MAX_AGE_MS) throw new Error("too old");
      out.push({ path, report });
    } catch {
      rmSync(path, { force: true });
    }
  }
  return out;
}

function prune(dir: string): void {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  for (const n of names.slice(0, Math.max(0, names.length - MAX_SPOOLED))) rmSync(join(dir, n), { force: true });
}

/**
 * Catch the runtime's own uncaught errors: spool a report, log, and exit 1 as before. The
 * supervisor restarts the runtime (§5.1) and records the exit itself.
 */
export function installCrashHandlers(dataDir: string, build: BuildInfo): void {
  const die = (kind: string) => (e: unknown) => {
    spoolError(dataDir, e, "runtime_exception", build);
    log.error(kind, { err: e instanceof Error ? e : String(e) });
    process.exit(1);
  };
  process.on("uncaughtException", die("uncaught exception"));
  process.on("unhandledRejection", die("unhandled rejection"));
}

// ---------------------------------------------------------------- Sentry

export interface Dsn {
  key: string;
  envelopeUrl: string;
}

/** `https://<public key>@<host>[/<path>]/<project id>` → the envelope endpoint. Null if malformed. */
export function parseDsn(dsn: string | null): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    if (u.protocol !== "https:" || !u.username) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? "/" + parts.join("/") : "";
    return { key: decodeURIComponent(u.username), envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/` };
  } catch {
    return null;
  }
}

/**
 * A Sentry envelope with one event built from the report's allowlisted fields only: no message,
 * no user, no server name, no breadcrumbs, no request, no contexts beyond OS and arch.
 */
export function envelope(r: CrashReport, sentAt: number): string {
  const event = {
    event_id: r.id,
    timestamp: r.at / 1000,
    platform: r.app === "shell" ? "native" : "javascript",
    level: "fatal",
    logger: r.app,
    release: `homerun@${r.version}`,
    environment: r.channel,
    tags: { app: r.app, kind: r.kind, os: r.os, arch: r.arch, ...(r.exit ? { exit_code: String(r.exit.code ?? ""), exit_signal: r.exit.signal ?? "" } : {}) },
    contexts: { os: { name: r.os }, device: { arch: r.arch } },
    exception: {
      values: [
        {
          type: r.exception_type,
          value: "",
          // Sentry lists frames oldest first.
          stacktrace: { frames: [...r.frames].reverse().map((f) => ({ function: f.function, module: f.module, filename: f.module, ...(f.lineno !== null ? { lineno: f.lineno } : {}), in_app: !f.module.startsWith("node_modules/") && !f.module.startsWith("<") })) },
        },
      ],
    },
  };
  const body = JSON.stringify(event);
  return [JSON.stringify({ event_id: r.id, sent_at: new Date(sentAt).toISOString() }), JSON.stringify({ type: "event", length: Buffer.byteLength(body) }), body].join("\n") + "\n";
}

export interface CrashReporterOptions {
  store: Store;
  dataDir: string;
  dsn: string | null;
  clock: Clock;
  version: string;
  fetch?: typeof fetch;
}

/** The setting, and sending what the spool holds when it is on. */
export class CrashReporter {
  private readonly dsn: Dsn | null;
  private sending: Promise<number> | null = null;
  private cancel: (() => void) | null = null;
  private stopped = false;

  constructor(private o: CrashReporterOptions) {
    this.dsn = parseDsn(o.dsn);
    if (o.dsn && !this.dsn) log.warn("the compiled-in crash report DSN is malformed; crash reporting is off");
  }

  /** Send what the last runs left, then retry hourly (a crash while offline is sent later). */
  start(): void {
    if (!this.dsn) return;
    void this.flush();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
  }

  private arm(): void {
    if (this.stopped) return;
    this.cancel = this.o.clock.setTimer(RETRY_MS, () => {
      this.cancel = null;
      void this.flush().finally(() => this.arm());
    });
  }

  settings(): CrashReportSettings {
    const s = getSetting<Stored>(this.o.store, SETTINGS_KEY);
    const available = this.dsn !== null;
    return { available, enabled: available && s?.enabled === true };
  }

  /** Turn reports on or off. False when this build has no endpoint. */
  set(enabled: boolean): CrashReportSettings | null {
    if (!this.dsn) return null;
    const cur = getSetting<Stored>(this.o.store, SETTINGS_KEY);
    if (enabled !== (cur?.enabled === true)) putSetting(this.o.store, SETTINGS_KEY, { enabled, enabled_at: enabled ? this.o.clock.now() : null } satisfies Stored);
    if (enabled) void this.flush();
    return this.settings();
  }

  /** Send every report written since reports were turned on. Resolves to the number sent. Never rejects. */
  flush(): Promise<number> {
    return (this.sending ??= this.send()
      .catch((e) => {
        log.info("sending crash reports failed; will retry", { error: e instanceof Error ? e.message : String(e) });
        return 0;
      })
      .finally(() => (this.sending = null)));
  }

  private async send(): Promise<number> {
    const s = getSetting<Stored>(this.o.store, SETTINGS_KEY);
    if (this.stopped || !this.dsn || !s?.enabled || s.enabled_at === null) return 0;
    let sent = 0;
    for (const { path, report } of readSpool(this.o.dataDir, this.o.clock.now())) {
      if (report.at < s.enabled_at) continue;
      const res = await (this.o.fetch ?? fetch)(this.dsn.envelopeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${this.dsn.key}, sentry_client=homerun/${this.o.version}`,
        },
        body: envelope(report, this.o.clock.now()),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // 4xx other than rate limiting won't succeed later: drop the report rather than retry forever.
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        rmSync(path, { force: true });
        if (res.ok) sent++;
        else log.warn("a crash report was refused", { status: res.status });
      } else throw new Error(`HTTP ${res.status}`);
    }
    if (sent) log.info("crash reports sent", { count: sent });
    return sent;
  }
}
