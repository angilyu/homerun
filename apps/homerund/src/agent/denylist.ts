import { readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { canonicalPath, expandTilde } from "./paths";

/**
 * The hard denylist (§5.5, §13): paths no file tool may touch, whatever the task's roots, even
 * inside a declared root, and whatever the user answers. A hit is a plain `denied` decision:
 * no input request, no approval, no grant, and `--dev-auto-approve` never sees it, because the
 * policy decides it before any of those.
 *
 * Covered: `Read`, `Write`, `Edit`, `NotebookEdit` (their file path), and `Glob` and `Grep`
 * (their search path, plus the fixed prefix of an absolute `Glob` pattern). Results of a search
 * are not filtered: a search rooted above a denied directory is not refused here, and the SDK
 * deny rules below apply to it best-effort. `Bash` is out of scope: it is `destructive` and
 * gated on every call unless a pattern classifies the command (§5.5).
 *
 * Paths are compared both as given (absolute, `~` expanded) and canonical (realpath of the
 * nearest existing ancestor), so a symlink or `..` can't get around an entry, and a new file
 * under a denied directory is caught. On macOS the comparison ignores case, as the default
 * file system does.
 *
 * Second layer (§13): `sdkDenyRules` expresses the same paths as the SDK's path-scoped deny
 * rules (`Read(//path/**)`, `Edit(//path/**)`), passed as flag settings. `claude` applies them
 * even when the hook allows a call; checked against the bundled `claude` 2.1.278.
 */

export type DenyCategory = "ssh" | "keychain" | "browser" | "credentials" | "env_file" | "homerun_data";

const LABEL: Record<DenyCategory, string> = {
  ssh: "SSH keys",
  keychain: "the keychain",
  browser: "browser profiles",
  credentials: "credential files",
  env_file: ".env files",
  homerun_data: "Homerun's own data",
};

/** Relative to the user's home. Each entry covers the path itself and everything under it. */
const HOME_ENTRIES: ReadonlyArray<readonly [string, DenyCategory]> = [
  [".ssh", "ssh"],
  ["Library/Keychains", "keychain"],
  ["Library/Safari", "browser"],
  ["Library/Containers/com.apple.Safari", "browser"],
  ["Library/Application Support/Google/Chrome", "browser"],
  ["Library/Application Support/Google/Chrome Beta", "browser"],
  ["Library/Application Support/Google/Chrome Canary", "browser"],
  ["Library/Application Support/Chromium", "browser"],
  ["Library/Application Support/Microsoft Edge", "browser"],
  ["Library/Application Support/BraveSoftware", "browser"],
  ["Library/Application Support/Arc", "browser"],
  ["Library/Application Support/Firefox", "browser"],
  // The same browsers on Linux, where CI runs.
  [".config/google-chrome", "browser"],
  [".config/chromium", "browser"],
  [".config/microsoft-edge", "browser"],
  [".config/BraveSoftware", "browser"],
  [".mozilla", "browser"],
  [".aws/credentials", "credentials"],
  [".netrc", "credentials"],
  [".config/gh/hosts.yml", "credentials"],
  [".docker/config.json", "credentials"],
  [".npmrc", "credentials"],
  [".pypirc", "credentials"],
  [".kube/config", "credentials"],
  [".gnupg", "credentials"],
  // The release data dir, when this runtime uses another one (development, tests).
  ["Library/Application Support/Homerun", "homerun_data"],
];

const ABSOLUTE_ENTRIES: ReadonlyArray<readonly [string, DenyCategory]> = [["/Library/Keychains", "keychain"]];

/** Any file named `.env` or `.env.*`, anywhere. */
const ENV_FILE = /^\.env(\..*)?$/;

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);

export interface DenylistConfig {
  /** The user's home directories (`HOME` and the account's), deduplicated. */
  homes: readonly string[];
  dataDir: string;
  /** Runs' default roots live here, inside the data dir: not denied. */
  workspacesDir: string;
  /** `claude`'s own scratch: readable for the current session only (below). */
  claudeConfigDir: string;
  tmpDir: string;
  caseInsensitive: boolean;
}

