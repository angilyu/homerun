import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { denylistHit, globPrefix, sdkDenyRules, type DenylistConfig } from "../../src/agent/denylist";
import { canonicalPath, isNetworkOrDevicePath, msysToWin, normalizeWin, type PathOps } from "../../src/agent/paths";

// §5.5, §13, milestone 8b: the hard denylist's Windows entries and path rules. A fake,
// case-insensitive Windows file system with a junction and an 8.3 short name runs them on any OS;
// the last block repeats the essentials against the real file system on Windows.

const HOME = "C:\\Users\\Ada";
const LOCAL = `${HOME}\\AppData\\Local`;
const ROAMING = `${HOME}\\AppData\\Roaming`;
const DATA = `${LOCAL}\\Homerun`;
const ROOT = `${HOME}\\proj`;

const FILES = [
  `${HOME}\\.ssh\\id_rsa`,
  `${HOME}\\.aws\\config`,
  `${ROOT}\\src\\a.ts`,
  `${LOCAL}\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\x`,
  `${LOCAL}\\Packages\\Microsoft.WindowsCalculator_8wekyb3d8bbwe\\x`,
  `${DATA}\\homerun.db`,
  `${DATA}\\workspaces\\t1\\notes.md`,
  `${DATA}\\claude-config\\projects\\p\\sess-1\\tool-results\\r.txt`,
  `${DATA}\\claude-config\\projects\\p\\sess-2\\tool-results\\r.txt`,
  `${DATA}\\claude-config\\settings.json`,
  `${DATA}\\tmp\\u\\p\\sess-1\\tasks\\out.txt`,
  `${DATA}\\logs\\homerund.log`,
];
/** Each `from` is a junction (or an 8.3 alias) for `to`. */
const LINKS: ReadonlyArray<readonly [string, string]> = [
  [`${ROOT}\\keys`, `${HOME}\\.ssh`],
  ["C:\\Users\\ADA~1", HOME],
];

const byLower = new Map<string, string>();
for (const f of FILES) {
  let p = f;
  for (;;) {
    byLower.set(p.toLowerCase(), p);
    const up = win32.dirname(p);
    if (up === p) break;
    p = up;
  }
}
for (const [from] of LINKS) byLower.set(from.toLowerCase(), from);

const touched: string[] = [];
function follow(p: string): string {
  let l = p.toLowerCase();
  for (const [from, to] of LINKS) {
    const f = from.toLowerCase();
    if (l === f || l.startsWith(`${f}\\`)) l = to.toLowerCase() + l.slice(f.length);
  }
  return l;
}
const fakeOps: PathOps = {
  flavor: "win32",
  exists(p) {
    touched.push(p);
    return byLower.has(follow(p));
  },
  realpath(p) {
    touched.push(p);
    const hit = byLower.get(follow(p));
    if (!hit) throw new Error(`ENOENT ${p}`);
    return hit;
  },
  readdir(p) {
    touched.push(p);
    const d = follow(p);
    const names = new Set<string>();
    for (const [l, canon] of byLower) if (win32.dirname(l) === d && l !== d) names.add(win32.basename(canon));
    return [...names];
  },
};

const cfg = (over: Partial<DenylistConfig> = {}): DenylistConfig => ({
  homes: [HOME],
  dataDir: DATA,
  workspacesDir: `${DATA}\\workspaces`,
  claudeConfigDir: `${DATA}\\claude-config`,
  tmpDir: `${DATA}\\tmp`,
  caseInsensitive: true,
  appData: ROAMING,
  localAppData: LOCAL,
  ops: fakeOps,
  ...over,
});

type Q = { cwd?: string; sessionId?: string | null };
const hit = (tool: string, input: unknown, q: Q = {}) =>
  denylistHit(cfg(), { tool, input, cwd: q.cwd ?? ROOT, sessionId: q.sessionId ?? null });
const read = (p: string, q: Q = {}) => hit("Read", { file_path: p }, q)?.category ?? null;
const write = (p: string, q: Q = {}) => hit("Write", { file_path: p, content: "x" }, q)?.category ?? null;

