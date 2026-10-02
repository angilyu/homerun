import { describe, expect, test } from "bun:test";
import { BashCommandPattern } from "../src/tools";
import { GrantProposal, effectiveEgressDomains, type ToolGrant } from "../src/grants";
import { ANY_DOMAIN, bashPatternMatches, egressAllowed, egressDomainMatches, egressHostOf, grantCovers } from "../src/patterns";

describe("Bash command patterns (§5.5)", () => {
  test("whole-command match with * wildcards", () => {
    expect(bashPatternMatches("git status", "git status")).toBe(true);
    expect(bashPatternMatches("git status", " git status ")).toBe(true);
    expect(bashPatternMatches("git status", "git status --short")).toBe(false);
    expect(bashPatternMatches("ls *", "ls -la src")).toBe(true);
    expect(bashPatternMatches("npm test", "npm test2")).toBe(false);
    expect(bashPatternMatches("echo a.b", "echo aXb")).toBe(false);
  });

  test("shell metacharacters never match", () => {
    for (const cmd of ["ls; rm -rf /", "ls && rm x", "ls | sh", "ls $(rm x)", "ls `rm x`", "ls > f", "ls < f", "ls &", "ls\nrm x"]) {
      expect(bashPatternMatches("ls *", cmd)).toBe(false);
    }
  });
});

describe("egress domains (§5.5)", () => {
  test("hosts are normalized", () => {
    expect(egressHostOf("https://API.GitHub.com/x?q=1")).toBe("api.github.com");
    expect(egressHostOf("https://example.com./")).toBe("example.com");
    expect(egressHostOf("https://bücher.de/")).toBe("xn--bcher-kva.de");
    expect(egressHostOf("https://user:pw@example.com:8443/")).toBe("example.com");
    expect(egressHostOf("http://[::1]:80/")).toBe("[::1]");
    expect(egressHostOf("ftp://example.com/")).toBeNull();
    expect(egressHostOf("file:///etc/passwd")).toBeNull();
    expect(egressHostOf("not a url")).toBeNull();
  });

  test("exact and wildcard entries", () => {
    expect(egressDomainMatches("example.com", "example.com")).toBe(true);
    expect(egressDomainMatches("example.com", "api.example.com")).toBe(false);
    expect(egressDomainMatches("*.example.com", "api.example.com")).toBe(true);
    expect(egressDomainMatches("*.example.com", "a.b.example.com")).toBe(true);
    expect(egressDomainMatches("*.example.com", "example.com")).toBe(false);
    expect(egressDomainMatches("*.example.com", "evilexample.com")).toBe(false);
    expect(egressDomainMatches("*.example.com", "example.com.evil.net")).toBe(false);
  });

  test("IP literals match only themselves", () => {
    expect(egressDomainMatches("*.0.0.1", "127.0.0.1")).toBe(false);
    expect(egressDomainMatches("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(egressAllowed(["example.com", "*.github.com"], "api.github.com")).toBe(true);
    expect(egressAllowed([], "example.com")).toBe(false);
  });
});

describe("grantCovers (§5.6)", () => {
  test("Bash grants cover matching commands without metacharacters", () => {
    const g = { tool: "Bash", pattern: "npm test *" };
    expect(grantCovers(g, { tool: "Bash", input: { command: "npm test --watch=false" } })).toBe(true);
    expect(grantCovers(g, { tool: "Bash", input: { command: "npm test x; rm -rf ~" } })).toBe(false);
    expect(grantCovers({ tool: "Bash", pattern: null }, { tool: "Bash", input: { command: "ls" } })).toBe(false);
    expect(grantCovers(g, { tool: "Write", input: { command: "npm test x" } })).toBe(false);
  });

  test("WebFetch grants cover hosts", () => {
    const g = { tool: "WebFetch", pattern: "api.github.com" };
    expect(grantCovers(g, { tool: "WebFetch", input: { url: "https://api.github.com/x" } })).toBe(true);
    expect(grantCovers(g, { tool: "WebFetch", input: { url: "https://github.com/x" } })).toBe(false);
    expect(grantCovers({ tool: "WebFetch", pattern: null }, { tool: "WebFetch", input: { url: "https://github.com/x" } })).toBe(false);
  });

  test("an all-domains WebFetch grant (*) covers any http(s) host name", () => {
    const g = { tool: "WebFetch", pattern: ANY_DOMAIN };
    const fetch = (url: string) => grantCovers(g, { tool: "WebFetch", input: { url } });
    expect(fetch("https://api.github.com/x?q=1")).toBe(true);
    expect(fetch("http://example.com/")).toBe(true);
    expect(fetch("https://bücher.de/")).toBe(true);
    expect(fetch("HTTPS://Evil.Example.NET./a")).toBe(true);
    expect(grantCovers(g, { tool: "WebSearch", input: { query: "x" } })).toBe(false);
    expect(grantCovers(g, { tool: "Bash", input: { command: "curl https://example.com" } })).toBe(false);
  });

  test("an all-domains grant never covers what a per-domain wildcard can't", () => {
    const any = { tool: "WebFetch", pattern: ANY_DOMAIN };
    const wildcard = { tool: "WebFetch", pattern: "*.example.com" };
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "not a url", "", "http://127.0.0.1/", "http://10.0.0.1:8080/x", "http://[::1]/", "https://[fe80::1]/"]) {
      expect(grantCovers(any, { tool: "WebFetch", input: { url } })).toBe(false);
      expect(grantCovers(wildcard, { tool: "WebFetch", input: { url } })).toBe(false);
    }
    expect(grantCovers(any, { tool: "WebFetch", input: {} })).toBe(false);
    // Loopback by name reaches this machine, not a website.
    for (const url of ["http://localhost:3000/", "http://LOCALHOST./", "http://app.localhost/"]) expect(grantCovers(any, { tool: "WebFetch", input: { url } })).toBe(false);
  });

  test("* is a grant pattern for WebFetch only, never an egress domain or a Bash pattern", () => {
    expect(GrantProposal.safeParse({ tool: "WebFetch", pattern: "*", class: "network" }).success).toBe(true);
    expect(GrantProposal.safeParse({ tool: "WebFetch", pattern: "*.*", class: "network" }).success).toBe(false);
    expect(GrantProposal.safeParse({ tool: "WebFetch", pattern: "*", class: "read" }).success).toBe(false);
    expect(GrantProposal.safeParse({ tool: "Bash", pattern: "*", class: "write" }).success).toBe(false);
    expect(BashCommandPattern.safeParse("*").success).toBe(false);
    expect(grantCovers({ tool: "Bash", pattern: "*" }, { tool: "Bash", input: { command: "rm -rf ~" } })).toBe(true); // why the schema refuses it
    expect(egressDomainMatches("*", "example.com")).toBe(false);
    const g = (pattern: string, revoked_at: number | null = null) => ({ tool: "WebFetch", pattern, revoked_at }) as ToolGrant;
    expect(effectiveEgressDomains(["docs.example.com"], [g("*"), g("api.github.com"), g("old.example.com", 1)])).toEqual(["docs.example.com", "api.github.com"]);
  });

  test("MCP trust covers every call; other built-ins are not grantable yet", () => {
    expect(grantCovers({ tool: "mcp__gh__create_issue", pattern: null }, { tool: "mcp__gh__create_issue", input: {} })).toBe(true);
    expect(grantCovers({ tool: "mcp__gh__create_issue", pattern: "x" }, { tool: "mcp__gh__create_issue", input: {} })).toBe(false);
    expect(grantCovers({ tool: "Write", pattern: null }, { tool: "Write", input: { file_path: "/x" } })).toBe(false);
  });
});
