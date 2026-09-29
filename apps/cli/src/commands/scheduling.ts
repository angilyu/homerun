import {
  RPC_ERROR,
  upgradeSpec,
  type HealthDigest,
  type HealthSettings,
  type JsonValue,
  type MonitorHealth,
  type ScheduleState,
  type TaskSpec,
} from "@homerun/core";
import { RpcCallError } from "@homerun/client";
import { intOption } from "../args";
import { readAll, type Ctx } from "../context";
import { CliError, EXIT, usageError } from "../exit";
import { ago, shortId, table, until, usd } from "../format";
import { isFullId, matchPrefix, resolveTask } from "../ids";

/** A JSON file, or stdin with `-`. */
async function readJson(x: Ctx, file: string | undefined, what: string, option: string): Promise<unknown> {
  if (!file) throw usageError(`give the ${what} with --${option} FILE, or --${option} - to read stdin`);
  let text: string;
  try {
    text = file === "-" ? await readAll(x.io.stdin) : await Bun.file(file).text();
  } catch (e) {
    throw usageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw usageError(`the ${what} is not JSON: ${(e as Error).message}`);
  }
}

/** A TaskSpec from --spec, checked here so a mistake is a usage error, not a round trip. */
export async function readSpec(x: Ctx): Promise<TaskSpec> {
  const raw = await readJson(x, x.values.spec as string | undefined, "spec", "spec");
  try {
    return upgradeSpec(raw);
  } catch (e) {
    const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    const why = issues ? issues.slice(0, 5).map((i) => `${i.path.join(".") || "(spec)"}: ${i.message}`).join("; ") : (e as Error).message;
    throw usageError(`the task spec is not valid: ${why}`);
  }
}

/** CONFLICT from a versioned edit, said plainly. */
function conflict(e: unknown, what: string): never {
  if (e instanceof RpcCallError && e.code === RPC_ERROR.CONFLICT) throw new CliError(`${what} changed since you read it: ${e.message}`, EXIT.ERROR, "read it again and retry");
  throw e;
}

const when = (t: number | null, now = Date.now()) => (t === null ? "" : `${new Date(t).toISOString()} (${t > now ? until(t, now) : ago(t, now)})`);

// ---------------------------------------------------------------- tasks

export async function tasksRunNow(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  let r;
  try {
    r = await c.call("tasks.run_now", { task_id });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.BUDGET_EXCEEDED) throw new CliError(e.message, EXIT.ERROR, "raise the task's monthly cap with `homerun tasks update`");
    throw e;
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.line(r.run_id);
  o.note(`started run ${shortId(r.run_id)}; follow it with: homerun watch ${shortId(r.thread_id)}`);
  return EXIT.OK;
}

