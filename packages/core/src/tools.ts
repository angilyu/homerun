import { z } from "zod";
import { named } from "./registry";

/** Every tool is classified (§5.5). */
export const ToolClass = named("ToolClass", z.enum(["read", "write", "destructive", "network"]));
export type ToolClass = z.infer<typeof ToolClass>;

/** SDK built-in tools a task may list (§5.5). `Skill` is deliberately absent (§5.3). */
export const BuiltinTool = named(
  "BuiltinTool",
  z.enum(["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "AskUserQuestion"]),
);
export type BuiltinTool = z.infer<typeof BuiltinTool>;

/**
 * Classification of built-ins (§5.5 table). `Bash` is destructive unless a command matches an
 * allowlisted pattern. `AskUserQuestion` has no side effect; it raises a question (§5.6) and is
 * classed `read` so it never needs an approval of its own.
 */
export const BUILTIN_TOOL_CLASS: Readonly<Record<BuiltinTool, ToolClass>> = {
  Read: "read",
  Glob: "read",
  Grep: "read",
  Write: "write",
  Edit: "write",
  WebFetch: "network",
  WebSearch: "network",
  Bash: "destructive",
  AskUserQuestion: "read",
};

/** Tools whose output is untrusted content and taints the run (§5.5). Third-party MCP output also taints. */
export const UNTRUSTED_SOURCE_BUILTINS: readonly BuiltinTool[] = ["WebFetch", "WebSearch"];

/** Built-ins removed entirely from unattended monitor runs (§5.5). */
export const MONITOR_FORBIDDEN_BUILTINS: readonly BuiltinTool[] = ["Bash"];

/** MCP server name, as used in the SDK's `mcp__<server>__<tool>` tool names. */
export const McpServerName = named("McpServerName", z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/));

/** The in-process server that hosts Homerun's own tools (§5.5). Reserved. */
export const HOMERUN_MCP_SERVER = "homerun";

export const McpToolName = named("McpToolName", z.string().regex(/^mcp__[a-z0-9][a-z0-9_-]{0,62}__[A-Za-z0-9_.-]{1,128}$/));

export const ToolName = named("ToolName", z.union([BuiltinTool, McpToolName]));
export type ToolName = z.infer<typeof ToolName>;

export function isBuiltinTool(name: string): name is BuiltinTool {
  return (BuiltinTool.options as readonly string[]).includes(name);
}

export function isHomerunTool(name: string): boolean {
  return name.startsWith(`mcp__${HOMERUN_MCP_SERVER}__`);
}

/**
 * Shell metacharacters that stop a `Bash` command from ever matching an allowlisted pattern or
 * being granted (§5.5, §5.6). The design lists `;`, `&&`, `||`, `|`, `$(…)`, backticks and
 * redirection. This also rejects a lone `&` (background), any `$` (expansion), and newlines:
 * tightening only.
 */
export const SHELL_METACHARACTERS = /[;&|`$<>\n\r]/;

export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTERS.test(command);
}

/**
 * An allowlisted command pattern such as `git status` or `ls *`. `*` is a wildcard. The first
 * word must be literal, so a bare `*` (any command) is impossible. Matching lives in the runtime.
 */
export const BashCommandPattern = named(
  "BashCommandPattern",
  // One regex so JSON Schema carries the whole rule: a literal first character, no shell
  // metacharacters anywhere, no trailing whitespace.
  z
    .string()
    .min(1)
    .max(1000)
    .regex(
      /^[^\s*;&|`$<>](?:[^;&|`$<>\n\r]*[^\s;&|`$<>])?$/,
      "a literal first word, no shell metacharacters, no surrounding whitespace",
    ),
);
