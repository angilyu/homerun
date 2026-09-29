import { RpcCallError, type RpcClient } from "@homerun/client";
import {
  GrantProposal,
  mayAnswer,
  RPC_ERROR,
  type ApprovalPrompt,
  type CallerRole,
  type InputPrompt,
  type InputRequest,
  type InputResponse,
  type QuestionPrompt,
} from "@homerun/core";
import type { Ctx } from "../context";
import { CliError, EXIT, usageError } from "../exit";
import { ago, shortId, table, truncate } from "../format";
import { isFullId, matchPrefix, resolveTask, resolveThread } from "../ids";
import { answerCommand, promptLines } from "../render";

/**
 * Approvals, questions and "Did this happen?" from the terminal (design §5.6, §16 row 6). The
 * runtime decides who may answer (`INPUT_ANSWER_RIGHTS`, `checkResponse`); the CLI checks the
 * same rules first so a mistake is a usage error, not a round trip. First answer wins: a request
 * someone else answered exits 1 and says who.
 */

// ---------------------------------------------------------------- requests

/** Where a request can be answered from this CLI's role. */
function answerableFrom(req: InputRequest, role: CallerRole): string {
  return mayAnswer(role, req.prompt.type) ? "app, cli" : "app";
}

export async function requests(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const thread_id = values.thread ? await resolveThread(c, values.thread as string) : undefined;
  let { requests: reqs } = await c.call("input.list_pending", thread_id ? { thread_id } : {});
  if (values.run) {
    const arg = values.run as string;
    const run = isFullId(arg) ? arg.toLowerCase() : matchPrefix("run with pending input", arg, reqs.map((r) => r.run_id));
    reqs = reqs.filter((r) => r.run_id === run);
  }
  if (o.json) return o.value({ requests: reqs }), EXIT.OK;
  if (!reqs.length) {
    o.note("no pending input");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["REQUEST", "RUN", "ASKED", "ANSWER IN", "WHAT"].map((h) => k.dim(h))];
  for (const req of reqs) rows.push([shortId(req.request_id), shortId(req.run_id), ago(req.requested_at, now), answerableFrom(req, x.role), truncate(promptLines(req.prompt)[0] ?? "", 80)]);
  o.out(table(rows));
  const kinds = new Set(reqs.filter((r) => mayAnswer(x.role, r.prompt.type)).map((r) => r.prompt.type));
  if (kinds.has("approval")) o.note(k.dim("Approve with: homerun approve REQUEST [--always] · deny with: homerun deny REQUEST"));
  if (kinds.has("question")) o.note(k.dim("Answer a question with: homerun answer REQUEST --choice LABEL"));
  if (kinds.has("ambiguous_tool_call")) o.note(k.dim('Answer "Did this happen?" with: homerun answer REQUEST --completed | --not-run'));
  if (reqs.some((r) => !mayAnswer(x.role, r.prompt.type))) o.note(k.dim("Answer the others in the Homerun app."));
  return EXIT.OK;
}

/** The pending request an argument names, or just its id when it is a full id no longer pending. */
async function findRequest(c: RpcClient, arg: string): Promise<{ request_id: string; req: InputRequest | undefined }> {
  const { requests: reqs } = await c.call("input.list_pending", {});
  const request_id = matchPrefix("pending request", arg, reqs.map((r) => r.request_id));
  return { request_id, req: reqs.find((r) => r.request_id === request_id) };
}

function wrongKind(req: InputRequest | undefined, want: InputPrompt["type"]): void {
  if (!req || req.prompt.type === want) return;
  throw usageError(`request ${shortId(req.request_id)} is ${kindName(req.prompt.type)}`, `answer it with: ${answerCommand(req.prompt, req.request_id)}`);
}

const kindName = (t: InputPrompt["type"]) => (t === "approval" ? "an approval" : t === "question" ? "a question" : '"Did this happen?"');

/** Send the answer. Exit 0 when it was applied; 1 when someone answered first. */
async function submit(x: Ctx, request_id: string, response: InputResponse, applied: string): Promise<number> {
  const { c, o } = x;
  let r;
  try {
    r = await c.call("input.answer", { request_id: request_id as never, response, via: "app" });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND) throw new CliError(`no input request ${shortId(request_id)}`, EXIT.ERROR);
    if (e instanceof RpcCallError && e.code === RPC_ERROR.AUTHORITY_INSUFFICIENT) throw new CliError(`${e.message}: answer it in the Homerun app`, EXIT.NOPERM);
    throw e;
  }
  if (o.json) o.value(r);
  if (r.status === "applied") {
    if (!o.json) o.note(applied);
    return EXIT.OK;
  }
  if (!o.json) o.note(`Already ${r.state}${r.answered_by ? ` by device ${shortId(r.answered_by)}` : ""}; this answer was not used.`);
  return EXIT.ERROR;
}