describe("Windows paths (§5.5)", () => {
  test("normalised the way Win32 opens them", () => {
    expect(normalizeWin("c:/Users/Ada/.ssh/id_rsa")).toBe("c:\\Users\\Ada\\.ssh\\id_rsa");
    expect(normalizeWin("\\\\?\\C:\\Users\\Ada")).toBe("C:\\Users\\Ada");
    expect(normalizeWin("\\??\\C:\\Users\\Ada")).toBe("C:\\Users\\Ada");
    expect(normalizeWin("\\\\.\\C:\\Users\\Ada")).toBe("C:\\Users\\Ada");
    expect(normalizeWin("C:\\a\\id_rsa::$DATA")).toBe("C:\\a\\id_rsa");
    expect(normalizeWin("C:\\a\\.ssh:x\\id_rsa")).toBe("C:\\a\\.ssh\\id_rsa");
    expect(normalizeWin("C:\\a\\.ssh. . \\id_rsa")).toBe("C:\\a\\.ssh\\id_rsa");
    expect(normalizeWin("..\\.ssh")).toBe("..\\.ssh");
    expect(normalizeWin("\\\\?\\UNC\\srv\\share\\x")).toBe("\\\\srv\\share\\x");
  });

  test("network and device paths, lexically", () => {
    for (const p of ["\\\\srv\\share\\x", "//srv/share/x", "\\\\?\\UNC\\srv\\share", "\\\\.\\pipe\\x", "\\\\?\\GLOBALROOT\\Device\\x", "\\\\localhost\\c$\\x"]) {
      expect([p, isNetworkOrDevicePath(p)]).toEqual([p, true]);
    }
    for (const p of ["C:\\x", "\\\\?\\C:\\x", "\\\\.\\C:\\x", "\\x", "x"]) expect([p, isNetworkOrDevicePath(p)]).toEqual([p, false]);
  });

  test("MSYS and Cygwin spellings", () => {
    expect(msysToWin("/c/Users/Ada")).toBe("C:\\Users\\Ada");
    expect(msysToWin("/cygdrive/d/x/y")).toBe("D:\\x\\y");
    expect(msysToWin("/c")).toBe("C:\\");
    expect(msysToWin("/cc/x")).toBe(null);
    expect(msysToWin("C:\\x")).toBe(null);
  });

  test("canonical: junctions and short names resolved, case from the disk, new files kept", () => {
    expect(canonicalPath("c:\\users\\ADA~1\\.SSH\\new-key", fakeOps)).toBe(`${HOME}\\.ssh\\new-key`);
    expect(canonicalPath(`${ROOT}\\KEYS\\id_rsa`, fakeOps)).toBe(`${HOME}\\.ssh\\id_rsa`);
    expect(canonicalPath(`${ROOT}\\src\\..\\keys`, fakeOps)).toBe(`${HOME}\\.ssh`);
  });

  test("glob prefixes split on both separators", () => {
    expect(globPrefix("C:\\Users\\Ada\\.ssh\\*", fakeOps)).toBe("C:\\Users\\Ada\\.ssh");
    expect(globPrefix("C:/Users/Ada/**/*.ts", fakeOps)).toBe("C:\\Users\\Ada");
    expect(globPrefix("**\\*.ts", fakeOps)).toBe(".");
  });
});

