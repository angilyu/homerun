import type { Device } from "@homerun/core";
import type { AgentEngine } from "../agent/engine";
import type { McpLauncher } from "../agent/claude/mcp";
import type { Config } from "../config";
import type { SecretStore } from "../secrets";
import type { Store } from "../store/store";

/** Everything a run needs from the runtime. */
export interface RunContext {
  store: Store;
  config: Config;
  device: Device;
  secrets: SecretStore;
  engine: AgentEngine;
  mcp: McpLauncher;
  /** Boot time recorded with `claude_pid`, for the PID-reuse check at the next start. */
  bootTime: number;
  now?: () => number;
}

export const now = (ctx: RunContext): number => (ctx.now ? ctx.now() : Date.now());