// ---------------------------------------------------------------- approve, deny

/** The grant an "Always allow" answer confirms: the runtime's suggestion, with the user's edits. */
export function alwaysGrant(p: ApprovalPrompt, edits: { pattern?: string; class?: string }): GrantProposal {
  if (!p.offer_always || !p.suggested_grant) throw new CliError("Always allow is not offered for this request: approve it once, or deny it", EXIT.ERROR);
  const g = GrantProposal.safeParse({
    tool: p.suggested_grant.tool,
    pattern: edits.pattern ?? p.suggested_grant.pattern,
    class: edits.class ?? p.suggested_grant.class,
  });
  if (!g.success) throw usageError(`not a valid grant: ${g.error.issues.map((i) => i.message).join("; ")}`);
  return g.data;
}

export async function approve(x: Ctx): Promise<number> {
  const { c, values } = x;
  const always = values.always === true;
  if (!always && (values.pattern !== undefined || values.class !== undefined)) throw usageError("--pattern and --class go with --always");
  const { request_id, req } = await findRequest(c, x.positionals[0]!);
  wrongKind(req, "approval");
  const prompt = req?.prompt as ApprovalPrompt | undefined;
  if (always && !prompt) throw new CliError(`request ${shortId(request_id)} is not pending`, EXIT.ERROR);
  const response: InputResponse = always
    ? { type: "approval", decision: "allow_always", grant: alwaysGrant(prompt!, { pattern: values.pattern as string | undefined, class: values.class as string | undefined }) }
    : { type: "approval", decision: "allow" };
  const what = prompt ? `${prompt.tool} call` : "call";
  const note =
    response.decision === "allow_always"
      ? `Allowed. ${response.grant!.tool}${response.grant!.pattern ? ` "${response.grant!.pattern}"` : ""} is granted as ${response.grant!.class} for this task from now on (homerun grants list).`
      : `Allowed this ${what}. The run continues.`;
  return submit(x, request_id, response, note);
}

export async function deny(x: Ctx): Promise<number> {
  const { request_id, req } = await findRequest(x.c, x.positionals[0]!);
  wrongKind(req, "approval");
  return submit(x, request_id, { type: "approval", decision: "deny" }, "Denied. The agent is told you declined, and the run continues without it.");
}

// ---------------------------------------------------------------- answer

/** `[N=]VALUE`: the 1-based question it answers, and the value. */
function numbered(raw: string, count: number): { q: number; value: string } {
  const m = /^(\d+)=(.*)$/s.exec(raw);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= count) return { q: Number(m[1]) - 1, value: m[2]! };
  if (count > 1) throw usageError(`"${raw}": there are ${count} questions; say which, as N=${raw}`);
  return { q: 0, value: raw };
}

/** An option by its label (exact, then any case), or by its 1-based number. */
function option(q: QuestionPrompt["questions"][number], value: string): string {
  const exact = q.options.find((o) => o.label === value);
  if (exact) return exact.label;
  const loose = q.options.filter((o) => o.label.toLowerCase() === value.trim().toLowerCase());
  if (loose.length === 1) return loose[0]!.label;
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (n >= 1 && n <= q.options.length) return q.options[n - 1]!.label;
  throw usageError(`"${value}" is not an option of "${truncate(q.question, 60)}"`, `options: ${q.options.map((o, i) => `${i + 1}. ${o.label}`).join(" · ")}`);
}

