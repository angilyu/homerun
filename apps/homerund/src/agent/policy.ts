import { isAbsolute, relative, resolve } from "node:path";
import {
  ANY_DOMAIN,
  BUILTIN_TOOL_CLASS,
  BashCommandPattern,
  UNTRUSTED_SOURCE_BUILTINS,
  anyDomainCovers,
  bashCommandOf,
  bashPatternMatches,
  effectiveEgressDomains,
  egressAllowed,
  egressHostOf,
  fetchUrlOf,
  grantCovers,
  hasShellMetacharacters,
  isBuiltinTool,
  ToolName,
  type AllDomainsGrant,
  type ApprovalPrompt,
  type Authority,
  type BuiltinTool,
  type GrantProposal,
  type ToolClass,
  type ToolGrant,
} from "@homerun/core";
import type { ShellDialect } from "./claude/shell";
import { denylistHit, type DenylistConfig } from "./denylist";
import { canonicalPath, expandTilde } from "./paths";

export { canonicalPath } from "./paths";

/**
 * Tool policy (§5.5, §5.6). `decide` is a pure function of the call and the run's context
 * (spec, roots, egress, grants, taint, authority); the driver turns `needs_approval` into an
 * input request.
 *
 * Tools listed in the spec are allowlisted for their class:
 * - read: allowed. A read outside the roots is allowed but taints the run.
 * - write: allowed inside the roots, otherwise approval.
 * - network: allowed; once the run is tainted and egress is an allowlist, only to allowlisted
 *   domains (the spec's plus `WebFetch` grants, or any host name under an all-domains `*`
 *   grant), otherwise approval, which may offer a grant for the domain or for every domain.
 * - destructive: approval for each call (§13), unless a `Bash` pattern or grant classifies the
 *   command as something else. An untrusted MCP tool is destructive until trusted.
 * A `web_read_only` run (§9.9) needs approval for anything that is not read-class.
 * Before any of this, the hard denylist (§13, `denylist.ts`) denies file tools outright.
 */

export interface PolicySpec {
  builtin: readonly BuiltinTool[];
  /** MCP server ids in the spec. All are third-party and untrusted until a grant trusts a tool. */
  mcpServers: readonly string[];
  bashPatterns: ReadonlyArray<{ pattern: string; class: ToolClass }>;
}

export interface PolicyContext {
  spec: PolicySpec;
  /** Canonical absolute roots (`resolveRoots`). The run's workspace when the task declares none. */
  roots: readonly string[];
  /** Relative paths in a call resolve against this. */
  cwd: string;
  egress: { mode: "open" } | { mode: "allowlist"; domains: readonly string[] };
  /** Active grants of the run's task; none for a chat. */
  grants: readonly ToolGrant[];
  tainted: boolean;
  authority: Authority;
  /** "Always allow" needs a task to hold the grant (§5.6); a chat has none. */
  grantsAllowed: boolean;
  /** The hard denylist (§13). */
  denylist: DenylistConfig;
  /** The run's `claude` session: its own saved tool results stay readable (`denylist.ts`). */
  sessionId: string | null;
  /**
   * The dialect of the Bash tool's shell (`claude/shell.ts`). Bash patterns, grants and the
   * metacharacter check read bash only, so under any other every call asks as destructive.
   */
  shellDialect: ShellDialect;
}

export type PolicyVerdict = "allowed" | "granted" | "needs_approval" | "denied";

export interface ApprovalAsk {
  reason: ApprovalPrompt["reason"];
  offerAlways: boolean;
  suggestedGrant?: GrantProposal;
  /** "Allow all web fetches for this task", offered beside a `WebFetch` domain grant (§5.6). */
  suggestedGrantAll?: AllDomainsGrant;
  url?: string;
}

export interface Decision {
  toolClass: ToolClass;
  policy: PolicyVerdict;
  /** Allowed now (`allowed` / `granted`). */
  allow: boolean;
  /** Why a `denied` call was refused. */
  reason?: string;
  mcpServer?: string;
  grantId?: string;
  /** Set for `needs_approval`. */
  approval?: ApprovalAsk;
  /** The call brings untrusted content into the context (§5.5 taint). */
  taints: boolean;
}

