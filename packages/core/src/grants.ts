import { z } from "zod";
import { named } from "./registry";
import { DeviceId, GrantId, TaskId, TimestampMs } from "./common";
import { BUILTIN_TOOL_CLASS, BashCommandPattern, ToolName, isBuiltinTool } from "./tools";
import { EgressDomain } from "./task-spec";

/** A grant may never carry `destructive` (§5.6). */
export const GrantClass = named("GrantClass", z.enum(["read", "write", "network"]));
export type GrantClass = z.infer<typeof GrantClass>;

type GrantShape = { tool: string; pattern: string | null; class: GrantClass };

/**
 * Shared rules for a grant and for the grant proposed in an "Always allow" answer:
 * - `Bash` needs an exact command pattern with no shell metacharacters, never bare `Bash`;
 * - `WebFetch` patterns are domains;
 * - other built-ins keep their built-in class;
 * - third-party MCP tools ("Trust this tool", §5.5) take any non-destructive class.
 */
export function checkGrantShape(g: GrantShape, ctx: z.RefinementCtx) {
  if (g.tool === "Bash") {
    if (g.pattern === null) ctx.addIssue({ code: "custom", path: ["pattern"], message: "a Bash grant needs a command pattern" });
    else if (!BashCommandPattern.safeParse(g.pattern).success)
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "not a grantable Bash command pattern" });
    return;
  }
  if (isBuiltinTool(g.tool)) {
    const cls = BUILTIN_TOOL_CLASS[g.tool];
    if (cls !== g.class) ctx.addIssue({ code: "custom", path: ["class"], message: `${g.tool} is ${cls}` });
    if (g.tool === "WebFetch" && g.pattern !== null && !EgressDomain.safeParse(g.pattern).success)
      ctx.addIssue({ code: "custom", path: ["pattern"], message: "a WebFetch grant pattern is a domain" });
  }
}

/** "Always allow": one task, one tool, optionally one argument pattern (§5.6 `tool_grants`). */
export const ToolGrant = named(
  "ToolGrant",
  z
    .object({
      grant_id: GrantId,
      task_id: TaskId,
      tool: ToolName,
      /** Command, domain or path pattern; null = any use of this tool. */
      pattern: z.string().min(1).max(1000).nullable(),
      class: GrantClass,
      granted_by: DeviceId,
      granted_at: TimestampMs,
      revoked_at: TimestampMs.nullable(),
    })
    .superRefine(checkGrantShape),
);
export type ToolGrant = z.infer<typeof ToolGrant>;

/** The grant a user confirms in an "Always allow" answer, after seeing and editing the pattern. */
export const GrantProposal = named(
  "GrantProposal",
  z.object({ tool: ToolName, pattern: z.string().min(1).max(1000).nullable(), class: GrantClass }).superRefine(checkGrantShape),
);
export type GrantProposal = z.infer<typeof GrantProposal>;

/**
 * Egress allowlist in effect for a run: the spec's domains plus the domains of active `WebFetch`
 * grants. An "Always allow" on a tainted request adds a grant; it does not edit the spec.
 */
export function effectiveEgressDomains(specDomains: readonly string[], grants: readonly ToolGrant[]): string[] {
  const out = new Set(specDomains);
  for (const g of grants) if (g.revoked_at === null && g.tool === "WebFetch" && g.pattern !== null) out.add(g.pattern);
  return [...out];
}