export function denylistConfig(cfg: { userHome: string; dataDir: string; workspacesDir: string; claudeConfigDir: string; tmpDir: string }): DenylistConfig {
  let account: string | null = null;
  try {
    account = userInfo().homedir;
  } catch {
    // no passwd entry
  }
  return {
    homes: [...new Set([cfg.userHome, ...(account ? [account] : [])])],
    dataDir: cfg.dataDir,
    workspacesDir: cfg.workspacesDir,
    claudeConfigDir: cfg.claudeConfigDir,
    tmpDir: cfg.tmpDir,
    caseInsensitive: process.platform === "darwin",
  };
}

export interface DenyHit {
  category: DenyCategory;
  path: string;
  reason: string;
}

interface Entry {
  path: string;
  category: DenyCategory;
}

function entries(c: DenylistConfig): Entry[] {
  const out: Entry[] = [];
  for (const h of c.homes) for (const [rel, category] of HOME_ENTRIES) out.push({ path: join(h, rel), category });
  for (const [path, category] of ABSOLUTE_ENTRIES) out.push({ path, category });
  out.push({ path: c.dataDir, category: "homerun_data" });
  return out;
}

/** A path as given and canonical: both must stay clear of every entry. */
function forms(p: string): string[] {
  const a = resolve(p);
  const b = canonicalPath(a);
  return a === b ? [a] : [a, b];
}

function fold(c: DenylistConfig, p: string): string {
  return c.caseInsensitive ? p.toLowerCase() : p;
}

function under(c: DenylistConfig, p: string, dir: string): boolean {
  const a = fold(c, p);
  const d = fold(c, dir);
  return a === d || a.startsWith(d.endsWith(sep) ? d : d + sep);
}

function underAny(c: DenylistConfig, p: string, dir: string): boolean {
  return forms(dir).some((d) => under(c, p, d));
}

/**
 * Inside the data dir, only the workspaces, and `claude`'s own files for the current session
 * (read only): the large tool results it saves under `CLAUDE_CONFIG_DIR/projects/…/<session>/`
 * and background task output under `TMPDIR/…/<session>/`, which it tells the model to `Read`.
 * Other sessions' transcripts and output stay denied.
 */
function dataDirException(c: DenylistConfig, p: string, write: boolean, sessionId: string | null): boolean {
  if (underAny(c, p, c.workspacesDir)) return true;
  if (write || !sessionId) return false;
  for (const scratch of [c.claudeConfigDir, c.tmpDir]) {
    for (const d of forms(scratch)) {
      if (!under(c, p, d)) continue;
      const segs = relative(d, p).split(sep);
      // The session's own directory, not a sibling file such as `<session>.jsonl`.
      if (segs.slice(0, -1).some((s) => fold(c, s) === fold(c, sessionId))) return true;
    }
  }
  return false;
}

