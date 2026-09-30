import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolGrant } from "@homerun/core";
import { denylistHit, sdkDenyRules, type DenylistConfig } from "../../src/agent/denylist";
import { canonicalPath } from "../../src/agent/paths";
import { decide, type PolicyContext } from "../../src/agent/policy";

// §5.5, §13: the hard denylist, macOS and Linux entries against the real file system. The Windows
// entries and path rules are in denylist-windows.test.ts.
const POSIX = process.platform !== "win32";
const dir = canonicalPath(mkdtempSync(join(tmpdir(), "hr-deny-")));
const home = join(dir, "home");
const data = join(dir, "data");
const root = join(home, "proj");
if (POSIX) {
  for (const d of [".ssh", "Library/Keychains", "proj/src", ".aws", "Library/Application Support/Google/Chrome/Default"]) mkdirSync(join(home, d), { recursive: true });
  for (const d of ["workspaces/t1", "claude-config/projects/p/sess-1/tool-results", "claude-config/projects/p/sess-2", "tmp/u/p/sess-1/tasks", "logs"]) mkdirSync(join(data, d), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), "k");
  writeFileSync(join(data, "homerun.db"), "");
  symlinkSync(join(home, ".ssh"), join(root, "keys"));
  symlinkSync(join(home, ".ssh", "id_rsa"), join(root, "src", "notes.txt"));
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cfg = (over: Partial<DenylistConfig> = {}): DenylistConfig => ({
  homes: [home],
  dataDir: data,
  workspacesDir: join(data, "workspaces"),
  claudeConfigDir: join(data, "claude-config"),
  tmpDir: join(data, "tmp"),
  caseInsensitive: false,
  ...over,
});

const hit = (tool: string, input: unknown, o: { sessionId?: string | null; c?: DenylistConfig } = {}) =>
  denylistHit(o.c ?? cfg(), { tool, input, cwd: root, sessionId: o.sessionId ?? null });
const read = (p: string, o: { sessionId?: string | null; c?: DenylistConfig } = {}) => hit("Read", { file_path: p }, o)?.category ?? null;
const write = (p: string, o: { sessionId?: string | null } = {}) => hit("Write", { file_path: p, content: "x" }, o)?.category ?? null;

