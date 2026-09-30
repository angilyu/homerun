import { describe, expect, test } from "bun:test";
import {
  ALLOWLISTS,
  CALLER_ROLES,
  DEV_ONLY_ROLES,
  HelloParams,
  SURFACE_OF_ROLE,
  roleAllowedInBuild,
  KNOWN_ERROR_CODES,
  METHODS,
  METHOD_NAMES,
  NOTIFICATIONS,
  NOTIFICATION_NAMES,
  PREAUTH_METHODS,
  PROTOCOL_VERSION,
  RUNTIME_TO_SHELL_METHODS,
  SHELL_ONLY_METHODS,
  SUPPORTED_PROTOCOL,
  authorize,
  classifyFrame,
  isSealedExpired,
  CLOCK_SKEW_MS,
  SEALED_EXPIRY_DEFAULT_MS,
  mayReceive,
  maySend,
  negotiateCapabilities,
  negotiateProtocol,
  policyNeedsFullApp,
  TaskSpec,
  CLI_ACCESS_MAX_PENDING,
  CLI_ACCESS_REQUEST_TTL_MS,
  CliAuthFailureData,
  type MethodName,
} from "../src/index";
import * as F from "../scripts/vectors/fixtures";

describe("handshake", () => {
  test("negotiates the highest common version", () => {
    expect(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 5 })).toBe(3);
    expect(negotiateProtocol({ min: 1, max: 1 }, { min: 1, max: 1 })).toBe(1);
    expect(negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 2 })).toBeNull();
    expect(negotiateProtocol(SUPPORTED_PROTOCOL, { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION })).toBe(PROTOCOL_VERSION);
  });
  test("capabilities are the sorted intersection", () => {
    expect(negotiateCapabilities(["b", "a", "c", "a"], ["c", "a", "z"])).toEqual(["a", "c"]);
    expect(negotiateCapabilities([], ["a"])).toEqual([]);
  });
});

describe("development-mode CLI (§16 M3, M6)", () => {
  test("cli_dev is refused by release builds and has the release CLI's methods", () => {
    expect(DEV_ONLY_ROLES).toEqual(["cli_dev"]);
    expect(roleAllowedInBuild("cli_dev", "release")).toBe(false);
    expect(roleAllowedInBuild("cli_dev", "development")).toBe(true);
    for (const r of CALLER_ROLES) if (r !== "cli_dev") expect(roleAllowedInBuild(r, "release")).toBe(true);
    // Plus grants.create: grants need full authority, which the release CLI never has (§5.2, §5.6).
    // Minus the token flow: a dev token is not issued by the runtime, so there is nothing to request or sign out of.
    const tokenFlow = ["cli.request_access", "cli.sign_out"] as string[];
    expect(ALLOWLISTS.cli_dev.filter((m) => m !== "grants.create") as string[]).toEqual(ALLOWLISTS.cli.filter((m) => !tokenFlow.includes(m)));
    expect(ALLOWLISTS.cli_dev).toContain("grants.create");
    expect(ALLOWLISTS.cli as readonly string[]).not.toContain("grants.create");
    expect(SURFACE_OF_ROLE.cli_dev).toBe("cli");
  });

  test("only a dev token authenticates cli_dev, and it authenticates nothing else", () => {
    const base = { protocol: { min: 1, max: 1 }, client: { name: "homerun-cli", version: "0" }, capabilities: [] };
    const token = "A".repeat(43);
    const ok = (role: string, kind: string) => HelloParams.safeParse({ ...base, role, auth: { kind, token } }).success;
    expect(ok("cli_dev", "dev_token")).toBe(true);
    expect(ok("cli_dev", "cli_token")).toBe(false);
    expect(ok("cli", "dev_token")).toBe(false);
    expect(ok("shell", "dev_token")).toBe(false);
  });
});

