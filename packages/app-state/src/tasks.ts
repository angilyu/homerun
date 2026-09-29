import {
  TaskSpec,
  type MonitorSpec,
  type ScheduleState,
  type SessionSpec,
  type Task,
} from "@homerun/core";
import { errorMessage } from "./errors";
import type { Rpc } from "./rpc";
import { Store } from "./store";

/**
 * Tasks and their schedules (§2.1, §8). There is no change notification for them (§9.8 lists
 * only thread changes), so the list is fetched after every mutation and on demand; a view
 * polls while visible.
 */

export interface TaskRow {
  task: Task;
  /** A monitor's schedule; null for session tasks. */
  schedule: ScheduleState | null;
}

export interface TasksState {
  rows: readonly TaskRow[];
  loaded: boolean;
  error: string | null;
}

export class Tasks {
  readonly store = new Store<TasksState>({ rows: [], loaded: false, error: null });

  constructor(private readonly rpc: Rpc) {}

  async refresh(): Promise<void> {
    try {
      const [t, s] = await Promise.all([this.rpc.call("tasks.list", {}), this.rpc.call("schedules.list", {})]);
      const byTask = new Map(s.schedules.map((x) => [x.task_id as string, x]));
      const rows = t.tasks
        .map((task) => ({ task, schedule: byTask.get(task.task_id) ?? null }))
        .sort((a, b) => a.task.name.localeCompare(b.task.name));
      this.store.set({ rows, loaded: true, error: null });
    } catch (e) {
      this.store.set((s) => ({ ...s, error: errorMessage(e) }));
    }
  }

  row(task_id: string): TaskRow | undefined {
    return this.store.get().rows.find((r) => r.task.task_id === task_id);
  }

  async create(spec: TaskSpec, from_thread_id?: string) {
    const r = await this.rpc.call("tasks.create", { spec, ...(from_thread_id ? { from_thread_id } : {}) });
    await this.refresh();
    return r;
  }

  /** CONFLICT unless `expected_version` is current: someone else edited it (§6). */
  async update(task_id: string, spec: TaskSpec, expected_version: number) {
    const r = await this.rpc.call("tasks.update", { task_id, spec, expected_version });
    await this.refresh();
    return r.task;
  }

  async archive(task_id: string): Promise<void> {
    await this.rpc.call("tasks.archive", { task_id });
    await this.refresh();
  }

  async runNow(task_id: string) {
    const r = await this.rpc.call("tasks.run_now", { task_id });
    void this.refresh();
    return r;
  }

  async setEnabled(schedule_id: string, enabled: boolean): Promise<ScheduleState> {
    const r = await this.rpc.call("schedules.set_enabled", { schedule_id, enabled });
    this.store.set((s) => ({ ...s, rows: s.rows.map((row) => (row.schedule?.schedule_id === schedule_id ? { ...row, schedule: r.schedule } : row)) }));
    return r.schedule;
  }
}

// ---------------------------------------------------------------- the task editor (§2.1, §5.5, §8)

/** Model aliases the runtime passes to the SDK (§7.2); a custom id is allowed too. */
export const MODEL_ALIASES = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;

export const DEFAULT_POLICY: SessionSpec["policy"] = {
  roots: [],
  egress: { mode: "allowlist", domains: [] },
  bash_patterns: [],
  use_shell_environment: false,
  input_timeout: { action: "wait", remind_after_ms: null },
  retention_days: 30,
};

export function newSessionSpec(): SessionSpec {
  return {
    format: 1,
    kind: "session",
    name: "",
    prompt: "",
    model: { model: "sonnet" },
    budget: { max_run_usd: 2 },
    tools: { builtin: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion"], mcp_servers: [], homerun: [] },
    policy: DEFAULT_POLICY,
  };
}

export function newMonitorSpec(): MonitorSpec {
  return {
    format: 1,
    kind: "monitor",
    name: "",
    prompt: "",
    budget: { max_run_usd: 0.5, monthly_cap_usd: 10 },
    tools: { builtin: ["WebFetch"], mcp_servers: [], homerun: [] },
    policy: DEFAULT_POLICY,
    schedule: { kind: "interval", every_minutes: 60, catchup: "run_once", max_catchup: 1 },
    check: { kind: "rule", source: { type: "http", url: "https://example.com", extract: { kind: "body" } }, comparator: { op: "changed" } },
    act: { model: { model: "haiku" } },
  };
}

export interface SpecIssue {
  /** Dotted path into the spec, e.g. `schedule.every_minutes`; "" for the whole spec. */
  path: string;
  message: string;
}

export type SpecCheck = { ok: true; spec: TaskSpec } | { ok: false; issues: SpecIssue[] };

/** The core schema is the validator, so the editor accepts exactly what the runtime accepts. */
export function checkSpec(draft: unknown): SpecCheck {
  const r = TaskSpec.safeParse(draft);
  if (r.success) return { ok: true, spec: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

export function issuesAt(check: SpecCheck, path: string): string[] {
  if (check.ok) return [];
  return check.issues.filter((i) => i.path === path || i.path.startsWith(path + ".")).map((i) => i.message);
}

/** An immutable update at a dotted path, creating objects on the way. */
export function setAt<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const rec = (o: unknown, i: number): unknown => {
    const k = keys[i]!;
    const base = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const copy: Record<string, unknown> = Array.isArray(base) ? ([...base] as unknown as Record<string, unknown>) : { ...base };
    if (i === keys.length - 1) {
      if (value === undefined) delete copy[k];
      else copy[k] = value;
    } else copy[k] = rec(base[k], i + 1);
    return copy;
  };
  return rec(obj, 0) as T;
}

export function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** "Paused after failures", "Paused", "On". */
export function scheduleStateText(s: ScheduleState | null): string {
  if (!s) return "";
  if (s.enabled) return "On";
  switch (s.paused_reason) {
    case "failures":
      return "Paused after failures";
    case "budget_cap":
      return "Paused: monthly budget reached";
    case "archived":
      return "Archived";
    default:
      return "Paused";
  }
}