/** The fixed directory part of a glob pattern (`/a/b/*.ts` → `/a/b`). */
function globPrefix(pattern: string): string {
  const segs = pattern.split("/");
  const i = segs.findIndex((s) => /[*?[{]/.test(s));
  return (i < 0 ? segs : segs.slice(0, i)).join("/") || (pattern.startsWith("/") ? "/" : ".");
}

/** The paths a file tool touches, absolute. Empty for other tools. */
export function pathsOf(tool: string, input: unknown, cwd: string, home: string): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const abs = (p: string) => resolve(cwd, expandTilde(p, home));
  switch (tool) {
    case "Read":
    case "Write":
    case "Edit":
      return str(i.file_path) ? [abs(str(i.file_path)!)] : [];
    case "NotebookEdit":
      return str(i.notebook_path) ? [abs(str(i.notebook_path)!)] : [];
    case "Grep":
      return [abs(str(i.path) ?? cwd)];
    case "Glob": {
      const base = abs(str(i.path) ?? cwd);
      const pattern = str(i.pattern);
      return pattern ? [base, resolve(base, expandTilde(globPrefix(pattern), home))] : [base];
    }
    default:
      return [];
  }
}

/** The denylist entry a call would touch, or null (§13). */
export function denylistHit(c: DenylistConfig, q: { tool: string; input: unknown; cwd: string; sessionId: string | null }): DenyHit | null {
  if (!READ_TOOLS.has(q.tool) && !WRITE_TOOLS.has(q.tool)) return null;
  const write = WRITE_TOOLS.has(q.tool);
  const list = entries(c);
  for (const given of pathsOf(q.tool, q.input, q.cwd, c.homes[0]!)) {
    for (const p of forms(given)) {
      let category: DenyCategory | null = ENV_FILE.test(c.caseInsensitive ? basename(p).toLowerCase() : basename(p)) ? "env_file" : null;
      if (!category) {
        const e = list.find((e) => underAny(c, p, e.path) && !(e.category === "homerun_data" && dataDirException(c, p, write, q.sessionId)));
        category = e?.category ?? null;
      }
      if (category) {
        return { category, path: given, reason: `Homerun never lets the agent ${write ? "change" : "read"} ${LABEL[category]}. This call was not run.` };
      }
    }
  }
  return null;
}

/** Escape gitignore metacharacters in a literal path. */
function lit(p: string): string {
  return p.replace(/[\\*?[\]]/g, "\\$&");
}

/** Names always denied in the data dir, besides whatever is there at launch. */
const DATA_DIR_NAMES = ["homerun.db", "homerun.db-wal", "homerun.db-shm", "backups", "logs", "run", "shell-home", "components"];

function listDir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

/**
 * The denylist as the SDK's path-scoped deny rules (§13, second layer). Rules can't carve out
 * exceptions, so inside the data dir they name its parts: everything but `workspaces/` for
 * edits, and for reads also not `claude-config/projects/` or `tmp/` (the session's own scratch,
 * above) beyond the transcripts in them. The rules are matched by `claude`; the hook remains
 * the authority for symlinks, case and the per-session exception.
 */
export function sdkDenyRules(c: DenylistConfig): string[] {
  const rules = new Set<string>();
  const both = (p: string, children = true) => {
    for (const f of forms(p)) {
      for (const tool of ["Read", "Edit"]) {
        rules.add(`${tool}(/${lit(f)})`);
        if (children) rules.add(`${tool}(/${lit(f)}/**)`);
      }
    }
  };
  const one = (tool: "Read" | "Edit", rule: string) => rules.add(`${tool}(${rule})`);
  for (const e of entries(c)) if (e.category !== "homerun_data" || e.path !== c.dataDir) both(e.path);
  for (const tool of ["Read", "Edit"] as const) {
    one(tool, "//**/.env");
    one(tool, "//**/.env.*");
  }
  const inData = (d: string) => resolve(d).startsWith(resolve(c.dataDir) + sep);
  const skip = new Set([c.workspacesDir, c.claudeConfigDir, c.tmpDir].filter(inData).map((d) => basename(d)));
  for (const name of new Set([...DATA_DIR_NAMES, ...listDir(c.dataDir)])) if (!skip.has(name)) both(join(c.dataDir, name));
  for (const scratch of [c.claudeConfigDir, c.tmpDir].filter(inData)) {
    for (const f of forms(scratch)) one("Edit", `/${lit(f)}/**`);
  }
  if (inData(c.claudeConfigDir)) {
    for (const name of listDir(c.claudeConfigDir)) if (name !== "projects") for (const f of forms(join(c.claudeConfigDir, name))) {
      one("Read", `/${lit(f)}`);
      one("Read", `/${lit(f)}/**`);
    }
    for (const f of forms(join(c.claudeConfigDir, "projects"))) one("Read", `/${lit(f)}/**/*.jsonl`);
  }
  if (inData(c.tmpDir)) for (const f of forms(c.tmpDir)) one("Read", `/${lit(f)}/claude-resume-*/**`);
  return [...rules];
}
