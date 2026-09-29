import { z } from "zod";
import { named } from "./registry";
import { JsonValue, MONITOR_STATE_MAX_BYTES, jsonByteLength } from "./common";
import { ScheduleSpec } from "./schedule";
import {
  BashCommandPattern,
  BuiltinTool,
  HOMERUN_MCP_SERVER,
  MONITOR_FORBIDDEN_BUILTINS,
  McpServerName,
  ToolClass,
} from "./tools";

/**
 * Shape version of the spec JSON, separate from the task's edit counter (`tasks.version`).
 * Rows in `task_versions` are immutable, so every format ever written must stay readable
 * through `upgradeSpec`.
 */
export const SPEC_FORMAT = 1 as const;

export const ModelId = named(
  "ModelId",
  z.string().min(1).max(200),
  "A Claude model id or alias. Free-form, because Bedrock, Vertex and Foundry ids differ (§7.2)",
);

export const ModelChoice = named("ModelChoice", z.object({ model: ModelId, fallback_model: ModelId.optional() }));
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Per-run `maxBudgetUsd` plus an optional per-task cap; runs pause when a cap is reached (§7.4). */
export const Budget = named(
  "Budget",
  z.object({
    max_run_usd: z.number().positive().max(10_000),
    monthly_cap_usd: z.number().positive().max(100_000).optional(),
  }),
);

// ---------------------------------------------------------------- tools

const exactVersion = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/, "an exact version, not a range");

export const McpServerSpec = named(
  "McpServerSpec",
  z.discriminatedUnion("transport", [
    z.object({
      id: McpServerName,
      transport: z.literal("stdio"),
      /** Homerun's own Node (`npx`) or `uv` (`uvx`) component (§5.5). */
      runner: z.enum(["npx", "uvx"]),
      package: z.string().min(1).max(214),
      version: exactVersion,
      args: z.array(z.string().max(4096)).max(64),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)),
      catalog_id: z.string().min(1).max(200).optional(),
    }),
    z.object({
      id: McpServerName,
      transport: z.literal("http"),
      url: z.url({ protocol: /^https$/ }).regex(/^https:\/\//),
      catalog_id: z.string().min(1).max(200).optional(),
    }),
  ]),
);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

export const HomerunToolName = named("HomerunToolName", z.string().regex(/^[a-z][a-z0-9_]{0,63}$/));

export const ToolsSpec = named(
  "ToolsSpec",
  z
    .object({
      builtin: z.array(BuiltinTool),
      mcp_servers: z.array(McpServerSpec).max(32),
      /** Homerun's in-process tools (§5.5), exposed as `mcp__homerun__<name>`. */
      homerun: z.array(HomerunToolName),
    })
    .superRefine((t, ctx) => {
      if (new Set(t.builtin).size !== t.builtin.length) ctx.addIssue({ code: "custom", path: ["builtin"], message: "duplicate tool" });
      const ids = t.mcp_servers.map((s) => s.id);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["mcp_servers"], message: "duplicate server id" });
      if (ids.includes(HOMERUN_MCP_SERVER))
        ctx.addIssue({ code: "custom", path: ["mcp_servers"], message: `server id "${HOMERUN_MCP_SERVER}" is reserved` });
      if (new Set(t.homerun).size !== t.homerun.length) ctx.addIssue({ code: "custom", path: ["homerun"], message: "duplicate tool" });
    }),
);
export type ToolsSpec = z.infer<typeof ToolsSpec>;

// ---------------------------------------------------------------- policy (§5.5, §5.6, §6.1, §13)

/** Absolute path, or `~/`-relative. Windows drive paths are accepted for the future port. */
export const RootPath = named("RootPath", z.string().min(1).max(4096).regex(/^(\/|~\/|~$|[A-Za-z]:[\\/])/));

/** Hostname, optionally with a leading `*.` wildcard. Lowercase. */
export const EgressDomain = named(
  "EgressDomain",
  z.string().max(253).regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/),
);

export const EgressPolicy = named(
  "EgressPolicy",
  z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("allowlist"), domains: z.array(EgressDomain).max(500) }),
    /** Disables the taint rule. Only for tasks with no private data (§5.5). */
    z.object({ mode: z.literal("open") }),
  ]),
);

export const BashPattern = named("BashPattern", z.object({ pattern: BashCommandPattern, class: ToolClass }));

/** What happens when an input request goes unanswered (§5.6). */
export const InputTimeoutPolicy = named(
  "InputTimeoutPolicy",
  z.discriminatedUnion("action", [
    z.object({ action: z.literal("wait"), remind_after_ms: z.int().positive().nullable() }),
    z.object({ action: z.literal("deny"), after_ms: z.int().positive() }),
    z.object({ action: z.literal("cancel_run"), after_ms: z.int().positive() }),
  ]),
);

/** Full tool outputs are kept this many days; `null` = forever (§6.1). */
export const RetentionDays = named("RetentionDays", z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]));

export const TaskPolicy = named(
  "TaskPolicy",
  z.object({
    roots: z.array(RootPath).max(64),
    egress: EgressPolicy,
    bash_patterns: z.array(BashPattern).max(200),
    /** "Use my shell environment" (§5.3): the user's $SHELL, real HOME and profile. */
    use_shell_environment: z.boolean(),
    input_timeout: InputTimeoutPolicy,
    retention_days: RetentionDays,
  }),
);
export type TaskPolicy = z.infer<typeof TaskPolicy>;

// ---------------------------------------------------------------- monitor checks (§8.3)