describe.skipIf(!POSIX)("the hard denylist (§5.5, §13)", () => {
  test("each category", () => {
    expect(read(join(home, ".ssh", "id_rsa"))).toBe("ssh");
    expect(read(join(home, ".ssh"))).toBe("ssh");
    expect(read(join(home, "Library/Keychains/login.keychain-db"))).toBe("keychain");
    expect(read("/Library/Keychains/System.keychain")).toBe("keychain");
    for (const b of [
      "Library/Safari/History.db",
      "Library/Containers/com.apple.Safari/Data/x",
      "Library/Application Support/Google/Chrome/Default/Cookies",
      "Library/Application Support/Microsoft Edge/Default/Login Data",
      "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies",
      "Library/Application Support/Arc/User Data/Default/Cookies",
      "Library/Application Support/Firefox/Profiles/x/cookies.sqlite",
    ]) expect(read(join(home, b))).toBe("browser");
    for (const f of [".aws/credentials", ".netrc", ".config/gh/hosts.yml", ".docker/config.json", ".npmrc", ".pypirc", ".kube/config", ".gnupg/private-keys-v1.d/x.key"]) {
      expect(read(join(home, f))).toBe("credentials");
    }
    // Only the named files: the rest of ~/.aws or ~/.docker is not on the list.
    expect(read(join(home, ".aws/config"))).toBe(null);
    for (const f of [".env", ".env.local", ".env.production"]) expect(read(join("/somewhere/else", f))).toBe("env_file");
    expect(read(join(root, ".envrc"))).toBe(null);
    expect(read(join(root, "env.ts"))).toBe(null);
    expect(read(join(data, "homerun.db"))).toBe("homerun_data");
    expect(read(join(data, "logs", "homerund.log"))).toBe("homerun_data");
    expect(read(join(data, "claude-config", "settings.json"))).toBe("homerun_data");
    expect(read(join(home, "Library/Application Support/Homerun/homerun.db"))).toBe("homerun_data");
    expect(read(join(root, "src", "a.ts"))).toBe(null);
  });

  test("the reason says what was refused, and that nothing ran", () => {
    expect(hit("Read", { file_path: join(home, ".ssh", "id_rsa") })).toEqual({
      category: "ssh",
      path: join(home, ".ssh", "id_rsa"),
      reason: "Homerun never lets the agent read SSH keys. This call was not run.",
    });
    expect(hit("Edit", { file_path: join(root, ".env"), old_string: "a", new_string: "b" })!.reason).toBe(
      "Homerun never lets the agent change .env files. This call was not run.",
    );
  });

  test("a symlink from inside a root into ~/.ssh", () => {
    expect(read(join(root, "keys", "id_rsa"))).toBe("ssh");
    expect(read(join(root, "src", "notes.txt"))).toBe("ssh");
    expect(write(join(root, "keys", "authorized_keys"))).toBe("ssh");
  });

  test("`..` traversal and `~`", () => {
    expect(read(join(root, "..", ".ssh", "id_rsa"))).toBe("ssh");
    expect(read("../.ssh/id_rsa")).toBe("ssh");
    expect(read("~/.ssh/id_rsa")).toBe("ssh");
    expect(hit("Read", { file_path: `${root}/src/../../.aws/credentials` })?.category).toBe("credentials");
  });

  test("case variants, where the file system ignores case (macOS)", () => {
    const ci = cfg({ caseInsensitive: true });
    expect(read(join(home, ".SSH", "id_rsa"), { c: ci })).toBe("ssh");
    expect(read(join(home, "library/keychains/login.keychain-db"), { c: ci })).toBe("keychain");
    expect(read(join(root, ".ENV"), { c: ci })).toBe("env_file");
    expect(read(join(data.toUpperCase(), "homerun.db"), { c: ci })).toBe("homerun_data");
  });

  test("a .env inside a declared root", () => {
    expect(read(join(root, ".env"))).toBe("env_file");
    expect(write(join(root, "src", ".env.local"))).toBe("env_file");
    expect(hit("NotebookEdit", { notebook_path: join(root, ".env.ipynb"), new_source: "" })?.category).toBe("env_file");
  });

  test("a new file under a denied directory", () => {
    expect(write(join(home, ".ssh", "new", "deep", "key"))).toBe("ssh");
    expect(write(join(home, ".gnupg", "gpg.conf"))).toBe("credentials");
    expect(write(join(data, "new-dir", "x"))).toBe("homerun_data");
  });

  test("Glob and Grep: the search path is checked, results are not filtered", () => {
    expect(hit("Grep", { pattern: "BEGIN", path: join(home, ".ssh") })?.category).toBe("ssh");
    expect(hit("Grep", { pattern: "BEGIN", path: "~/.ssh" })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "*", path: join(home, "Library/Keychains") })?.category).toBe("keychain");
    expect(hit("Glob", { pattern: join(home, ".ssh", "*") })?.category).toBe("ssh");
    expect(hit("Glob", { pattern: "keys/*" })?.category).toBe("ssh");
    expect(hit("Grep", { pattern: "x" })).toBe(null);
    expect(hit("Glob", { pattern: "**/*.ts" })).toBe(null);
    // Rooted above a denied directory: not refused here (the SDK rules apply best-effort).
    expect(hit("Grep", { pattern: "x", path: home })).toBe(null);
  });

  test("other tools are not the denylist's: Bash is gated as destructive instead", () => {
    expect(hit("Bash", { command: `cat ${home}/.ssh/id_rsa` })).toBe(null);
    expect(hit("WebFetch", { url: "file:///etc/passwd" })).toBe(null);
  });

  test("inside the data dir: workspaces, and this session's own scratch, read only", () => {
    expect(write(join(data, "workspaces", "t1", "a.ts"))).toBe(null);
    const results = join(data, "claude-config/projects/p/sess-1/tool-results/r.txt");
    const task = join(data, "tmp/u/p/sess-1/tasks/b1.output");
    expect(read(results, { sessionId: "sess-1" })).toBe(null);
    expect(read(task, { sessionId: "sess-1" })).toBe(null);
    expect(write(results, { sessionId: "sess-1" })).toBe("homerun_data");
    expect(read(results)).toBe("homerun_data");
    expect(read(results, { sessionId: "sess-2" })).toBe("homerun_data");
    expect(read(join(data, "claude-config/projects/p/sess-1.jsonl"), { sessionId: "sess-1" })).toBe("homerun_data");
    expect(read(join(data, "claude-config/projects/p/sess-2/tool-results/r.txt"), { sessionId: "sess-1" })).toBe("homerun_data");
  });

  test("SDK deny rules: the second layer", () => {
    const rules = sdkDenyRules(cfg());
    for (const tool of ["Read", "Edit"]) {
      expect(rules).toContain(`${tool}(/${home}/.ssh/**)`);
      expect(rules).toContain(`${tool}(/${home}/.aws/credentials)`);
      expect(rules).toContain(`${tool}(//**/.env)`);
      expect(rules).toContain(`${tool}(//**/.env.*)`);
      expect(rules).toContain(`${tool}(/${data}/homerun.db)`);
      expect(rules).toContain(`${tool}(/${data}/logs/**)`);
      expect(rules).toContain(`${tool}(//Library/Keychains/**)`);
    }
    expect(rules.every((r) => /^(Read|Edit)\(\/\//.test(r))).toBe(true);
    expect(rules.some((r) => r.includes("/workspaces"))).toBe(false);
    expect(rules).toContain(`Edit(/${data}/claude-config/**)`);
    expect(rules).toContain(`Read(/${data}/claude-config/projects/**/*.jsonl)`);
    expect(rules).not.toContain(`Read(/${data}/claude-config/**)`);
    // Glob metacharacters in a path are literal.
    expect(sdkDenyRules(cfg({ homes: ["/Users/a[1]"] }))).toContain("Read(//Users/a\\[1\\]/.ssh/**)");
  });
});

const grant = (g: Pick<ToolGrant, "tool" | "pattern" | "class">): ToolGrant => ({ grant_id: "g", task_id: "t1", granted_by: "d1", granted_at: 1, revoked_at: null, ...g }) as ToolGrant;

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    spec: { builtin: ["Read", "Glob", "Grep", "Write", "Edit"], mcpServers: [], bashPatterns: [] },
    roots: [root, home],
    cwd: root,
    egress: { mode: "allowlist", domains: [] },
    grants: [],
    tainted: false,
    authority: "full",
    grantsAllowed: true,
    denylist: cfg(),
    sessionId: null,
    shellDialect: "bash",
    ...over,
  };
}