describe("the hard denylist on Windows (§5.5, §13)", () => {
  test("each category", () => {
    expect(read(`${HOME}\\.ssh\\id_rsa`)).toBe("ssh");
    expect(read(`${HOME}\\.ssh`)).toBe("ssh");
    for (const p of [
      `${ROAMING}\\Microsoft\\Credentials\\ABCD`,
      `${ROAMING}\\Microsoft\\Protect\\S-1-5-21-1\\key`,
      `${ROAMING}\\Microsoft\\Vault\\x`,
      `${LOCAL}\\Microsoft\\Credentials\\ABCD`,
      `${LOCAL}\\Microsoft\\Vault\\x`,
    ]) expect([p, read(p)]).toEqual([p, "keychain"]);
    for (const p of [
      `${LOCAL}\\Google\\Chrome\\User Data\\Default\\Cookies`,
      `${LOCAL}\\Google\\Chrome SxS\\User Data\\Default\\Login Data`,
      `${LOCAL}\\Chromium\\User Data\\Default\\Cookies`,
      `${LOCAL}\\Microsoft\\Edge\\User Data\\Default\\Login Data`,
      `${LOCAL}\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Cookies`,
      `${LOCAL}\\Mozilla\\Firefox\\Profiles\\x\\cache2`,
      `${ROAMING}\\Mozilla\\Firefox\\Profiles\\x\\cookies.sqlite`,
      `${ROAMING}\\Opera Software\\Opera Stable\\Cookies`,
      `${LOCAL}\\Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\x`,
    ]) expect([p, read(p)]).toEqual([p, "browser"]);
    for (const f of [".aws\\credentials", ".netrc", "_netrc", ".docker\\config.json", ".npmrc", ".pypirc", ".kube\\config", ".gnupg\\pubring.kbx"]) {
      expect([f, read(`${HOME}\\${f}`)]).toEqual([f, "credentials"]);
    }
    expect(read(`${ROAMING}\\GitHub CLI\\hosts.yml`)).toBe("credentials");
    expect(read(`${ROAMING}\\gnupg\\secring.gpg`)).toBe("credentials");
    for (const f of [".env", ".ENV.Local", ".env.production"]) expect([f, read(`D:\\elsewhere\\${f}`)]).toEqual([f, "env_file"]);
    expect(read(`${DATA}\\homerun.db`)).toBe("homerun_data");
    expect(read(`${DATA}\\logs\\homerund.log`)).toBe("homerun_data");

    // Not on the list: the rest of the profile, another Store app, the browsers' programs.
    for (const p of [
      `${ROOT}\\src\\a.ts`,
      `${HOME}\\.aws\\config`,
      `${LOCAL}\\Packages\\Microsoft.WindowsCalculator_8wekyb3d8bbwe\\x`,
      `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`,
      `${ROOT}\\.envrc`,
      `${ROOT}\\env.ts`,
    ]) expect([p, read(p)]).toEqual([p, null]);
  });

  test("the reason names Windows credentials, not the keychain", () => {
    expect(hit("Read", { file_path: `${ROAMING}\\Microsoft\\Credentials\\ABCD` })!.reason).toBe(
      "Homerun never lets the agent read Windows credentials. This call was not run.",
    );
  });

  test("case, 8.3 names, junctions, streams, trailing dots, prefixes and MSYS spellings", () => {
    for (const p of [
      "C:\\USERS\\ADA\\.SSH\\ID_RSA",
      "c:/users/ada/.ssh/id_rsa",
      "C:\\Users\\ADA~1\\.ssh\\id_rsa",
      "c:\\users\\ADA~1\\.SSH\\new-key",
      `${ROOT}\\keys\\id_rsa`,
      `${ROOT}\\KEYS\\authorized_keys`,
      `${HOME}\\.ssh\\id_rsa::$DATA`,
      `${HOME}\\.ssh\\id_rsa:hidden`,
      `${HOME}\\.ssh.\\id_rsa`,
      `${HOME}\\.ssh \\id_rsa`,
      `\\\\?\\${HOME}\\.ssh\\id_rsa`,
      `\\??\\${HOME}\\.ssh\\id_rsa`,
      `\\\\.\\${HOME}\\.ssh\\id_rsa`,
      "/c/Users/Ada/.ssh/id_rsa",
      "/cygdrive/c/Users/Ada/.ssh/id_rsa",
      "~/.ssh/id_rsa",
      "~\\.ssh\\id_rsa",
      "..\\.ssh\\id_rsa",
      "keys\\id_rsa",
    ]) expect([p, read(p)]).toEqual([p, "ssh"]);
    expect(read(`${ROOT}\\.env.`)).toBe("env_file");
    expect(read(`${ROOT}\\.env::$DATA`)).toBe("env_file");
    expect(write(`${ROOT}\\KEYS\\authorized_keys`)).toBe("ssh");
  });

  test("UNC and device paths are refused before the file system is touched", () => {
    touched.length = 0;
    const net = (tool: string, input: unknown, cwd?: string) => hit(tool, input, { cwd })?.category ?? null;
    expect(net("Read", { file_path: "\\\\attacker\\share\\x" })).toBe("network_path");
    expect(net("Read", { file_path: "//attacker/share/x" })).toBe("network_path");
    expect(net("Read", { file_path: "\\\\?\\UNC\\attacker\\share\\x" })).toBe("network_path");
    expect(net("Write", { file_path: "\\\\.\\pipe\\x", content: "x" })).toBe("network_path");
    expect(net("Read", { file_path: "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x" })).toBe("network_path");
    expect(net("Glob", { pattern: "*", path: "\\\\attacker\\share" })).toBe("network_path");
    expect(net("Glob", { pattern: "\\\\attacker\\share\\*" })).toBe("network_path");
    expect(net("Grep", { pattern: "x", path: "\\\\attacker\\share" })).toBe("network_path");
    expect(net("Read", { file_path: "a.txt" }, "\\\\attacker\\share")).toBe("network_path");
    expect(touched.filter((p) => p.startsWith("\\\\") || p.startsWith("//"))).toEqual([]);
    expect(hit("Read", { file_path: "\\\\attacker\\share\\x" })!.reason).toBe(
      "Homerun never lets the agent read network or device paths. This call was not run.",
    );
  });

  test("Glob and Grep", () => {
    expect(hit("Glob", { pattern: "C:\\Users\\Ada\\.ssh\\*" })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "C:/Users/Ada/.ssh/**/*" })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "/c/Users/Ada/.ssh/*" })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "*", path: `${HOME}\\.SSH` })?.category).toBe("ssh");
    expect(hit("Grep", { pattern: "BEGIN", path: "~\\.ssh" })?.category).toBe("ssh");
    expect(hit("Grep", { pattern: "BEGIN", path: "keys" })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "src\\**\\*.ts" })).toBe(null);
    expect(hit("Grep", { pattern: "x" })).toBe(null);
  });

  test("inside the data dir: workspaces, and this session's own scratch, read only", () => {
    expect(read(`${DATA}\\workspaces\\t1\\notes.md`)).toBe(null);
    expect(write(`${DATA}\\WORKSPACES\\t1\\new.md`)).toBe(null);
    const own = `${DATA}\\claude-config\\projects\\p\\sess-1\\tool-results\\r.txt`;
    expect(read(own, { sessionId: "sess-1" })).toBe(null);
    expect(read(own.toUpperCase(), { sessionId: "sess-1" })).toBe(null);
    expect(write(own, { sessionId: "sess-1" })).toBe("homerun_data");
    expect(read(own)).toBe("homerun_data");
    expect(read(`${DATA}\\claude-config\\projects\\p\\sess-2\\tool-results\\r.txt`, { sessionId: "sess-1" })).toBe("homerun_data");
    expect(read(`${DATA}\\tmp\\u\\p\\sess-1\\tasks\\out.txt`, { sessionId: "sess-1" })).toBe(null);
    expect(read(`${DATA}\\claude-config\\settings.json`, { sessionId: "sess-1" })).toBe("homerun_data");
  });

  test("SDK deny rules in claude's POSIX form for Windows paths", () => {
    const rules = sdkDenyRules(cfg());
    for (const r of [
      "Read(//c/Users/Ada/.ssh/**)",
      "Edit(//c/Users/Ada/.ssh/**)",
      "Read(//c/Users/Ada/AppData/Roaming/Microsoft/Credentials/**)",
      "Read(//c/Users/Ada/AppData/Local/Google/Chrome/User Data/**)",
      "Read(//c/Users/Ada/AppData/Local/Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/**)",
      "Read(//c/Users/Ada/AppData/Local/Homerun/homerun.db)",
      "Read(//**/.env)",
    ]) expect([r, rules.includes(r)]).toEqual([r, true]);
    expect(rules.filter((r) => r.includes("\\") || /[A-Za-z]:/.test(r))).toEqual([]);
    expect(rules.some((r) => r.includes("/workspaces"))).toBe(false);
  });
});

