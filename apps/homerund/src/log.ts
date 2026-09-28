/**
 * Structured logging to stderr (the shell captures it into logs/homerund.log). Every line is
 * scrubbed of registered secret values first: the runtime holds the API key in memory (§5.2) and
 * it must never reach a log, even through an error message that happens to quote it.
 */

const secrets = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= 8) secrets.add(value);
}

export function forgetSecret(value: string): void {
  secrets.delete(value);
}

export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[(process.env.HOMERUN_LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
let sink: (line: string) => void = (line) => process.stderr.write(line + "\n");

export function setLogSink(fn: (line: string) => void, level: Level = "info"): void {
  sink = fn;
  threshold = LEVELS[level];
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  let line: string;
  try {
    line = JSON.stringify(rec, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
  } catch {
    line = JSON.stringify({ t: rec.t, level, msg });
  }
  sink(scrub(line));
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};