describe.skipIf(!POSIX)("the policy denies a denylisted call outright (§5.5, §13)", () => {
  test("even inside a declared root, and whatever grants the task has", () => {
    const denied = { policy: "denied", allow: false, reason: "Homerun never lets the agent read SSH keys. This call was not run." };
    expect(decide(ctx(), "Read", { file_path: join(home, ".ssh", "id_rsa") })).toMatchObject(denied);
    const grants = [grant({ tool: "Write", pattern: null, class: "write" }), grant({ tool: "Edit", pattern: null, class: "write" })];
    expect(decide(ctx({ grants }), "Write", { file_path: join(root, ".env"), content: "" })).toMatchObject({ policy: "denied", allow: false });
    expect(decide(ctx({ grants, roots: [dir] }), "Edit", { file_path: join(root, "keys", "config") })).toMatchObject({ policy: "denied", allow: false });
    // Not an approval: nothing to ask.
    expect(decide(ctx(), "Write", { file_path: join(home, ".ssh", "x") }).approval).toBeUndefined();
    expect(decide(ctx({ authority: "web_read_only" }), "Read", { file_path: join(root, ".env") })).toMatchObject({ policy: "denied", allow: false });
    expect(decide(ctx(), "Read", { file_path: join(root, "src", "a.ts") })).toMatchObject({ policy: "allowed", allow: true });
  });
});
