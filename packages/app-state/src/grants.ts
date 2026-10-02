import { ANY_DOMAIN, type ToolGrant } from "@homerun/core";
import { toolName } from "./format";

/** "Bash · git status *", "WebFetch · docs.github.com", "WebFetch · any domain", "github · create_issue (every call)" (§5.6). */
export function grantText(g: Pick<ToolGrant, "tool" | "pattern">): string {
  if (g.tool === "WebFetch" && g.pattern === ANY_DOMAIN) return `${toolName(g.tool)} · any domain`;
  return `${toolName(g.tool)} · ${g.pattern ?? "every call"}`;
}

export function activeGrants(gs: readonly ToolGrant[]): ToolGrant[] {
  return gs.filter((g) => g.revoked_at === null).sort((a, b) => b.granted_at - a.granted_at);
}
