import type { McpServerSpec } from "@homerun/core";
import type { McpOverride } from "../../config";

export class RunSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunSetupError";
  }
}

export interface ResolvedMcpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Turns a task's MCP server spec into a process to launch (§5.5). Production launches
 * `npx`/`uvx` from Homerun's own Node and uv components, which arrive in a later milestone; until
 * then a run that needs them fails with `component_missing`. Development builds may map a
 * `package@version` to a local command (`--dev-mcp-overrides`); the tests use this for
 * their stdio fixture.
 */
export class McpLauncher {
  constructor(private overrides: Record<string, McpOverride>) {}

  resolve(spec: McpServerSpec): ResolvedMcpServer {
    if (spec.transport !== "stdio") {
      throw new RunSetupError("unsupported_mcp_transport", `MCP server "${spec.id}": remote (http) servers arrive in a later version of Homerun.`);
    }
    const o = this.overrides[`${spec.package}@${spec.version}`];
    if (o) return { command: o.command, args: [...(o.args ?? []), ...spec.args], env: { ...(o.env ?? {}), ...spec.env } };
    throw new RunSetupError(
      "component_missing",
      `MCP server "${spec.id}" needs the ${spec.runner === "npx" ? "Node" : "uv"} component, which this version of Homerun does not include yet.`,
    );
  }

  resolveAll(specs: readonly McpServerSpec[]): Record<string, ResolvedMcpServer> {
    return Object.fromEntries(specs.map((s) => [s.id, this.resolve(s)]));
  }
}
