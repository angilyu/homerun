import type { BuiltinTool } from "@homerun/core";

/**
 * The seam between the run driver and an agent implementation (§3.4 of the plan). The Claude
 * engine drives the Agent SDK; the fake engine scripts the same events for unit tests.
 *
 * Events are delivered synchronously through `sink` in the order the engine observed them, so
 * the driver can persist them in that order.
 */

export interface UserInput {
  /** Also the SDKUserMessage uuid, echoed back in `result.user_message_uuids`. */
  uuid: string;
  text: string;
}

export interface ToolCallRequest {
  toolCallId: string;
  tool: string;
  input: unknown;
  mcpServer?: string;
  parentToolCallId?: string;
}

export type GateDecision = { allow: true } | { allow: false; reason: string };

export interface ToolOutcome {
  toolCallId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs?: number;
  interrupted?: boolean;
}

/** Called by the engine before any tool runs, and after it finishes (§5.4). */
export interface ToolGate {
  preTool(call: ToolCallRequest): Promise<GateDecision>;
  postTool(outcome: ToolOutcome): void;
}

export type EngineEvent =
  | { type: "session"; sessionId: string; tools: string[]; mcpServers: Array<{ name: string; status: string }>; skills: string[]; plugins: string[]; model: string }
  | { type: "delta"; messageId: string; text: string }
  | { type: "message"; messageId: string; text: string; model?: string; parentToolCallId?: string }
  /** A tool_result the model received, seen in the transcript stream (safety net for a missed Post hook). */
  | { type: "tool_result_seen"; toolCallId: string; isError: boolean; content: unknown }
  | { type: "status"; detail: "retrying_model" | "rate_limited"; retryAt?: number }
  | {
      type: "result";
      ok: boolean;
      subtype: string;
      totalCostUsd: number | null;
      /** Inputs this turn consumed; null when the producer did not say. */
      consumed: string[] | null;
      queuedTurnCount: number | null;
      errors: string[];
      /** With `outputFormat`: the validated JSON the model returned (§8.3 model checks). */
      structuredOutput?: unknown;
      /** The final text of the turn, when the producer reports it. */
      text?: string;
    };

export interface EngineExit {
  code: number | null;
  signal: string | null;
  /** Set when the SDK iteration itself failed. */
  error?: string;
}

export interface EngineStart {
  runId: string;
  cwd: string;
  appendSystemPrompt: string | null;
  /**
   * A complete system prompt instead of the preset plus `appendSystemPrompt`. Monitor checks
   * use it: one small judgement needs none of the coding agent's instructions (§8.3).
   */
  systemPrompt?: string;
  /** Ask for a JSON result matching this schema (`result.structured_output`). */
  outputSchema?: Record<string, unknown>;
  maxTurns?: number;
  model: string;
  fallbackModel: string | null;
  maxBudgetUsd: number;
  builtinTools: readonly BuiltinTool[];
  /** Resolved stdio MCP servers, by spec id. */
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  resume: string | null;
  /** With `resume`: continue from this transcript entry, dropping what follows (`resumeSessionAt`). */
  resumeAt?: string | null;
  env: Record<string, string>;
  initialInputs: UserInput[];
  gate: ToolGate;
  sink: (e: EngineEvent) => void;
  /** Called with the group leader's pid as soon as it is spawned, before any tool can run. */
  onSpawn: (pid: number) => void;
  stderr?: (line: string) => void;
}

export interface EngineRun {
  push(input: UserInput): void;
  /** Ask the agent to stop its current turn. */
  interrupt(): Promise<void>;
  /** No more input: the agent exits after its current turn. */
  closeInput(): void;
  /** SIGKILL the whole process group. */
  kill(): void;
  /** SIGKILL the group and wait until every member is gone (stray children included). */
  reap(): Promise<void>;
  readonly pid: number | null;
  /** Resolves when the agent process has exited and the event stream has ended. */
  readonly exited: Promise<EngineExit>;
}

export interface AgentEngine {
  start(opts: EngineStart): EngineRun;
}
