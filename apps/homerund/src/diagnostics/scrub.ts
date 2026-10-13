import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { scrub } from "../log";

/**
 * The diagnostics scrubber (§11 "Diagnostics"). Two tools, both allowlists:
 *
 * - `crashReport` keeps only what a crash report may carry: the exception's type, its stack frames
 *   (function, module path relative to the bundle, line), and the app, OS, arch, version and
 *   channel. The message is dropped, never cleaned: it is where prompts, tool input and output,
 *   paths, URLs and keys turn up. A frame whose path isn't inside the bundle is `<external>`.
 * - `redactLogLine` and `redactText` for the diagnostic bundle's logs: a structured line keeps its
 *   level, time and message and only the fields it can show safely; free text loses secrets,
 *   tokens, URLs, emails and the user's home.
 *
 * The crash report schema is strict, so a report another process wrote (the shell's panic hook)
 * is parsed through the same allowlist before it is uploaded or bundled.
 */

// ---------------------------------------------------------------- crash reports

export const CRASH_KINDS = ["runtime_exception", "runtime_exited", "shell_panic"] as const;
export type CrashKind = (typeof CRASH_KINDS)[number];

const IDENT = /^[A-Za-z_$][\w$]{0,99}$/;
/** A frame's function: identifiers, dots, and the engines' own markers. */
const FUNC = /^(?:async |new )?[A-Za-z_$<][\w$.<>]{0,149}$/;
/** A module path inside the bundle: relative, no spaces, no `..`. */
const MODULE = /^(?:[\w@$-][\w@$.-]*)(?:\/[\w@$-][\w@$.-]*){0,15}$/;
const SAFE_TAG = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;

export const CrashFrame = z.strictObject({
  function: z.string().regex(FUNC).or(z.literal("?")),
  module: z.string().regex(MODULE).or(z.enum(["<external>", "<native>"])),
  lineno: z.int().min(0).max(10_000_000).nullable(),
});
export type CrashFrame = z.infer<typeof CrashFrame>;

export const CrashReport = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[0-9a-f]{32}$/),
  kind: z.enum(CRASH_KINDS),
  at: z.int().nonnegative(),
  /** "homerund" or "shell". */
  app: z.enum(["homerund", "shell"]),
  exception_type: z.string().regex(IDENT),
  frames: z.array(CrashFrame).max(50),
  /** For `runtime_exited`: how it ended. */
  exit: z.strictObject({ code: z.int().nullable(), signal: z.string().regex(/^[A-Z0-9]{1,16}$/).nullable() }).optional(),
  os: z.string().regex(SAFE_TAG),
  arch: z.string().regex(SAFE_TAG),
  version: z.string().regex(SAFE_TAG),
  channel: z.string().regex(SAFE_TAG),
});
export type CrashReport = z.infer<typeof CrashReport>;

export interface BuildInfo {
  app: CrashReport["app"];
  os: string;
  arch: string;
  version: string;
  channel: string;
}

function tag(v: string): string {
  return SAFE_TAG.test(v) ? v : "unknown";
}

/**
 * A module path made relative to the bundle, or `<external>`. Recognised roots: a compiled
 * executable's virtual root (`$bunfs/root`, `~BUN/root`), the repository's `apps/` and `packages/`,
 * `node_modules/`, and a path that is already relative. Anything else, including any absolute
 * path that is none of these, says only `<external>`: it may name the user's own files.
 */
