import type { Step } from "./sim-claude";

export const TOKEN = "c".repeat(64);
export const CLIENT_MSG_ID = "00000000-0000-4000-8000-000000000001";
/** Sent while the run waits for "Did this happen?": held, then delivered with the answer. */
export const HELD_MSG_ID = "00000000-0000-4000-8000-000000000002";

export interface ChildArgs {
  dir: string;
  scenario: string;
  /** SIGKILL homerund at this boundary (1-based). */
  killAt?: number;
  /** Kill `claude` alone at this boundary; homerund keeps running (agent_exited). */
  dieAt?: number;
  mode?: "inject" | "truncate";
}

export interface Scenario {
  message: string;
  plan: Step[];
  spec: unknown;
  /** The mirror stores nothing until this step's side effect happened (`SimEngine`). */
  mirrorAfter?: string;
}

const spec = {
  kind: "session",
  format: 1,
  name: "crash",
  prompt: "p",
  budget: { max_run_usd: 1 },
  tools: { builtin: ["Read", "Bash", "Write"], mcp_servers: [], homerun: [] },
  policy: {
    roots: [],
    egress: { mode: "allowlist", domains: [] },
    bash_patterns: [],
    use_shell_environment: false,
    input_timeout: { action: "wait", remind_after_ms: null },
    retention_days: 30,
  },
  model: { model: "haiku" },
};

export const SCENARIOS: Record<string, Scenario> = {
  /** A read, a destructive command, and a write whose tool_use the mirror writes late. */
  serial: {
    message: "Read a.txt, append to the log, then write b.txt.",
    spec,
    plan: [
      { name: "read", tool: "Read", input: { file_path: "a.txt" } },
      { name: "append", tool: "Bash", input: { command: "echo A >> log.txt" } },
      { name: "write", tool: "Write", input: { file_path: "b.txt", content: "B" }, lagUse: true },
    ],
  },
  /** Two destructive calls in one assistant message, after a read in the same message. */
  parallel: {
    message: "Do both steps.",
    spec,
    plan: [
      { name: "read", tool: "Read", input: { file_path: "a.txt" } },
      { name: "one", tool: "Bash", input: { command: "echo 1 >> log.txt" }, withPrev: true },
      { name: "two", tool: "Bash", input: { command: "echo 2 >> log.txt" }, withPrev: true },
    ],
  },
  /**
   * The mirror lags from the start: nothing of the conversation is stored until the first call's
   * side effect happened, so a crash can leave a session `claude` cannot resume (seen in CI).
   */
  lagging: {
    message: "Append to the log, then write b.txt.",
    spec,
    plan: [
      { name: "append", tool: "Bash", input: { command: "echo A >> log.txt" } },
      { name: "write", tool: "Write", input: { file_path: "b.txt", content: "B" } },
    ],
    mirrorAfter: "append",
  },
};
