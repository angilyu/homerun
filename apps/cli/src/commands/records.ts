import { openSync, closeSync, writeSync } from "node:fs";
import {
  ACTIVE_RUN_STATES,
  RPC_ERROR,
  RunState,
  TaskKind,
  type CallerRole,
  type InputRequest,
  type Run,
} from "@homerun/core";
import { RpcCallError } from "@homerun/client";
import { intOption } from "../args";
import { BUILD_CHANNEL, CLI_VERSION } from "../build";
import type { Ctx } from "../context";
import { CliError, EXIT, usageError } from "../exit";
import { ago, oneLine, shortId, table, truncate, usd } from "../format";
import { allThreadIds, isFullId, matchPrefix, resolveRun, resolveTask, resolveThread } from "../ids";
import { cliAnswers, EventRenderer, promptLines } from "../render";
import { readSpec } from "./scheduling";

export async function status(x: Ctx, socketPath: string): Promise<number> {
  const { c, o } = x;
  const ping = await c.call("ping", {});
  const { runs } = await c.call("runs.list", { states: [...ACTIVE_RUN_STATES], limit: 500 });
  const { requests } = await c.call("input.list_pending", {});
  if (o.json) {
    o.value({
      socket: socketPath,
      runtime_version: ping.runtime_version,
      protocol: ping.protocol,
      role: c.hello!.role,
      device_id: c.hello!.device_id,
      cli: { version: CLI_VERSION, build: BUILD_CHANNEL },
      active_runs: runs,
      pending_input: requests,
    });
    return EXIT.OK;
  }
  const k = o.c;
  o.line(`${k.green("●")} homerund ${ping.runtime_version} ${k.dim(`· protocol ${ping.protocol} · ${socketPath}`)}`);
  o.line(k.dim(`  connected as ${c.hello!.role} (CLI ${CLI_VERSION}, ${BUILD_CHANNEL}) · device ${shortId(c.hello!.device_id)}`));
  if (!runs.length) o.line("  no active runs");
  else {
    const by = (s: string) => runs.filter((r) => r.state === s).length;
    const parts = [
      [by("running"), "running"],
      [by("pending"), "queued"],
      [by("waiting_input"), "waiting for input"],
    ].filter(([n]) => n) as [number, string][];
    o.line(`  ${runs.length} active run${runs.length === 1 ? "" : "s"}: ${parts.map(([n, s]) => `${n} ${s}`).join(", ")}`);
  }
  if (requests.length) o.line(`  ${requests.length} input request${requests.length === 1 ? "" : "s"} pending ${k.dim("(homerun input list)")}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- threads

export async function threadsList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const limit = intOption(values, "limit", { min: 1, max: 500 }) ?? 20;
  const task_id = values.task ? await resolveTask(c, values.task as string) : undefined;
  const r = await c.call("threads.list", { limit, ...(task_id ? { task_id } : {}) });
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.threads.length) {
    o.note("no threads yet: start one with `homerun chat` or `homerun send --new TEXT`");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["THREAD", "UPDATED", "STATE", "TITLE"].map((h) => k.dim(h))];
  for (const t of r.threads) {
    const state = t.input_pending ? k.yellow("needs input") : t.active_run ? k.cyan(t.active_run.state === "pending" ? "queued" : t.active_run.state) : "";
    const title = t.title ?? (t.task_id ? "(task)" : "(untitled)");
    const last = t.last_message ? k.dim(` — ${t.last_message.role === "user" ? "you: " : ""}${truncate(oneLine(t.last_message.preview), 60)}`) : "";
    rows.push([shortId(t.thread_id), ago(t.updated_at, now), state, truncate(title, 40) + last]);
  }
  o.out(table(rows));
  if (r.has_more) o.note(k.dim(`(more threads: --limit ${Math.min(500, limit * 2)})`));
  return EXIT.OK;
}

export async function threadsNew(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const r = await c.call("threads.create", values.title !== undefined ? { title: values.title as string } : {});
  if (o.json) o.value(r);
  else o.line(r.thread.thread_id);
  return EXIT.OK;
}

export async function threadsShow(x: Ctx): Promise<number> {
  const { c, o, values, positionals } = x;
  const thread_id = await resolveThread(c, positionals[0]!);
  const limit = intOption(values, "limit", { min: 1, max: 500 }) ?? 50;
  const before_seq = intOption(values, "before", { min: 1 });
  const r = await c.call("threads.history", { thread_id, limit, ...(before_seq !== undefined ? { before_seq } : {}) });
  if (o.json) return o.value(r), EXIT.OK;
  if (r.has_more && r.events[0]) o.note(o.c.dim(`(earlier events: homerun threads show ${shortId(thread_id)} --before ${r.events[0].seq})`));
  const render = new EventRenderer(o, { role: x.role, transcript: true });
  for (const e of r.events) render.render(e);
  render.finish();
  if (!r.events.length) o.note("no events");
  return EXIT.OK;
}

// ---------------------------------------------------------------- runs

function parseStates(v: unknown): RunState[] | undefined {
  if (typeof v !== "string") return undefined;
  const states = v.split(",").map((s) => s.trim()).filter(Boolean);
  const all = [...states.flatMap((s) => (s === "active" ? [...ACTIVE_RUN_STATES] : [s]))];
  for (const s of all) if (!RunState.safeParse(s).success) throw usageError(`unknown run state "${s}"`, `states: ${RunState.options.join(", ")}, active`);
  return all.length ? [...new Set(all)] as RunState[] : undefined;
}

export async function runsList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const limit = intOption(values, "limit", { min: 1, max: 500 }) ?? 20;
  const thread_id = values.thread ? await resolveThread(c, values.thread as string) : undefined;
  const task_id = values.task ? await resolveTask(c, values.task as string) : undefined;
  const states = parseStates(values.state);
  const r = await c.call("runs.list", { limit, ...(thread_id ? { thread_id } : {}), ...(task_id ? { task_id } : {}), ...(states ? { states } : {}) });
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.runs.length) {
    o.note("no runs");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["RUN", "STATE", "TRIGGER", "THREAD", "STARTED", "COST"].map((h) => k.dim(h))];
  for (const run of r.runs) rows.push([shortId(run.run_id), stateColor(x, run.state), run.trigger, shortId(run.thread_id), run.started_at ? ago(run.started_at, now) : "", usd(run.cost_usd)]);
  o.out(table(rows));
  return EXIT.OK;
}

function stateColor(x: Ctx, s: RunState): string {
  const k = x.o.c;
  if (s === "succeeded") return k.green(s);
  if (s === "failed" || s === "abandoned") return k.red(s);
  if (s === "waiting_input" || s === "cancelled") return k.yellow(s);
  return k.cyan(s);
}

export async function runsShow(x: Ctx): Promise<number> {
  const { c, o } = x;
  const run_id = await resolveRun(c, x.positionals[0]!);
  const r = await c.call("runs.get", { run_id });
  if (o.json) return o.value(r), EXIT.OK;
  printRun(x, r.run);
  return EXIT.OK;
}

function printRun(x: Ctx, run: Run): void {
  const { o } = x;
  const k = o.c;
  const when = (t: number | null) => (t === null ? "" : `${new Date(t).toISOString()} (${ago(t)})`);
  const rows: [string, string][] = [
    ["run", run.run_id],
    ["state", stateColor(x, run.state)],
    ["thread", run.thread_id],
    ["task", run.task_id ? `${run.task_id} v${run.task_version}` : ""],
    ["trigger", run.trigger + (run.attempt ? ` (attempt ${run.attempt + 1})` : "")],
    ["slot", when(run.scheduled_for)],
    ["authority", run.authority],
    ["started", when(run.started_at)],
    ["ended", when(run.ended_at)],
    ["outcome", run.outcome ?? ""],
    ["error", run.error ? `${run.error.code}: ${run.error.message}` : ""],
    ["cost", usd(run.cost_usd)],
  ];
  for (const [key, v] of rows) if (v) o.line(`${k.dim(key.padEnd(10))}${v}`);
  // A monitor's check result is its evidence (§8.3): what it saw, and whether that was a change.
  const check = run.check_result;
  if (check) {
    o.line(`${k.dim("check".padEnd(10))}${check.changed ? k.cyan("changed") : "no change"}`);
    for (const line of check.evidence.split("\n")) o.line(`${" ".repeat(10)}${line}`);
  }
}

/** Stop a run by id, or the active run on a thread. */
export async function stop(x: Ctx): Promise<number> {
  const { c, o } = x;
  const arg = x.positionals[0]!;
  let run_id: string;
  if (isFullId(arg)) {
    run_id = arg.toLowerCase();
    try {
      await c.call("runs.get", { run_id });
    } catch (e) {
      if (!(e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND)) throw e;
      run_id = await activeRunOf(x, run_id);
    }
  } else {
    const { runs } = await c.call("runs.list", { limit: 500 });
    const threads = await allThreadIds(c);
    const a = arg.toLowerCase();
    const runHit = runs.some((r) => r.run_id.startsWith(a));
    const threadHit = threads.some((t) => t.startsWith(a));
    if (runHit && threadHit) throw usageError(`"${arg}" matches both a run and a thread; give more characters`);
    run_id = threadHit ? await activeRunOf(x, matchPrefix("thread", arg, threads)) : matchPrefix("run", arg, runs.map((r) => r.run_id));
  }
  const r = await c.call("runs.stop", { run_id });
  if (o.json) o.value({ run_id, ...r });
  else o.note(`stop requested for run ${shortId(run_id)}; it is now ${r.state}`);
  return EXIT.OK;
}

async function activeRunOf(x: Ctx, thread_id: string): Promise<string> {
  const { runs } = await x.c.call("runs.list", { thread_id, states: [...ACTIVE_RUN_STATES], limit: 1 });
  const run = runs[0];
  if (!run) throw new CliError(`thread ${shortId(thread_id)} has no active run`, EXIT.ERROR);
  return run.run_id;
}

// ---------------------------------------------------------------- tasks

export async function tasksList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  let kind: TaskKind | undefined;
  if (values.kind !== undefined) {
    const k = TaskKind.safeParse(values.kind);
    if (!k.success) throw usageError(`--kind must be ${TaskKind.options.join(" or ")}`);
    kind = k.data;
  }
  const r = await c.call("tasks.list", { ...(kind ? { kind } : {}), ...(values.archived ? { include_archived: true } : {}) });
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.tasks.length) {
    o.note("no tasks");
    return EXIT.OK;
  }
  const k = o.c;
  const rows = [["TASK", "KIND", "VERSION", "NAME"].map((h) => k.dim(h))];
  for (const t of r.tasks) rows.push([shortId(t.task_id), t.kind, `v${t.version}`, t.name + (t.archived_at ? k.dim(" (archived)") : "")]);
  o.out(table(rows));
  return EXIT.OK;
}

export async function tasksShow(x: Ctx): Promise<number> {
  const { c, o } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const r = await c.call("tasks.get", { task_id });
  if (o.json) return o.value(r), EXIT.OK;
  const t = r.task;
  const k = o.c;
  o.line(`${k.bold(t.name)} ${k.dim(`· ${t.kind} task · v${t.version}${t.archived_at ? " · archived" : ""}`)}`);
  o.line(k.dim(t.task_id));
  o.line(JSON.stringify(t.spec, null, 2));
  return EXIT.OK;
}

export async function tasksCreate(x: Ctx): Promise<number> {
  const { c, o } = x;
  const spec = await readSpec(x);
  const r = await c.call("tasks.create", { spec });
  if (o.json) return o.value(r), EXIT.OK;
  o.line(r.task.task_id);
  o.note(`created ${r.task.kind} task "${r.task.name}"; its thread is ${shortId(r.thread_id)}`);
  return EXIT.OK;
}

// ---------------------------------------------------------------- input

/** Where a request can be answered from this CLI's role (INPUT_ANSWER_RIGHTS). */
function answerableFrom(req: InputRequest, role: CallerRole): string {
  return cliAnswers(req.prompt, role) ? "app, cli" : "app";
}

export async function inputList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const thread_id = values.thread ? await resolveThread(c, values.thread as string) : undefined;
  const r = await c.call("input.list_pending", thread_id ? { thread_id } : {});
  if (o.json) return o.value(r), EXIT.OK;
  if (!r.requests.length) {
    o.note("no pending input");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["REQUEST", "RUN", "ASKED", "ANSWER IN", "WHAT"].map((h) => k.dim(h))];
  for (const req of r.requests) rows.push([shortId(req.request_id), shortId(req.run_id), ago(req.requested_at, now), answerableFrom(req, x.role), truncate(promptLines(req.prompt)[0] ?? "", 80)]);
  o.out(table(rows));
  if (r.requests.some((req) => cliAnswers(req.prompt, x.role))) o.note(k.dim('Answer "Did this happen?" with: homerun answer REQUEST --completed | --not-run'));
  if (r.requests.some((req) => !cliAnswers(req.prompt, x.role))) o.note(k.dim("Answer the others in the Homerun app."));
  return EXIT.OK;
}

/**
 * `answer REQUEST --completed | --not-run`: the user's answer to "Did this happen?" (§5.4). The
 * runtime checks authority: only the development CLI (cli_dev) may give it.
 */
export async function answer(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const completed = values.completed === true;
  const notRun = values["not-run"] === true;
  if (completed === notRun) throw usageError("give exactly one of --completed or --not-run", "usage: homerun answer REQUEST (--completed | --not-run)");
  const arg = x.positionals[0]!;
  const { requests } = await c.call("input.list_pending", {});
  const request_id = matchPrefix("pending request", arg, requests.map((r) => r.request_id));
  const req = requests.find((r) => r.request_id === request_id);
  if (req && req.prompt.type !== "ambiguous_tool_call") throw new CliError("The CLI answers only \"Did this happen?\" so far; answer this one in the Homerun app.", EXIT.ERROR);
  const outcome = completed ? "completed" : "not_run";
  let r;
  try {
    r = await c.call("input.answer", { request_id: request_id as never, response: { type: "ambiguous_tool_call", outcome }, via: "app" });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND) throw new CliError(`no input request ${shortId(request_id)}`, EXIT.ERROR);
    if (e instanceof RpcCallError && e.code === RPC_ERROR.AUTHORITY_INSUFFICIENT) throw new CliError(`${e.message}: answer it in the Homerun app`, EXIT.NOPERM);
    throw e;
  }
  if (o.json) o.value(r);
  if (r.status === "applied") {
    if (!o.json) o.note(outcome === "completed" ? "Recorded: the call completed. The run resumes and will not run it again." : "Recorded: the call did not run. The run resumes and may run it again.");
    return EXIT.OK;
  }
  if (!o.json) o.note(`Already ${r.state}${r.answered_by ? ` by device ${shortId(r.answered_by)}` : ""}; this answer was not used.`);
  return EXIT.ERROR;
}

// ---------------------------------------------------------------- blobs

const PAGE = 1024 * 1024;

export async function blob(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const sha256 = x.positionals[0]!.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw usageError("give the blob's full sha256 (64 hex characters)");
  const file = values.output as string | undefined;
  let fd: number | null = null;
  try {
    for (let offset = 0; ; ) {
      const page = await c.call("blobs.get", { sha256, offset, length: PAGE });
      const bytes = Buffer.from(page.data, "base64");
      if (file && fd === null) fd = openSync(file, "w", 0o600);
      if (fd !== null) writeSync(fd, bytes);
      else o.out(bytes);
      offset += bytes.length;
      if (page.eof || !bytes.length) break;
    }
    if (file && fd === null) fd = openSync(file, "w", 0o600);
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND) throw new CliError(`no blob ${shortId(sha256)}: unknown, or deleted by retention`, EXIT.ERROR);
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return EXIT.OK;
}
