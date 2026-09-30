import { userInfo } from "node:os";
import { canonicalPath, expandTilde, hostPathOps, isNetworkOrDevicePath, msysToWin, normalizeWin, pathApi, type PathOps } from "./paths";

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
 * under a denied directory is caught. On macOS and Windows the comparison ignores case, as their
 * file systems do.
 *
 * Windows (milestone 8b): the entries are the Windows locations (below); a path is normalised
 * first (`\\?\` prefixes, alternate streams, trailing dots and spaces, `/c/…` MSYS forms), its
 * canonical form comes from the native realpath (junctions, symlinks, 8.3 short names), and a
 * UNC or device path is refused outright, before anything touches the file system.
 *
 * Second layer (§13): `sdkDenyRules` expresses the same paths as the SDK's path-scoped deny
 * rules (`Read(//path/**)`, `Edit(//path/**)`), passed as flag settings. `claude` applies them
 * even when the hook allows a call; checked against the bundled `claude` 2.1.278.
 */

export type DenyCategory = "ssh" | "keychain" | "browser" | "credentials" | "env_file" | "homerun_data" | "network_path";

const LABEL: Record<DenyCategory, string> = {
  ssh: "SSH keys",
  keychain: "the keychain",
  browser: "browser profiles",
  credentials: "credential files",
  env_file: ".env files",
  homerun_data: "Homerun's own data",
  network_path: "network or device paths",
};

const LABEL_WIN: Partial<Record<DenyCategory, string>> = { keychain: "Windows credentials" };

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

/** Windows, relative to `%USERPROFILE%`. */
const WIN_HOME_ENTRIES: ReadonlyArray<readonly [string, DenyCategory]> = [
  [".ssh", "ssh"],
  [".aws\\credentials", "credentials"],
  [".netrc", "credentials"],
  ["_netrc", "credentials"],
  [".docker\\config.json", "credentials"],
  [".npmrc", "credentials"],
  [".pypirc", "credentials"],
  [".kube\\config", "credentials"],
  [".gnupg", "credentials"],
];

/** Windows, relative to `%APPDATA%` (roaming). */
const WIN_APPDATA_ENTRIES: ReadonlyArray<readonly [string, DenyCategory]> = [
  ["Microsoft\\Credentials", "keychain"],
  ["Microsoft\\Protect", "keychain"],
  ["Microsoft\\Vault", "keychain"],
  ["Mozilla\\Firefox", "browser"],
  ["Opera Software", "browser"],
  ["GitHub CLI\\hosts.yml", "credentials"],
  ["gnupg", "credentials"],
];

/** Windows, relative to `%LOCALAPPDATA%`. */
const WIN_LOCALAPPDATA_ENTRIES: ReadonlyArray<readonly [string, DenyCategory]> = [
  ["Microsoft\\Credentials", "keychain"],
  ["Microsoft\\Vault", "keychain"],
  ["Google\\Chrome\\User Data", "browser"],
  ["Google\\Chrome Beta\\User Data", "browser"],
  ["Google\\Chrome SxS\\User Data", "browser"],
  ["Chromium\\User Data", "browser"],
  ["Microsoft\\Edge\\User Data", "browser"],
  ["BraveSoftware", "browser"],
  ["Mozilla\\Firefox", "browser"],
  // The release data dir, when this runtime uses another one (development, tests).
  ["Homerun", "homerun_data"],
];

/** Store-packaged browsers live under `%LOCALAPPDATA%\Packages\<family name>_<publisher id>`. */
const WIN_PACKAGE_PREFIXES: ReadonlyArray<readonly [string, DenyCategory]> = [["TheBrowserCompany.Arc_", "browser"]];

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
  /** Windows: `%APPDATA%` and `%LOCALAPPDATA%`; by default under the first home. */
  appData?: string;
  localAppData?: string;
  /** The host's path syntax and file system unless given (tests). */
  ops?: PathOps;
}

export function denylistConfig(
  cfg: { userHome: string; dataDir: string; workspacesDir: string; claudeConfigDir: string; tmpDir: string },
  env: Record<string, string | undefined> = process.env,
): DenylistConfig {
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
    caseInsensitive: process.platform === "darwin" || process.platform === "win32",
    ...(process.platform === "win32" && env.APPDATA ? { appData: env.APPDATA } : {}),
    ...(process.platform === "win32" && env.LOCALAPPDATA ? { localAppData: env.LOCALAPPDATA } : {}),
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

const opsOf = (c: DenylistConfig) => c.ops ?? hostPathOps;
const isWin = (c: DenylistConfig) => opsOf(c).flavor === "win32";
const P = (c: DenylistConfig) => pathApi(opsOf(c));

function entries(c: DenylistConfig): Entry[] {
  const out: Entry[] = [];
  const { join } = P(c);
  if (isWin(c)) {
    const home = c.homes[0]!;
    const appData = c.appData ?? join(home, "AppData", "Roaming");
    const local = c.localAppData ?? join(home, "AppData", "Local");
    for (const h of c.homes) for (const [rel, category] of WIN_HOME_ENTRIES) out.push({ path: join(h, rel), category });
    for (const [rel, category] of WIN_APPDATA_ENTRIES) out.push({ path: join(appData, rel), category });
    for (const [rel, category] of WIN_LOCALAPPDATA_ENTRIES) out.push({ path: join(local, rel), category });
    const packages = join(local, "Packages");
    for (const name of listDir(c, packages)) {
      const hit = WIN_PACKAGE_PREFIXES.find(([prefix]) => name.toLowerCase().startsWith(prefix.toLowerCase()));
      if (hit) out.push({ path: join(packages, name), category: hit[1] });
    }
  } else {
    for (const h of c.homes) for (const [rel, category] of HOME_ENTRIES) out.push({ path: join(h, rel), category });
    for (const [path, category] of ABSOLUTE_ENTRIES) out.push({ path, category });
  }
  out.push({ path: c.dataDir, category: "homerun_data" });
  return out;
}

/** A path as given and canonical: both must stay clear of every entry. */
function forms(c: DenylistConfig, p: string): string[] {
  const { resolve } = P(c);
  const a = resolve(isWin(c) ? normalizeWin(p) : p);
  return [...new Set([a, canonicalPath(a, opsOf(c))])];
}

function fold(c: DenylistConfig, p: string): string {
  return c.caseInsensitive ? p.toLowerCase() : p;
}

function under(c: DenylistConfig, p: string, dir: string): boolean {
  const { sep } = P(c);
  const a = fold(c, p);
  const d = fold(c, dir);
  return a === d || a.startsWith(d.endsWith(sep) ? d : d + sep);
}

function underAny(c: DenylistConfig, p: string, dir: string): boolean {
  return forms(c, dir).some((d) => under(c, p, d));
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
  const { relative, sep } = P(c);
  for (const scratch of [c.claudeConfigDir, c.tmpDir]) {
    for (const d of forms(c, scratch)) {
      if (!under(c, p, d)) continue;
      const segs = relative(d, p).split(sep);
      // The session's own directory, not a sibling file such as `<session>.jsonl`.
      if (segs.slice(0, -1).some((s) => fold(c, s) === fold(c, sessionId))) return true;
    }
  }
  return false;
}

/**
 * The fixed directory part of a glob pattern (`/a/b/*.ts` → `/a/b`). On Windows both separators
 * split it, and a `\` is a separator, not an escape.
 */
export function globPrefix(pattern: string, ops: Pick<PathOps, "flavor"> = hostPathOps): string {
  const win = ops.flavor === "win32";
  const segs = pattern.split(win ? /[\\/]/ : "/");
  const i = segs.findIndex((s) => /[*?[{]/.test(s));
  const rooted = win ? /^([a-zA-Z]:)?[\\/]/.test(pattern) : pattern.startsWith("/");
  return (i < 0 ? segs : segs.slice(0, i)).join(win ? "\\" : "/") || (rooted ? (win ? "\\" : "/") : ".");
}

/** The paths a file tool touches, absolute. Empty for other tools. */
export function pathsOf(tool: string, input: unknown, cwd: string, home: string, ops: PathOps = hostPathOps): string[] {
  const { resolve } = pathApi(ops);
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const abs = (p: string) => resolve(cwd, expandTilde(ops.flavor === "win32" ? normalizeWin(p) : p, home, ops));
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
      return pattern ? [base, resolve(base, expandTilde(globPrefix(pattern, ops), home, ops))] : [base];
    }
    default:
      return [];
  }
}

/** The denylist entry a call would touch, or null (§13). */
export function denylistHit(c: DenylistConfig, q: { tool: string; input: unknown; cwd: string; sessionId: string | null }): DenyHit | null {
  if (!READ_TOOLS.has(q.tool) && !WRITE_TOOLS.has(q.tool)) return null;
  const write = WRITE_TOOLS.has(q.tool);
  const label = (k: DenyCategory) => (isWin(c) ? LABEL_WIN[k] : undefined) ?? LABEL[k];
  const refuse = (category: DenyCategory, path: string): DenyHit => ({
    category,
    path,
    reason: `Homerun never lets the agent ${write ? "change" : "read"} ${label(category)}. This call was not run.`,
  });
  if (isWin(c)) {
    // Lexically, before `forms` touches the file system: resolving a UNC path would connect.
    const raw = rawPathsOf(q.tool, q.input);
    const bad = [...raw, q.cwd].find((p) => isNetworkOrDevicePath(p));
    if (bad !== undefined) return refuse("network_path", bad);
  }
  const { basename } = P(c);
  const list = entries(c);
  const givens = pathsOf(q.tool, q.input, q.cwd, c.homes[0]!, opsOf(c));
  if (isWin(c)) {
    // A tool may also read `/c/Users/…` as `C:\Users\…`: check that spelling too.
    for (const raw of rawPathsOf(q.tool, q.input)) {
      const m = msysToWin(q.tool === "Glob" && raw === (q.input as { pattern?: unknown }).pattern ? globPrefix(raw, opsOf(c)) : raw);
      if (m) givens.push(m);
    }
  }
  for (const given of givens) {
    for (const p of forms(c, given)) {
      let category: DenyCategory | null = ENV_FILE.test(c.caseInsensitive ? basename(p).toLowerCase() : basename(p)) ? "env_file" : null;
      if (!category) {
        const e = list.find((e) => underAny(c, p, e.path) && !(e.category === "homerun_data" && dataDirException(c, p, write, q.sessionId)));
        category = e?.category ?? null;
      }
      if (category) return refuse(category, given);
    }
  }
  return null;
}

/** The path strings a file tool names, as given, for the lexical checks. */
function rawPathsOf(tool: string, input: unknown): string[] {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const keys = tool === "NotebookEdit" ? ["notebook_path"] : tool === "Glob" ? ["path", "pattern"] : tool === "Grep" ? ["path"] : ["file_path"];
  return keys.map((k) => i[k]).filter((v): v is string => typeof v === "string" && v !== "");
}

/** Escape gitignore metacharacters in a literal path. */
function lit(p: string): string {
  return p.replace(/[\\*?[\]]/g, "\\$&");
}

/**
 * A path as `claude`'s permission rules spell it: POSIX form on Windows (`C:\Users\a` is `/c/Users/a`,
 * so the rule is `//c/Users/a/**`).
 */
function ruleForm(c: DenylistConfig, p: string): string {
  if (!isWin(c)) return lit(p);
  const m = /^([a-zA-Z]):[\\/]?(.*)$/.exec(p);
  return m ? `/${m[1]!.toLowerCase()}/${lit(m[2]!.replace(/\\/g, "/"))}`.replace(/\/$/, "") : lit(p.replace(/\\/g, "/"));
}

/** Names always denied in the data dir, besides whatever is there at launch. */
const DATA_DIR_NAMES = ["homerun.db", "homerun.db-wal", "homerun.db-shm", "backups", "logs", "run", "shell-home", "components"];

function listDir(c: DenylistConfig, d: string): string[] {
  try {
    return opsOf(c).readdir(d);
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
  const { basename, join, resolve, sep } = P(c);
  const both = (p: string, children = true) => {
    for (const f of forms(c, p)) {
      for (const tool of ["Read", "Edit"]) {
        rules.add(`${tool}(/${ruleForm(c, f)})`);
        if (children) rules.add(`${tool}(/${ruleForm(c, f)}/**)`);
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
  for (const name of new Set([...DATA_DIR_NAMES, ...listDir(c, c.dataDir)])) if (!skip.has(name)) both(join(c.dataDir, name));
  for (const scratch of [c.claudeConfigDir, c.tmpDir].filter(inData)) {
    for (const f of forms(c, scratch)) one("Edit", `/${ruleForm(c, f)}/**`);
  }
  if (inData(c.claudeConfigDir)) {
    for (const name of listDir(c, c.claudeConfigDir)) if (name !== "projects") for (const f of forms(c, join(c.claudeConfigDir, name))) {
      one("Read", `/${ruleForm(c, f)}`);
      one("Read", `/${ruleForm(c, f)}/**`);
    }
    for (const f of forms(c, join(c.claudeConfigDir, "projects"))) one("Read", `/${ruleForm(c, f)}/**/*.jsonl`);
  }
  if (inData(c.tmpDir)) for (const f of forms(c, c.tmpDir)) one("Read", `/${ruleForm(c, f)}/claude-resume-*/**`);
  return [...rules];
}