const WINDOWS = process.platform === "win32";

describe.skipIf(!WINDOWS)("the Windows denylist against the real file system", () => {
  // bun runs a skipped describe's body, so only touch the disk on Windows.
  const dir = WINDOWS ? canonicalPath(mkdtempSync(join(tmpdir(), "hr-deny-win-"))) : "C:\\unused";
  const home = win32.join(dir, "home");
  const root = win32.join(home, "proj");
  if (WINDOWS) {
    mkdirSync(win32.join(home, ".ssh"), { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(win32.join(home, ".ssh", "id_rsa"), "k");
    symlinkSync(win32.join(home, ".ssh"), win32.join(root, "keys"), "junction");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
  }
  const real = (): DenylistConfig => ({
    homes: [home],
    dataDir: win32.join(dir, "data"),
    workspacesDir: win32.join(dir, "data", "workspaces"),
    claudeConfigDir: win32.join(dir, "data", "claude-config"),
    tmpDir: win32.join(dir, "data", "tmp"),
    caseInsensitive: true,
  });
  const r = (p: string) => denylistHit(real(), { tool: "Read", input: { file_path: p }, cwd: root, sessionId: null })?.category ?? null;

  test("a junction, case and a stream", () => {
    expect(r(win32.join(root, "keys", "id_rsa"))).toBe("ssh");
    expect(r(win32.join(root, "KEYS", "ID_RSA"))).toBe("ssh");
    expect(r(`${win32.join(home, ".ssh", "id_rsa")}::$DATA`)).toBe("ssh");
    expect(r(win32.join(root, "a.ts"))).toBe(null);
  });

  test("8.3 short names expand, where the volume has them", () => {
    const pf = process.env.ProgramFiles ?? "C:\\Program Files";
    const short = "C:\\PROGRA~1";
    const expanded = canonicalPath(short);
    // Short names can be disabled per volume; when they exist they must expand.
    if (expanded.toLowerCase() !== short.toLowerCase()) expect(expanded.toLowerCase()).toBe(pf.toLowerCase());
  });

  test("a UNC path is refused", () => {
    expect(r("\\\\localhost\\c$\\Windows\\win.ini")).toBe("network_path");
  });
});