export function parseMcpName(tool: string): { server: string; tool: string } | null {
  const m = /^mcp__([a-z0-9][a-z0-9_-]{0,62})__(.+)$/.exec(tool);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

export function resolveRoots(roots: readonly string[], home: string, fallback: string): string[] {
  const abs = roots.length ? roots.map((r) => expandTilde(r, home)) : [fallback];
  return abs.map((p) => canonicalPath(p));
}

export function insideRoots(roots: readonly string[], path: string): boolean {
  const p = canonicalPath(path);
  return roots.some((r) => {
    const rel = relative(r, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** The path a file tool touches; the cwd for Glob/Grep without one. Null when none is given. */
function pathOf(tool: string, input: unknown, cwd: string): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw = tool === "Read" || tool === "Write" || tool === "Edit" ? i.file_path : tool === "Glob" || tool === "Grep" ? (i.path ?? cwd) : null;
  if (typeof raw !== "string" || !raw) return null;
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

const NOT_RUN = (tool: string) => `${tool} is not one of this task's tools.`;

export function decide(ctx: PolicyContext, tool: string, input: unknown): Decision {
  const d = decideFull(ctx, tool, input);
  if (ctx.authority !== "web_read_only" || d.policy === "denied" || (d.allow && d.toolClass === "read")) return d;
  // §9.9: after a message from the web, only read-class calls run without the full app.
  const url = tool === "WebFetch" ? fetchUrlOf(input) : null;
  return { ...d, policy: "needs_approval", allow: false, approval: { reason: "web_read_only", offerAlways: false, ...(url ? { url } : {}) } };
}

function decideFull(ctx: PolicyContext, tool: string, input: unknown): Decision {
  const mcp = parseMcpName(tool);
  const base = mcp ? { mcpServer: mcp.server } : {};
  const inSpec = isBuiltinTool(tool) ? ctx.spec.builtin.includes(tool) : mcp !== null && ctx.spec.mcpServers.includes(mcp.server);
  if (!inSpec || !ToolName.safeParse(tool).success) {
    return { ...base, toolClass: isBuiltinTool(tool) ? BUILTIN_TOOL_CLASS[tool] : "destructive", policy: "denied", allow: false, reason: NOT_RUN(tool), taints: false };
  }
  // §13: before grants, approvals and --dev-auto-approve; nothing overrides it.
  const hit = denylistHit(ctx.denylist, { tool, input, cwd: ctx.cwd, sessionId: ctx.sessionId });
  if (hit) return { ...base, toolClass: BUILTIN_TOOL_CLASS[tool as BuiltinTool], policy: "denied", allow: false, reason: hit.reason, taints: false };
  const openEgress = ctx.egress.mode === "open";
  const covering = ctx.grants.find((g) => g.revoked_at === null && grantCovers(g, { tool, input }));

  const ask = (toolClass: ToolClass, a: ApprovalAsk, taints = false): Decision => ({ ...base, toolClass, policy: "needs_approval", allow: false, approval: a, taints });
  const ok = (toolClass: ToolClass, taints: boolean, grantId?: string): Decision => ({
    ...base,
    toolClass,
    policy: grantId ? "granted" : "allowed",
    allow: true,
    taints: taints && !openEgress,
    ...(grantId ? { grantId } : {}),
  });
  /** The tainted-egress rule for network calls. */
  const byClass = (toolClass: ToolClass, taints: boolean, grantId?: string): Decision => {
    if (toolClass === "network" && ctx.tainted && !openEgress) return ask(toolClass, { reason: "tainted_egress", offerAlways: false }, taints);
    return ok(toolClass, taints, grantId);
  };

  if (tool === "Bash") {
    const command = (bashCommandOf(input) ?? "").trim();
    if (ctx.shellDialect !== "bash" || !command || hasShellMetacharacters(command)) return ask("destructive", { reason: "destructive", offerAlways: false });
    const declared = ctx.spec.bashPatterns.find((p) => bashPatternMatches(p.pattern, command));
    if (declared) {
      if (declared.class === "destructive") return ask("destructive", { reason: "destructive", offerAlways: false });
      return byClass(declared.class, false);
    }
    if (covering) return byClass(covering.class, false, covering.grant_id);
    // An exact-command grant; a command containing `*` would widen into a wildcard pattern.
    const grantable = ctx.grantsAllowed && !command.includes("*") && BashCommandPattern.safeParse(command).success;
    return ask("destructive", {
      reason: "not_allowlisted",
      offerAlways: grantable,
      ...(grantable ? { suggestedGrant: { tool: "Bash", pattern: command, class: "write" } } : {}),
    });
  }

  if (mcp) {
    // Third-party MCP output is untrusted content (§5.5).
    if (covering) return byClass(covering.class, true, covering.grant_id);
    const grantable = ctx.grantsAllowed;
    return ask(
      "destructive",
      { reason: "untrusted_tool", offerAlways: grantable, ...(grantable ? { suggestedGrant: { tool, pattern: null, class: "write" } } : {}) },
      true,
    );
  }

  const cls = BUILTIN_TOOL_CLASS[tool as BuiltinTool];
  if (tool === "WebFetch") {
    const url = fetchUrlOf(input) ?? "";
    const host = egressHostOf(url);
    if (!ctx.tainted || openEgress) return ok(cls, true);
    const domains = effectiveEgressDomains(ctx.egress.mode === "allowlist" ? ctx.egress.domains : [], []);
    if (host && egressAllowed(domains, host)) return ok(cls, true);
    if (host && covering) return ok(cls, true, covering.grant_id);
    const grantable = ctx.grantsAllowed && host !== null && !host.startsWith("[");
    // "Allow all web fetches for this task" only where its grant would cover this call.
    const all = grantable && anyDomainCovers(host!);
    return ask(
      cls,
      {
        reason: "tainted_egress",
        offerAlways: grantable,
        url,
        ...(grantable ? { suggestedGrant: { tool: "WebFetch", pattern: host!, class: "network" } } : {}),
        ...(all ? { suggestedGrantAll: { tool: "WebFetch", pattern: ANY_DOMAIN, class: "network" } } : {}),
      },
      true,
    );
  }
  if (tool === "WebSearch") return byClass(cls, UNTRUSTED_SOURCE_BUILTINS.includes(tool));

  const path = pathOf(tool, input, ctx.cwd);
  const inside = path === null ? true : insideRoots(ctx.roots, path);
  if (cls === "read") return byClass(cls, !inside);
  if (cls === "write" && !inside) return ask(cls, { reason: "not_allowlisted", offerAlways: false });
  return byClass(cls, false);
}