/** The response to a question from `--choice` and `--text` values (§5.6: one answer per question). */
export function questionResponse(p: QuestionPrompt, choices: readonly string[], texts: readonly string[]): InputResponse {
  const n = p.questions.length;
  const answers = p.questions.map(() => ({ selected: [] as string[], text: undefined as string | undefined }));
  for (const raw of choices) {
    const { q, value } = numbered(raw, n);
    const label = option(p.questions[q]!, value);
    if (!answers[q]!.selected.includes(label)) answers[q]!.selected.push(label);
  }
  for (const raw of texts) {
    const { q, value } = numbered(raw, n);
    if (!p.questions[q]!.allow_freeform) throw usageError(`question ${q + 1} takes one of its options, not text`);
    if (!value.trim()) throw usageError(`the text for question ${q + 1} is empty`);
    answers[q]!.text = answers[q]!.text === undefined ? value : `${answers[q]!.text}\n${value}`;
  }
  answers.forEach((a, i) => {
    const q = p.questions[i]!;
    if (!a.selected.length && a.text === undefined) throw usageError(n > 1 ? `question ${i + 1} has no answer` : "choose an option", `"${truncate(q.question, 80)}": ${q.options.map((o, j) => `${j + 1}. ${o.label}`).join(" · ")}`);
    if (!q.multi_select && a.selected.length > 1) throw usageError(`question ${i + 1} takes one choice`);
  });
  return { type: "question", answers: answers.map((a) => (a.text === undefined ? { selected: a.selected } : { selected: a.selected, text: a.text })) };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : typeof v === "string" ? [v] : []);

/**
 * `answer REQUEST --choice …` for the agent's question; `answer REQUEST --completed | --not-run`
 * for "Did this happen?" (§5.4), which the development CLI (cli_dev) alone may give.
 */
export async function answer(x: Ctx): Promise<number> {
  const { c, values } = x;
  const choices = list(values.choice);
  const texts = list(values.text);
  const completed = values.completed === true;
  const notRun = values["not-run"] === true;
  const asQuestion = choices.length > 0 || texts.length > 0;
  if (asQuestion && (completed || notRun)) throw usageError("--choice and --text answer a question; --completed and --not-run answer \"Did this happen?\"");
  if (completed && notRun) throw usageError("give exactly one of --completed or --not-run", "usage: homerun answer REQUEST (--completed | --not-run)");
  const { request_id, req } = await findRequest(c, x.positionals[0]!);
  if (!asQuestion && !completed && !notRun) {
    if (req?.prompt.type === "question") {
      for (const l of promptLines(req.prompt)) x.o.note(`  ${l}`);
      throw usageError("choose an option", `usage: ${answerCommand(req.prompt, request_id)}`);
    }
    throw usageError("give exactly one of --completed or --not-run", "usage: homerun answer REQUEST (--completed | --not-run)");
  }
  if (asQuestion) {
    wrongKind(req, "question");
    if (!req) throw new CliError(`request ${shortId(request_id)} is not pending`, EXIT.ERROR);
    const response = questionResponse(req.prompt as QuestionPrompt, choices, texts);
    return submit(x, request_id, response, "Answered. The agent has your answer and the run continues.");
  }
  wrongKind(req, "ambiguous_tool_call");
  const outcome = completed ? "completed" : "not_run";
  return submit(
    x,
    request_id,
    { type: "ambiguous_tool_call", outcome },
    outcome === "completed" ? "Recorded: the call completed. The run resumes and will not run it again." : "Recorded: the call did not run. The run resumes and may run it again.",
  );
}

// ---------------------------------------------------------------- inline answers (chat)

/**
 * A line typed in `chat` while the run waits, read as an answer (§5.6): y/n/always for an
 * approval, an option's number or label for a single question, completed/not run for "Did this
 * happen?". Anything else is null: the line is a message, held until the answer.
 */
export function inlineAnswer(p: InputPrompt, line: string): InputResponse | null {
  const t = line.trim().toLowerCase();
  switch (p.type) {
    case "approval":
      if (["y", "yes", "allow", "approve"].includes(t)) return { type: "approval", decision: "allow" };
      if (["n", "no", "deny"].includes(t)) return { type: "approval", decision: "deny" };
      if (["a", "always"].includes(t) && p.offer_always && p.suggested_grant) return { type: "approval", decision: "allow_always", grant: p.suggested_grant };
      return null;
    case "ambiguous_tool_call":
      if (["c", "completed", "it happened", "yes"].includes(t)) return { type: "ambiguous_tool_call", outcome: "completed" };
      if (["n", "not run", "not-run", "no"].includes(t)) return { type: "ambiguous_tool_call", outcome: "not_run" };
      return null;
    case "question": {
      if (p.questions.length !== 1) return null;
      const q = p.questions[0]!;
      const picks = q.multi_select ? line.split(",").map((s) => s.trim()).filter(Boolean) : [line.trim()];
      const labels: string[] = [];
      for (const v of picks) {
        const n = /^\d+$/.test(v) ? Number(v) : NaN;
        const o = q.options.find((x) => x.label.toLowerCase() === v.toLowerCase()) ?? (n >= 1 && n <= q.options.length ? q.options[n - 1] : undefined);
        if (!o) return q.allow_freeform && line.trim() ? { type: "question", answers: [{ selected: [], text: line.trim() }] } : null;
        if (!labels.includes(o.label)) labels.push(o.label);
      }
      return labels.length ? { type: "question", answers: [{ selected: labels }] } : null;
    }
  }
}