describe("what only the full app may add to a spec (§5.2)", () => {
  const spec = (over: { tools?: Record<string, unknown>; policy?: Record<string, unknown> } = {}) =>
    TaskSpec.parse(F.sessionSpec({ tools: F.tools({ builtin: ["Read", "Bash"], ...over.tools }), policy: F.policy({ roots: [], ...over.policy }) }));
  const pattern = (cls: string, p = "git status") => ({ pattern: p, class: cls });
  const server = { id: "github", transport: "http", url: "https://mcp.example.com/" };

  test("a plain spec needs nothing", () => {
    expect(policyNeedsFullApp(spec())).toEqual([]);
  });
  test("pre-approving Bash commands, MCP servers and open egress need the app", () => {
    for (const cls of ["read", "write", "network"]) expect(policyNeedsFullApp(spec({ policy: { bash_patterns: [pattern(cls)] } }))).toHaveLength(1);
    expect(policyNeedsFullApp(spec({ policy: { bash_patterns: [pattern("destructive")] } }))).toEqual([]);
    expect(policyNeedsFullApp(spec({ tools: { mcp_servers: [server] } }))).toEqual(['the MCP server "github" is added or changed']);
    expect(policyNeedsFullApp(spec({ policy: { egress: { mode: "open" } } }))).toEqual(["egress is open"]);
  });
  test("an edit may keep or remove them, but not add or change one", () => {
    const wide = spec({ tools: { mcp_servers: [server] }, policy: { bash_patterns: [pattern("read")], egress: { mode: "open" } } });
    expect(policyNeedsFullApp(wide, wide)).toEqual([]);
    expect(policyNeedsFullApp(spec(), wide)).toEqual([]);
    expect(policyNeedsFullApp(spec({ policy: { bash_patterns: [pattern("read"), pattern("read", "ls")] } }), wide)).toHaveLength(1);
    expect(policyNeedsFullApp(spec({ policy: { bash_patterns: [pattern("write")] } }), wide)).toHaveLength(1);
    expect(policyNeedsFullApp(spec({ tools: { mcp_servers: [{ ...server, url: "https://evil.example.com/" }] } }), wide)).toHaveLength(1);
    expect(policyNeedsFullApp(spec({ policy: { egress: { mode: "open" } } }), spec())).toEqual(["egress is open"]);
  });
});

describe("allowlists", () => {
  const only = (m: MethodName) => CALLER_ROLES.filter((r) => ALLOWLISTS[r].includes(m));

  test("every runtime method is callable by someone", () => {
    for (const m of METHOD_NAMES) {
      if (METHODS[m].direction === "to_runtime") expect(only(m).length).toBeGreaterThan(0);
      else expect(METHODS[m].callers).toEqual([]);
    }
  });

  test("shell-only methods appear only in the shell's list (§5.2)", () => {
    expect([...SHELL_ONLY_METHODS].sort()).toEqual(["cli.approve", "cli.deny", "devices.link.decide", "secrets.clear", "secrets.set", "secrets.verify"]);
    for (const m of SHELL_ONLY_METHODS) expect(only(m)).toEqual(["shell"]);
    for (const m of METHOD_NAMES.filter((m) => m.startsWith("secrets."))) {
      expect(ALLOWLISTS.webview).not.toContain(m);
      expect(ALLOWLISTS.cli).not.toContain(m);
    }
    expect(RUNTIME_TO_SHELL_METHODS).toEqual(["secrets.persist", "secrets.delete"]);
  });

  test("the shell can do everything the webview can, and the webview everything iOS can but pairing", () => {
    for (const m of ALLOWLISTS.webview) expect(ALLOWLISTS.shell).toContain(m);
    for (const m of ALLOWLISTS.ios) expect([...ALLOWLISTS.webview, "hello"]).toContain(m);
  });

  test("web cannot raise the agent's reach (§9.9)", () => {
    for (const m of ["tasks.create", "tasks.update", "tasks.archive", "schedules.set_enabled", "grants.create", "monitors.state.set", "monitors.state.reset", "health.settings.set"] as const) {
      expect(ALLOWLISTS.web).not.toContain(m);
      expect(ALLOWLISTS.ios).toContain(m);
    }
    for (const m of ["messages.send", "input.answer", "runs.stop", "grants.revoke"] as const) expect(ALLOWLISTS.web).toContain(m);
  });

  test("accounts and paired devices are managed only from the local app (§9.6, §10)", () => {
    const local = ["account.status", "account.sign_in", "account.cancel_sign_in", "account.sign_out", "account.delete", "devices.list", "devices.unpair", "devices.pairing.start", "devices.pairing.cancel"] as const;
    for (const m of local) expect(only(m)).toEqual(["shell", "webview"]);
    // A new device gets the app's authority, so only the native prompt links one (§10.5).
    expect(only("devices.link.decide")).toEqual(["shell"]);
    for (const n of ["devices.link_requested", "devices.link_withdrawn", "browser.open"] as const) {
      expect(CALLER_ROLES.filter((r) => mayReceive(r, n))).toEqual(["shell"]);
    }
    for (const n of ["account.changed", "devices.changed", "devices.pairing_completed"] as const) {
      expect(CALLER_ROLES.filter((r) => mayReceive(r, n))).toEqual(["shell", "webview"]);
    }
  });

  test("CLI tokens are managed only from the local app", () => {
    for (const m of ["cli.tokens.list", "cli.tokens.revoke"] as const) expect(only(m)).toEqual(["shell", "webview"]);
  });

  test("CLI access (§5.2): only the release CLI requests access or signs out; only the shell answers", () => {
    expect(only("cli.request_access")).toEqual(["cli"]);
    expect(only("cli.sign_out")).toEqual(["cli"]);
    for (const m of ["cli.approve", "cli.deny"] as const) expect(only(m)).toEqual(["shell"]);
    expect(CALLER_ROLES.filter((r) => mayReceive(r, "cli.access_withdrawn"))).toEqual(["shell"]);
    expect(CALLER_ROLES.filter((r) => mayReceive(r, "cli.access_requested"))).toEqual(["shell"]);
    expect(CALLER_ROLES.filter((r) => mayReceive(r, "cli.access_decision"))).toEqual(["cli"]);
    expect(CLI_ACCESS_REQUEST_TTL_MS).toBe(120_000);
    expect(CLI_ACCESS_MAX_PENDING).toBe(3);
    expect(CliAuthFailureData.safeParse({ reason: "revoked" }).success).toBe(true);
    expect(CliAuthFailureData.safeParse({ reason: "expired" }).success).toBe(false);
  });

  test("authorize", () => {
    expect(authorize(null, "hello")).toEqual({ ok: true });
    expect(authorize(null, "cli.request_access")).toEqual({ ok: true });
    expect(authorize(null, "ping")).toEqual({ ok: false, reason: "handshake_required" });
    expect(authorize("shell", "hello")).toEqual({ ok: false, reason: "forbidden" });
    expect(authorize("webview", "secrets.set")).toEqual({ ok: false, reason: "forbidden" });
    expect(authorize("shell", "secrets.set")).toEqual({ ok: true });
    expect(authorize("shell", "secrets.persist")).toEqual({ ok: false, reason: "forbidden" });
    expect(authorize("web", "tasks.update")).toEqual({ ok: false, reason: "forbidden" });
    expect(authorize("ios", "tasks.update")).toEqual({ ok: true });
    expect(authorize("cli", "run.start")).toEqual({ ok: false, reason: "unknown_method" });
    expect(authorize("cli", "__proto__")).toEqual({ ok: false, reason: "unknown_method" });
    expect([...PREAUTH_METHODS].sort()).toEqual(["cli.request_access", "hello"]);
  });

  test("notifications", () => {
    expect(mayReceive("shell", "cli.access_requested")).toBe(true);
    expect(mayReceive("webview", "cli.access_requested")).toBe(false);
    expect(mayReceive("web", "thread.event")).toBe(true);
    // Local notifications go to the shell only, never a client that could answer from them (§9.7).
    for (const n of ["notification.requested", "notification.withdrawn"] as const)
      expect(CALLER_ROLES.filter((r) => mayReceive(r, n))).toEqual(["shell"]);
    expect(maySend("shell", "power.did_wake")).toBe(true);
    expect(maySend("webview", "power.did_wake")).toBe(false);
    expect(maySend("shell", "thread.event")).toBe(false);
    for (const n of NOTIFICATION_NAMES) if (NOTIFICATIONS[n].direction === "shell_to_runtime") expect(NOTIFICATIONS[n].recipients).toEqual([]);
  });
});