export async function tasksUpdate(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const spec = await readSpec(x);
  const expected_version = intOption(values, "expected-version", { min: 1 }) ?? (await c.call("tasks.get", { task_id })).task.version;
  let r;
  try {
    r = await c.call("tasks.update", { task_id, spec, expected_version });
  } catch (e) {
    conflict(e, "the task");
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.note(`updated ${r.task.kind} task "${r.task.name}" to v${r.task.version}`);
  return EXIT.OK;
}

export async function tasksArchive(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const r = await c.call("tasks.archive", { task_id });
  if (o.json) return o.value(r), EXIT.OK;
  o.note(`archived task ${shortId(task_id)}; its schedule no longer fires`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- schedules

function scheduleState(x: Ctx, s: ScheduleState): string {
  const k = x.o.c;
  if (s.enabled) return k.green("on");
  const why: Record<string, string> = { user: "paused", failures: "paused: 3 failed fires", budget_cap: "paused: monthly cap", archived: "archived" };
  return k.yellow(why[s.paused_reason ?? ""] ?? `paused: ${s.paused_reason}`);
}

function describeSchedule(s: ScheduleState): string {
  const spec = s.schedule;
  return spec.kind === "cron" ? `${spec.cron} ${spec.timezone}` : `every ${spec.every_minutes} min`;
}

export async function schedulesList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const task_id = values.task ? await resolveTask(c, values.task as string) : undefined;
  const r = await c.call("schedules.list", task_id ? { task_id } : {});
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.schedules.length) {
    o.note("no schedules: a monitor task has one");
    return EXIT.OK;
  }
  const { tasks } = await c.call("tasks.list", { include_archived: true });
  const name = new Map(tasks.map((t) => [t.task_id, t.name]));
  const k = o.c;
  const now = Date.now();
  const rows = [["SCHEDULE", "TASK", "STATE", "WHEN", "CATCH-UP", "NEXT", "MISSED"].map((h) => k.dim(h))];
  for (const s of r.schedules) {
    const catchup = s.schedule.catchup === "run_all" ? `run_all ≤${s.schedule.max_catchup}` : s.schedule.catchup;
    rows.push([
      shortId(s.schedule_id),
      `${shortId(s.task_id)} ${name.get(s.task_id) ?? ""}`.trimEnd(),
      scheduleState(x, s),
      describeSchedule(s),
      catchup,
      s.enabled && s.next_fire_at !== null ? until(s.next_fire_at, now) : "",
      s.missed_since_last_run ? k.yellow(String(s.missed_since_last_run)) : "",
    ]);
  }
  o.out(table(rows));
  return EXIT.OK;
}

/** A schedule by its id or prefix, or by its task's. */
async function resolveSchedule(x: Ctx, arg: string): Promise<ScheduleState> {
  const { schedules } = await x.c.call("schedules.list", {});
  const a = arg.toLowerCase();
  const bySchedule = schedules.filter((s) => s.schedule_id.startsWith(a));
  const byTask = schedules.filter((s) => s.task_id.startsWith(a));
  if (bySchedule.length && byTask.length) throw usageError(`"${arg}" matches both a schedule and a task; give more characters`);
  if (byTask.length) {
    const id = matchPrefix("task", arg, byTask.map((s) => s.task_id));
    return schedules.find((s) => s.task_id === id)!;
  }
  if (!isFullId(a) && !/^[0-9a-f-]+$/.test(a)) throw usageError(`"${arg}" is not a schedule or task id`);
  const id = matchPrefix("schedule", arg, schedules.map((s) => s.schedule_id));
  const s = schedules.find((x) => x.schedule_id === id);
  if (!s) throw new CliError(`no schedule ${shortId(id)}`, EXIT.ERROR);
  return s;
}

async function setEnabled(x: Ctx, enabled: boolean): Promise<number> {
  const { c, o } = x;
  const s = await resolveSchedule(x, x.positionals[0]!);
  const r = await c.call("schedules.set_enabled", { schedule_id: s.schedule_id, enabled });
  if (o.json) return o.value(r), EXIT.OK;
  const next = r.schedule.next_fire_at;
  o.note(enabled ? `schedule ${shortId(s.schedule_id)} is on${next !== null ? `; next fire ${until(next)}` : ""}` : `schedule ${shortId(s.schedule_id)} is paused`);
  return EXIT.OK;
}

export const schedulesEnable = (x: Ctx) => setEnabled(x, true);
export const schedulesDisable = (x: Ctx) => setEnabled(x, false);

/** YYYY-MM-DD in `zone`. */
function dayIn(zone: string, t: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

export async function schedulesCoverage(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const days = intOption(values, "days", { min: 1, max: 366 }) ?? 7;
  const { schedules } = await c.call("schedules.list", { task_id });
  const s = schedules[0];
  if (!s) throw new CliError(`task ${shortId(task_id)} has no schedule`, EXIT.ERROR);
  const zone = s.schedule.kind === "cron" ? s.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
  const r = await c.call("schedules.coverage", { task_id, from_day: dayIn(zone, now - (days - 1) * 86_400_000), to_day: dayIn(zone, now) });
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.days.length) {
    o.note("nothing was due in that period");
    return EXIT.OK;
  }
  const k = o.c;
  const rows = [["DAY", "DUE", "RAN", "ASLEEP", "NOT RUNNING", "MERGED"].map((h) => k.dim(h))];
  const n = (v: number) => (v ? k.yellow(String(v)) : "0");
  for (const d of r.days) rows.push([d.day, String(d.expected), String(d.ran), n(d.missed_asleep), n(d.missed_not_running), n(d.merged)]);
  o.out(table(rows));
  o.note(k.dim(`days in ${zone}; a late catch-up run leaves its slot counted as missed`));
  return EXIT.OK;
}

// ---------------------------------------------------------------- monitors

export async function monitorsList(x: Ctx): Promise<number> {
  const { c, o } = x;
  const { tasks } = await c.call("tasks.list", { kind: "monitor" });
  const { schedules } = await c.call("schedules.list", {});
  const byTask = new Map(schedules.map((s) => [s.task_id, s]));
  const last = new Map<string, { outcome: string; at: number | null }>();
  for (const t of tasks) {
    const { runs } = await c.call("runs.list", { task_id: t.task_id, limit: 1 });
    const r = runs[0];
    if (r) last.set(t.task_id, { outcome: r.state === "succeeded" ? (r.outcome ?? "succeeded") : r.state, at: r.ended_at ?? r.started_at });
  }
  if (o.json) {
    o.value({ monitors: tasks.map((t) => ({ task: t, schedule: byTask.get(t.task_id) ?? null, last_run: last.get(t.task_id) ?? null })) });
    return EXIT.OK;
  }
  if (!tasks.length) {
    o.note("no monitors: create one with `homerun tasks create --spec FILE`");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["TASK", "NAME", "SCHEDULE", "NEXT", "LAST RUN"].map((h) => k.dim(h))];
  for (const t of tasks) {
    const s = byTask.get(t.task_id);
    const l = last.get(t.task_id);
    const lastText = l ? `${l.outcome === "changed" ? k.cyan(l.outcome) : l.outcome === "failed" ? k.red(l.outcome) : l.outcome}${l.at ? ` ${ago(l.at, now)}` : ""}` : "";
    rows.push([shortId(t.task_id), t.name, s ? scheduleState(x, s) : "", s?.enabled && s.next_fire_at !== null ? until(s.next_fire_at, now) : "", lastText]);
  }
  o.out(table(rows));
  return EXIT.OK;
}

export async function monitorsState(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const r = await c.call("monitors.state.get", { task_id });
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.state) {
    o.note("no state yet: the first successful check records it");
    return EXIT.OK;
  }
  o.note(o.c.dim(`version ${r.state.version} · saved ${when(r.state.updated_at)} by run ${shortId(r.state.last_run_id)}`));
  o.line(JSON.stringify(r.state.state, null, 2));
  return EXIT.OK;
}

