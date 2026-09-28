import {
  BUILTIN_TOOL_CLASS,
  hasShellMetacharacters,
  isBuiltinTool,
  ToolName,
  type BuiltinTool,
  type ToolClass,
} from "@homerun/core";

/**
 * Tool policy (§5.5, §5.6). `classify` and `decide` are the permanent interface; grants and
 * approvals arrive in M6. Until then a call that needs approval is allowed only by a
 * development build started with `--dev-auto-approve`, and denied otherwise (plan Q2). The
 * recorded `policy` stays `needs_approval` either way, so the audit trail is honest.
 */

export interface PolicySpec {
  builtin: readonly BuiltinTool[];
  /** MCP server ids in the spec. All are third-party and untrusted in M2. */
  mcpServers: readonly string[];
  bashPatterns: ReadonlyArray<{ pattern: string; class: ToolClass }>;
}

export type PolicyVerdict = "allowed" | "granted" | "needs_approval" | "denied";

export interface Decision {
  toolClass: ToolClass;
  policy: PolicyVerdict;
  /** What happens now: dispatch the call, or deny it with `reason`. */
  allow: boolean;
  reason?: string;
  mcpServer?: string;
}

export const APPROVALS_UNAVAILABLE = "This action needs your approval, and approvals arrive in a later version of Homerun. It was not run.";

export function parseMcpName(tool: string): { server: string; tool: string } | null {
  const m = /^mcp__([a-z0-9][a-z0-9_-]{0,62})__(.+)$/.exec(tool);
  return m ? { server: m[1]!, tool: m[2]! } : null;
}

/** `*` matches any run of characters; everything else is literal. Whole-command match. */
export function bashPatternMatches(pattern: string, command: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
  return re.test(command.trim());
}

export function classify(spec: PolicySpec, tool: string, input: unknown): ToolClass {
  if (isBuiltinTool(tool)) {
    if (tool === "Bash") {
      const command = typeof (input as { command?: unknown })?.command === "string" ? (input as { command: string }).command : "";
      if (command && !hasShellMetacharacters(command)) {
        const hit = spec.bashPatterns.find((p) => bashPatternMatches(p.pattern, command));
        if (hit) return hit.class;
      }
      return "destructive";
    }
    return BUILTIN_TOOL_CLASS[tool];
  }
  // Untrusted third-party MCP tools are destructive until a grant says otherwise (plan Q18).
  return "destructive";
}

export function decide(spec: PolicySpec, tool: string, input: unknown, opts: { devAutoApprove: boolean }): Decision {
  const mcp = parseMcpName(tool);
  const toolClass = classify(spec, tool, input);
  const base = { toolClass, ...(mcp ? { mcpServer: mcp.server } : {}) };
  const inSpec = isBuiltinTool(tool) ? spec.builtin.includes(tool) : mcp !== null && spec.mcpServers.includes(mcp.server);
  if (!inSpec || !ToolName.safeParse(tool).success) {
    return { ...base, policy: "denied", allow: false, reason: `${tool} is not one of this task's tools.` };
  }
  // Read-class built-ins, including Bash commands matching a read pattern, need no approval.
  if (toolClass === "read") return { ...base, policy: "allowed", allow: true };
  if (opts.devAutoApprove) return { ...base, policy: "needs_approval", allow: true };
  return { ...base, policy: "needs_approval", allow: false, reason: APPROVALS_UNAVAILABLE };
}