/** What to type in `chat` to answer. */
export function inlineHint(p: InputPrompt): string | null {
  switch (p.type) {
    case "approval":
      return `answer here: y (allow) · n (deny)${p.offer_always && p.suggested_grant ? " · always" : ""}`;
    case "ambiguous_tool_call":
      return "answer here: completed · not run";
    case "question":
      return p.questions.length === 1 ? `answer here: an option's number or label${p.questions[0]!.multi_select ? " (several, comma-separated)" : ""}` : null;
  }
}

/** Send an inline answer; returns the line to print. */
export async function sendInline(c: RpcClient, request_id: string, response: InputResponse): Promise<string> {
  try {
    const r = await c.call("input.answer", { request_id: request_id as never, response, via: "app" });
    if (r.status === "applied") return response.type === "approval" && response.decision === "deny" ? "denied" : "answered";
    return `already ${r.state}${r.answered_by ? ` by device ${shortId(r.answered_by)}` : ""}`;
  } catch (e) {
    if (e instanceof RpcCallError) return `not accepted: ${e.message}`;
    throw e;
  }
}

// ---------------------------------------------------------------- grants

export async function grantsList(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  const { grants } = await c.call("grants.list", { task_id: task_id as never, include_revoked: values.all === true });
  if (o.json) return o.value({ grants }), EXIT.OK;
  if (!grants.length) {
    o.note("no grants");
    return EXIT.OK;
  }
  const k = o.c;
  const now = Date.now();
  const rows = [["GRANT", "TOOL", "PATTERN", "CLASS", "GRANTED", "REVOKED"].map((h) => k.dim(h))];
  for (const g of grants) rows.push([shortId(g.grant_id), g.tool, g.pattern ?? k.dim("(any use)"), g.class, ago(g.granted_at, now), g.revoked_at ? ago(g.revoked_at, now) : ""]);
  o.out(table(rows));
  return EXIT.OK;
}

export async function grantsAdd(x: Ctx): Promise<number> {
  const { c, o, values } = x;
  const task_id = await resolveTask(c, x.positionals[0]!);
  if (values.tool === undefined || values.class === undefined) throw usageError("give --tool and --class", "usage: homerun grants add TASK --tool TOOL [--pattern P] --class C");
  const g = GrantProposal.safeParse({ tool: values.tool, pattern: (values.pattern as string | undefined) ?? null, class: values.class });
  if (!g.success) throw usageError(`not a valid grant: ${g.error.issues.map((i) => i.message).join("; ")}`);
  let r;
  try {
    r = await c.call("grants.create", { task_id: task_id as never, grant: g.data });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND) throw new CliError(`no task ${shortId(task_id)}`, EXIT.ERROR);
    throw e;
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.line(r.grant.grant_id);
  o.note(`granted ${r.grant.tool}${r.grant.pattern ? ` "${r.grant.pattern}"` : ""} as ${r.grant.class}`);
  return EXIT.OK;
}

export async function grantsRevoke(x: Ctx): Promise<number> {
  const { c, o } = x;
  const arg = x.positionals[0]!;
  let grant_id = arg.toLowerCase();
  if (!isFullId(arg)) {
    const { tasks } = await c.call("tasks.list", { include_archived: true });
    const ids: string[] = [];
    for (const t of tasks) ids.push(...(await c.call("grants.list", { task_id: t.task_id, include_revoked: false })).grants.map((g) => g.grant_id));
    grant_id = matchPrefix("active grant", arg, ids);
  }
  let r;
  try {
    r = await c.call("grants.revoke", { grant_id: grant_id as never });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.NOT_FOUND) throw new CliError(`no grant ${shortId(grant_id)}`, EXIT.ERROR);
    throw e;
  }
  if (o.json) return o.value(r), EXIT.OK;
  o.note(`revoked grant ${shortId(grant_id)}; the agent asks again from its next call`);
  return EXIT.OK;
}