async function currentVersion(x: Ctx, task_id: string): Promise<number> {
  const v = intOption(x.values, "expected-version", { min: 1 });
  if (v !== undefined) return v;
  const { state } = await x.c.call("monitors.state.get", { task_id });
  if (!state) throw new CliError("this monitor has no state yet: the first successful check records it", EXIT.ERROR);
  return state.version;
}

export async function monitorsSetState(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const state = (await readJson(x, x.values.state as string | undefined, "state", "state")) as JsonValue;
  const expected_version = await currentVersion(x, task_id);
  let r;
  try {
    r = await c.call("monitors.state.set", { task_id, state, expected_version });
  } catch (e) {
    conflict(e, "the monitor's state");
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.note(`saved; the monitor's state is now version ${r.state.version}. A check already running when you saved it discards its result.`);
  return EXIT.OK;
}

export async function monitorsResetState(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const expected_version = await currentVersion(x, task_id);
  let r;
  try {
    r = await c.call("monitors.state.reset", { task_id, expected_version });
  } catch (e) {
    conflict(e, "the monitor's state");
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.note("cleared; the next check starts fresh and records a new baseline");
  return EXIT.OK;
}

// ---------------------------------------------------------------- health (§8.3)

const DAY_MS = 86_400_000;

export async function healthDigest(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const days = intOption(values, "days", { min: 1, max: 31 }) ?? 1;
  const to = Date.now();
  const { digest } = await c.call("health.digest", { from: to - days * DAY_MS, to });
  if (o.json) return o.value({ digest }), EXIT.OK;
  printDigest(x, digest);
  return EXIT.OK;
}

function printDigest(x: Ctx, d: HealthDigest): void {
  const { o } = x;
  const k = o.c;
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: d.timezone, dateStyle: "medium", timeStyle: "short" });
  o.line(`${k.bold("Monitor health")} ${k.dim(`${fmt.format(d.from)} – ${fmt.format(d.to)} (${d.timezone})`)}`);
  o.line(d.needs_attention ? k.yellow("Something needs a look.") : k.green("All monitors ran as expected."));
  if (!d.monitors.length) o.line(k.dim("no monitors"));
  for (const m of d.monitors) o.line(monitorLine(x, m));
  if (d.downtime.length) {
    o.line("");
    for (const t of d.downtime) {
      const mins = Math.round((t.end_at - t.start_at) / 60_000);
      const span = mins >= 120 ? `${(mins / 60).toFixed(1)} h` : `${mins} min`;
      o.line(k.dim(`${t.cause === "asleep" ? "asleep" : "Homerun not running"} ${fmt.format(t.start_at)} – ${fmt.format(t.end_at)} (${span})`));
    }
  }
  o.line(k.dim(`cost ${usd(d.cost_usd)}`));
}