describe("frames", () => {
  test("classifies by shape", () => {
    expect(classifyFrame({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }).kind).toBe("request");
    expect(classifyFrame({ jsonrpc: "2.0", method: "power.did_wake", params: { at: 1, slept_at: null } }).kind).toBe("notification");
    expect(classifyFrame({ jsonrpc: "2.0", id: 1, result: null }).kind).toBe("success");
    expect(classifyFrame({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } }).kind).toBe("failure");
    expect(classifyFrame({ id: 1, method: "ping" }).kind).toBe("invalid");
    expect(classifyFrame("ping").kind).toBe("invalid");
  });
  test("error codes are unique and in the JSON-RPC ranges", () => {
    expect(new Set(KNOWN_ERROR_CODES).size).toBe(KNOWN_ERROR_CODES.length);
    for (const c of KNOWN_ERROR_CODES) expect((c >= -32099 && c <= -32000) || (c >= -32768 && c <= -32600)).toBe(true);
  });
});

describe("relay", () => {
  test("sealed expiry allows five minutes of skew (§9.4)", () => {
    const m = { expires_at: F.T0 };
    expect(isSealedExpired(m, F.T0)).toBe(false);
    expect(isSealedExpired(m, F.T0 + CLOCK_SKEW_MS)).toBe(false);
    expect(isSealedExpired(m, F.T0 + CLOCK_SKEW_MS + 1)).toBe(true);
  });
  test("expiry defaults", () => {
    expect(SEALED_EXPIRY_DEFAULT_MS).toEqual({ instruction: 12 * 3_600_000, push: 24 * 3_600_000, answer: 3_600_000 });
  });
});