export function relativeModule(raw: string): string {
  let p = raw.trim().replace(/^file:\/\//, "").replace(/\\/g, "/");
  if (/^(node|bun):/.test(p)) return MODULE.test(p.replace(":", "/")) ? p.replace(":", "/") : "<native>";
  if (p === "native" || p === "[native code]") return "<native>";
  let rel: string | null = null;
  for (const [re, prefix] of ROOTS) {
    const m = re.exec(p);
    if (m) {
      rel = prefix + m[1];
      break;
    }
  }
  if (rel === null) {
    // Already relative: `src/x.ts`, `../../apps/…`, `shell-core/src/x.rs`. Never absolute.
    if (/^[A-Za-z]:\//.test(p) || p.startsWith("/") || p.startsWith("~")) return "<external>";
    rel = p.replace(/^(?:\.\.?\/)+/, "");
    // `../../../Users/alice/x.ts` must not become `Users/alice/x.ts`.
    if (!RELATIVE_FIRST.has(rel.split("/")[0]!)) return "<external>";
  }
  return MODULE.test(rel) && !rel.split("/").includes("..") ? rel : "<external>";
}

/** Absolute locations inside the bundle or a dependency, and what they become. */
const ROOTS: Array<[RegExp, string]> = [
  [/\/\$bunfs\/root\/(.*)$/, ""],
  [/~BUN\/root\/(.*)$/, ""],
  [/\/node_modules\/(.*)$/, "node_modules/"],
  [/\/\.cargo\/registry\/src\/[^/]+\/(.*)$/, "crates/"],
  [/^\/rustc\/[0-9a-f]+\/(.*)$/, "rustc/"],
  [/\/((?:apps|packages)\/[^/]+\/.*)$/, ""],
  [/\/(src-tauri\/.*)$/, ""],
];
/** A relative module must start with one of these: the repository's and the toolchains' own trees. */
const RELATIVE_FIRST = new Set(["src", "apps", "packages", "node_modules", "shell-core", "src-tauri", "crates", "rustc", "library", "lib"]);

function safeFunction(raw: string | undefined): string {
  const f = (raw ?? "").trim();
  return FUNC.test(f) ? f : "?";
}

/** V8 (`at fn (path:1:2)`, `at path:1:2`) and JSC (`fn@path:1:2`) frames. */
export function parseStack(stack: string | undefined, message?: string): CrashFrame[] {
  if (!stack) return [];
  // The message comes first and may span lines; none of it may be read as a frame.
  const body = message ? stack.split(message).join("") : stack;
  const out: CrashFrame[] = [];
  for (const line of body.split("\n")) {
    const l = line.trim();
    let fn: string | undefined;
    let loc: string | undefined;
    let m = /^at (?:(.+?) \()?(.+?)\)?$/.exec(l);
    if (m) {
      fn = m[1];
      loc = m[2];
    } else if ((m = /^([\w$.<>]*)@(.+:\d+:\d+)$/.exec(l))) {
      fn = m[1];
      loc = m[2];
    } else continue;
    if (!loc) continue;
    const lm = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(loc)!;
    out.push(CrashFrame.parse({ function: safeFunction(fn || "?"), module: relativeModule(lm[1]!), lineno: lm[2] ? Math.min(Number(lm[2]), 10_000_000) : null }));
    if (out.length >= 50) break;
  }
  return out;
}

/** An error's type: its constructor name if it is a plain identifier, else "Error". The message is dropped. */
export function exceptionType(e: unknown): string {
  const name = e instanceof Error ? e.name || e.constructor?.name : typeof e === "object" && e && "name" in e ? String((e as { name: unknown }).name) : "NonError";
  return typeof name === "string" && IDENT.test(name) ? name : "Error";
}

export function newReportId(): string {
  return randomBytes(16).toString("hex");
}

/** A crash report from a thrown value: type and frames only. */
export function crashReport(e: unknown, kind: CrashKind, build: BuildInfo, at: number): CrashReport {
  const stack = e instanceof Error ? e.stack : typeof e === "object" && e && "stack" in e ? String((e as { stack: unknown }).stack) : undefined;
  return CrashReport.parse({
    v: 1,
    id: newReportId(),
    kind,
    at,
    app: build.app,
    exception_type: exceptionType(e),
    frames: parseStack(stack, e instanceof Error ? e.message : undefined),
    os: tag(build.os),
    arch: tag(build.arch),
    version: tag(build.version),
    channel: tag(build.channel),
  });
}

/** A report read back from disk, through the allowlist again. Null when it isn't one. */
export function parseCrashReport(raw: unknown): CrashReport | null {
  const r = CrashReport.safeParse(raw);
  return r.success ? r.data : null;
}

// ---------------------------------------------------------------- free text and log lines

export interface Redactor {
  /** The user's home, replaced by `~`. */
  home: string;
  /** Opaque ids are replaced by a salted hash, consistent within one bundle. */
  hash(id: string): string;
}

export function newRedactor(home: string): Redactor {
  const salt = randomBytes(16);
  return { home, hash: (id) => "h:" + createHash("sha256").update(salt).update(id).digest("hex").slice(0, 12) };
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_RE = /\b(Bearer|Basic|token|key|secret|password|passwd|authorization)(["':=\s]+)[^\s"',;]{6,}/gi;
/** Long opaque strings (keys, tokens, hashes): 32+ base64url/hex characters. */
const OPAQUE_RE = /\b[A-Za-z0-9_+/-]{32,}={0,2}/g;
/** The rest of a path after the home folder: up to whitespace, a quote or a bracket. */
const PATH_REST = String.raw`(?:[\\/][^\s"'<>()\[\]]*)?`;
const HOME_PATHS = [new RegExp(String.raw`/Users/[^/\s"']+` + PATH_REST, "g"), new RegExp(String.raw`/home/[^/\s"']+` + PATH_REST, "g"), new RegExp(String.raw`[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+` + PATH_REST, "gi")];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Free text with secrets, tokens, URLs, emails and paths under the home folder removed. A path
 * under home becomes `~/[path]` whole: its folder and file names are the user's.
 */
export function redactText(text: string, r: Redactor): string {
  let out = scrub(text);
  if (r.home && r.home.length > 1) out = out.replace(new RegExp(escapeRe(r.home) + PATH_REST, "g"), (m) => (m.length > r.home.length ? "~/[path]" : "~"));
  for (const re of HOME_PATHS) out = out.replace(re, "~/[path]");
  return out
    .replace(URL_RE, "[url]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(BEARER_RE, "$1$2[REDACTED]")
    .replace(EMAIL_RE, "[email]")
    .replace(OPAQUE_RE, "[REDACTED]");
}

/** Fields whose values are ids: hashed so lines still correlate. */
const ID_KEYS = new Set(["run_id", "thread_id", "task_id", "schedule_id", "request_id", "device_id", "offer_id", "token_id", "session_id", "client_msg_id", "account_id", "conn"]);
/** Fields kept as text (redacted, truncated): they describe what happened, not the user's content. */
const TEXT_KEYS = new Set(["msg", "level", "src", "t", "error", "err", "reason", "why", "outcome", "state", "kind", "method", "phase", "build", "version", "cause", "code", "signal", "status", "detail", "event"]);
const MAX_FIELD = 300;

function redactValue(key: string, v: unknown, r: Redactor, depth: number): unknown {
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (ID_KEYS.has(key)) return r.hash(v);
    if (TEXT_KEYS.has(key)) return redactText(v, r).slice(0, MAX_FIELD);
    return "[redacted]";
  }
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redactValue(key, x, r, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // An error object: its type, a redacted message, no stack (paths and quoted input).
      if (k === "stack") continue;
      out[k] = redactValue(TEXT_KEYS.has(key) && (k === "message" || k === "name") ? key : k, x, r, depth + 1);
    }
    return out;
  }
  return "[redacted]";
}

/**
 * One log line for the bundle. A JSON line keeps every field's key; values survive only if they
 * are numbers, booleans, ids (hashed) or descriptive text (redacted); anything else, such as a
 * `text` or `prompt` field, becomes "[redacted]". Other lines keep only their length, unless they
 * are stack frames.
 */
export function redactLogLine(line: string, r: Redactor): string {
  const t = line.trim();
  if (t.startsWith("{")) {
    try {
      const rec = JSON.parse(t) as Record<string, unknown>;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rec)) out[k] = redactValue(k, v, r, 0);
        return JSON.stringify(out);
      }
    } catch {}
  }
  // Raw stderr (a crash printout, a child's output) can quote anything: keep only stack frames and
  // the runtime banner, and the size of the rest.
  if (/^\s*at\s/.test(line) || /^Bun v\d/.test(t)) return redactText(line, r).slice(0, 300);
  return t === "" ? "" : `[text: ${line.length} chars]`;
}