function monitorLine(x: Ctx, m: MonitorHealth): string {
  const k = x.o.c;
  const mark = m.needs_attention ? k.yellow("!") : k.green("✓");
  const parts = [`ran ${m.succeeded + m.failed} of ${m.expected} due`];
  if (m.changes) parts.push(k.cyan(`${m.changes} change${m.changes === 1 ? "" : "s"}`));
  if (m.failed) parts.push(k.red(`${m.failed} failed`));
  if (m.missed_asleep) parts.push(`${m.missed_asleep} missed asleep`);
  if (m.missed_not_running) parts.push(`${m.missed_not_running} missed while Homerun was not running`);
  if (m.skipped) parts.push(`${m.skipped} skipped`);
  if (m.caught_up) parts.push(`${m.caught_up} caught up late`);
  if (!m.enabled) parts.push(k.yellow(m.paused_reason === "budget_cap" ? "paused at its monthly cap" : m.paused_reason === "failures" ? "paused after 3 failed fires" : "paused"));
  parts.push(usd(m.cost_usd));
  return `${mark} ${m.name} ${k.dim(shortId(m.task_id))}: ${parts.join(", ")}`;
}

export async function healthSettings(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  if (values.on && values.off) throw usageError("give --on or --off, not both");
  const change = values.on || values.off || values.time !== undefined || values.timezone !== undefined;
  let settings: HealthSettings = (await c.call("health.settings.get", {})).settings;
  if (change) {
    if (values.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(values.time as string)) throw usageError("--time must be HH:MM, 24-hour");
    const next: HealthSettings = {
      ...settings,
      ...(values.on ? { enabled: true } : values.off ? { enabled: false } : {}),
      ...(values.time !== undefined ? { time: values.time as string } : {}),
      ...(values.timezone !== undefined ? { timezone: values.timezone as string } : {}),
    };
    settings = (await c.call("health.settings.set", { settings: next })).settings;
  }
  if (o.json) return o.value({ settings }), EXIT.OK;
  o.line(settings.enabled ? `daily digest at ${settings.time} ${settings.timezone}` : "daily digest off");
  return EXIT.OK;
}