export const HttpExtract = named(
  "HttpExtract",
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("body") }),
    z.object({ kind: z.literal("json_path"), path: z.string().min(1).max(1000) }),
    z.object({ kind: z.literal("css"), selector: z.string().min(1).max(1000) }),
    z.object({ kind: z.literal("regex"), pattern: z.string().min(1).max(1000), group: z.int().nonnegative().optional() }),
  ]),
);

const httpUrl = z.url({ protocol: /^https?$/ }).regex(/^https?:\/\//);

export const RuleSource = named(
  "RuleSource",
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("http"), url: httpUrl, extract: HttpExtract }),
    z.object({ type: z.literal("feed"), url: httpUrl, format: z.enum(["rss", "atom", "auto"]) }),
    z.object({ type: z.literal("file_hash"), path: RootPath }),
    z.object({ type: z.literal("homerun_tool"), tool: HomerunToolName, args: JsonValue }),
  ]),
);

export const Comparator = named(
  "Comparator",
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("changed") }),
    z.object({ op: z.literal("equals"), value: JsonValue }),
    z.object({ op: z.literal("above"), value: z.number() }),
    z.object({ op: z.literal("below"), value: z.number() }),
    /** Items not in saved state. `id_field` picks the identity key; feeds default to the entry id. */
    z.object({ op: z.literal("new_items"), id_field: z.string().min(1).max(200).optional() }),
  ]),
);

export const RuleCheck = named(
  "RuleCheck",
  z.object({
    kind: z.literal("rule"),
    source: RuleSource,
    normalize: z.object({ trim: z.boolean(), collapse_whitespace: z.boolean(), lowercase: z.boolean() }).optional(),
    comparator: Comparator,
  }),
  "Evaluated by the runtime with no model call (§8.3)",
);

/**
 * One cheap `query()` that returns a CheckResult (§8.3). With a `source`, the runtime fetches the
 * observation itself, as for a rule check, and the model only judges it, with no tools. Without
 * one, the model gathers observations with the task's own tools, under the task's policy.
 */
export const ModelCheck = named(
  "ModelCheck",
  z.object({
    kind: z.literal("model"),
    model: ModelId,
    instructions: z.string().max(20_000).optional(),
    source: RuleSource.optional(),
  }),
  "One cheap query() that returns CheckResult (§8.3)",
);

export const CheckSpec = named("CheckSpec", z.discriminatedUnion("kind", [RuleCheck, ModelCheck]));
export type CheckSpec = z.infer<typeof CheckSpec>;

const boundedState = JsonValue.refine((v) => jsonByteLength(v) <= MONITOR_STATE_MAX_BYTES, `at most ${MONITOR_STATE_MAX_BYTES} bytes`);

/** Output of a check. Evidence is required, so "why didn't it notice?" can be answered (§8.3). */
export const CheckResult = named(
  "CheckResult",
  z.object({ changed: z.boolean(), evidence: z.string().min(1).max(20_000), new_state: boundedState }),
);
export type CheckResult = z.infer<typeof CheckResult>;

export const ActSpec = named("ActSpec", z.object({ model: ModelChoice, instructions: z.string().max(20_000).optional() }));

// ---------------------------------------------------------------- the spec

const common = {
  format: z.literal(SPEC_FORMAT),
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(100_000),
  budget: Budget,
  tools: ToolsSpec,
  policy: TaskPolicy,
};

type CommonShape = { tools: ToolsSpec; policy: TaskPolicy };

function checkCommon(s: CommonShape, ctx: z.RefinementCtx) {
  if (s.policy.egress.mode === "open" && s.policy.roots.length > 0) {
    ctx.addIssue({ code: "custom", path: ["policy", "egress"], message: "open egress is only allowed for tasks with no file roots (§5.5)" });
  }
  if (s.policy.bash_patterns.length > 0 && !s.tools.builtin.includes("Bash")) {
    ctx.addIssue({ code: "custom", path: ["policy", "bash_patterns"], message: "bash patterns need the Bash tool" });
  }
}

export const SessionSpec = named(
  "SessionSpec",
  z.object({ kind: z.literal("session"), ...common, model: ModelChoice }).superRefine(checkCommon),
);
export type SessionSpec = z.infer<typeof SessionSpec>;

export const MonitorSpec = named(
  "MonitorSpec",
  z
    .object({ kind: z.literal("monitor"), ...common, schedule: ScheduleSpec, check: CheckSpec, act: ActSpec })
    .superRefine((s, ctx) => {
      checkCommon(s, ctx);
      for (const t of MONITOR_FORBIDDEN_BUILTINS)
        if (s.tools.builtin.includes(t)) ctx.addIssue({ code: "custom", path: ["tools", "builtin"], message: `monitors cannot use ${t} (§5.5)` });
      if (s.policy.use_shell_environment)
        ctx.addIssue({ code: "custom", path: ["policy", "use_shell_environment"], message: "monitors have no shell" });
    }),
);
export type MonitorSpec = z.infer<typeof MonitorSpec>;

export const TaskSpec = named("TaskSpec", z.discriminatedUnion("kind", [SessionSpec, MonitorSpec]));
export type TaskSpec = z.infer<typeof TaskSpec>;

/** Reads a stored spec of any format and returns the current format. Only format 1 exists. */
export function upgradeSpec(stored: unknown): TaskSpec {
  const format = (stored as { format?: unknown } | null)?.format;
  switch (format) {
    case 1:
      return TaskSpec.parse(stored);
    default:
      throw new Error(`unsupported task spec format ${JSON.stringify(format)}`);
  }
}
