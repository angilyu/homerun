import { HeldMessages, mayAnswer, type CallerRole, type InputPrompt, type ThreadEvent, type ThreadEventOf, type UnknownThreadEvent } from "@homerun/core";
import { bytes, contentText, headLines, inputSummary, oneLine, shortId, truncate, usd } from "./format";
import type { Colors, Output } from "./output";

export interface RenderOptions {
  /** The caller's role, for "where can this be answered". */
  role: CallerRole;
  /**
   * Label messages with who wrote them and show every event on stdout (history and watch).
   * Otherwise (send, chat) the assistant's text alone goes to stdout, so it can be piped, and
   * everything else goes to stderr.
   */
  transcript: boolean;
  /** `client_msg_id`s this process sent: not echoed back. */
  own?: Set<string>;
}

const TOOL_RESULT_LINES = 3;

/** Human rendering of thread events, streamed or from history. */
export class EventRenderer {
  /** Text already printed from deltas, by message id. */
  private printed = new Map<string, string>();
  /** The message whose text is on the current stdout line, unfinished. */
  private open: string | null = null;
  private lastStatus = "";
  /** Messages held while a run waited for input, to report the ones it never delivered. */
  private held = new HeldMessages();

  constructor(
    private readonly o: Output,
    private readonly opts: RenderOptions,
  ) {}

  private get pc(): Colors {
    return this.opts.transcript ? this.o.c : this.o.ce;
  }

  /** A progress line: stdout in a transcript, else stderr. Finishes an open message line first. */
  private progress(s: string): void {
    this.close();
    if (this.opts.transcript) this.o.line(s);
    else this.o.note(s);
  }

  private close(): void {
    if (this.open === null) return;
    this.o.out("\n");
    this.open = null;
  }

  /** A held message the run ended without delivering (§5.7): never sent on its own, so offer a resend. */
  private notDelivered(m: ThreadEventOf<"user.message">): void {
    const c = this.pc;
    this.progress(c.yellow(`  ✗ not delivered: `) + truncate(oneLine(m.payload.text), 80) + c.dim(" (sent while the run waited; the run ended first)"));
    this.progress(c.dim(`    resend it: ${resendCommand(m.thread_id, m.payload.text)}`));
  }

  /** Finish any open message line (on exit or detach). */
  finish(): void {
    this.close();
  }

  render(e: ThreadEvent | UnknownThreadEvent): void {
    const c = this.pc;
    const undelivered = this.held.observe(e);
    switch (e.type) {
      case "message.delta": {
        const id = e.payload.message_id;
        if (this.open !== id) {
          this.close();
          if (this.opts.transcript) this.o.out(this.o.c.bold(this.o.c.green("claude› ")));
          this.open = id;
        }
        this.o.out(e.payload.text);
        this.printed.set(id, (this.printed.get(id) ?? "") + e.payload.text);
        return;
      }
      case "message.final": {
        const p = e.payload;
        if (p.parent_tool_call_id) {
          for (const l of headLines(p.text, TOOL_RESULT_LINES).lines) this.progress(c.dim(`    ↳ ${l}`));
          return;
        }
        const already = this.printed.get(p.message_id) ?? "";
        this.printed.delete(p.message_id);
        if (already && this.open === p.message_id && p.text.startsWith(already)) {
          this.o.out(p.text.slice(already.length));
        } else {
          this.close();
          if (this.opts.transcript) this.o.out(this.o.c.bold(this.o.c.green("claude› ")));
          this.o.out(p.text);
        }
        this.open = p.text.endsWith("\n") ? null : p.message_id;
        this.close();
        return;
      }
      case "user.message": {
        if (this.opts.own?.has(e.payload.client_msg_id)) return;
        const how = e.payload.disposition === "started_run" ? "" : c.dim(` (${e.payload.disposition === "steered" ? "steered the run" : "held for the answer"})`);
        const who = `you${e.payload.origin.surface === "cli" ? "" : ` · ${e.payload.origin.surface}`}`;
        if (this.opts.transcript) {
          this.close();
          this.o.line(`${this.o.c.bold(this.o.c.cyan(`${who}› `))}${e.payload.text}${how}`);
        } else this.progress(c.cyan(`${who}› `) + e.payload.text + how);
        return;
      }
      case "tool.call": {
        const p = e.payload;
        const tag =
          p.policy === "denied" ? c.red(" denied") : p.policy === "needs_approval" ? c.yellow(" needs approval") : p.policy === "granted" ? c.dim(" granted") : "";
        const server = p.mcp_server ? c.dim(`${p.mcp_server}/`) : "";
        this.progress(`  ${c.cyan("▸")} ${server}${c.bold(p.tool)} ${inputSummary(p.input)}${c.dim(` (${p.class})`)}${tag}`);
        return;
      }
      case "tool.result": {
        const p = e.payload;
        const ms = p.duration_ms !== undefined ? c.dim(` ${p.duration_ms} ms`) : "";
        if (p.status === "ok" || p.status === "resolved_completed") {
          this.progress(`    ${c.green("✓")}${ms}`);
        } else {
          const label = p.status === "error" ? "error" : p.status.replaceAll("_", " ");
          this.progress(`    ${c.red("✗")} ${label}${p.error ? `: ${p.error.split("\n")[0]}` : ""}${ms}`);
        }
        if (p.output) {
          const { lines, more } = headLines(contentText(p.output), TOOL_RESULT_LINES);
          for (const l of lines) this.progress(c.dim(`      ${l}`));
          if (p.output.kind === "blob") {
            this.progress(
              c.dim(`      … ${bytes(p.output.size)} in all` + (p.output.expired ? " (expired)" : `: homerun blob ${p.output.sha256}`)),
            );
          } else if (more) this.progress(c.dim(`      … ${more} more line${more === 1 ? "" : "s"}`));
        }
        return;
      }
      case "input.requested":
        this.progress(c.yellow(c.bold("? Needs your input")) + c.dim(` (request ${shortId(e.payload.request_id)})`));
        for (const l of promptLines(e.payload.prompt)) this.progress(`  ${l}`);
        this.progress(c.dim(`  ${answerHint(e.payload.prompt, this.opts.role, e.payload.request_id)}`));
        return;
      case "input.resolved": {
        const p = e.payload;
        this.progress(c.dim(p.state === "answered" ? `  ✓ answered${p.surface ? ` on ${p.surface}` : ""}` : `  input request ${p.state}`));
        return;
      }
      case "run.started":
        if (this.opts.transcript) this.progress(c.dim(`— run ${shortId(e.run_id ?? "")} started (${e.payload.trigger})`));
        return;
      case "run.resumed":
        this.progress(c.dim(`— resumed (${e.payload.reason.replaceAll("_", " ")})`));
        return;
      case "run.cancelled":
        this.progress(c.yellow(`— stopping (${e.payload.reason === "user" ? "requested" : e.payload.reason.replaceAll("_", " ")})`));
        return;
      case "run.end": {
        const p = e.payload;
        const cost = p.cost_usd !== null ? c.dim(` · ${usd(p.cost_usd)}`) : "";
        if (p.state === "succeeded") this.progress(c.dim(`— done${p.outcome ? ` (${p.outcome.replace("_", " ")})` : ""}`) + cost);
        else if (p.state === "cancelled") this.progress(c.yellow("— cancelled") + cost);
        else this.progress(c.red(`— ${p.state}${p.error ? `: ${p.error.message}` : ""}`) + cost);
        for (const m of undelivered) this.notDelivered(m);
        this.lastStatus = "";
        return;
      }
      case "run.status": {
        const p = e.payload;
        if (p.detail === "running" || p.detail === "waiting_input") return;
        const s =
          p.detail === "queued"
            ? `queued${p.queue_position ? ` (${p.queue_position} ahead)` : ""}`
            : p.detail === "retrying_model"
              ? "waiting for Claude, retrying"
              : p.detail === "rate_limited"
                ? "rate limited, retrying"
                : "stopping";
        if (s === this.lastStatus) return;
        this.lastStatus = s;
        this.progress(c.dim(`… ${s}`));
        return;
      }
      case "schedule.missed":
        this.progress(c.dim(`— missed ${e.payload.count} scheduled run${e.payload.count === 1 ? "" : "s"} (${e.payload.reason.replaceAll("_", " ")})`));
        return;
      case "unknown":
        this.progress(c.dim(`(a ${e.original_type} event this CLI does not know)`));
        return;
    }
  }
}

/** A command that resends `text` to the thread; the text itself when it is short enough to copy. */
export function resendCommand(threadId: string, text: string): string {
  const short = !text.includes("\n") && [...text].length <= 200;
  if (!short) return `homerun send ${shortId(threadId)} TEXT`;
  return `homerun send ${shortId(threadId)} ${text.startsWith("-") ? "-- " : ""}'${text.replaceAll("'", `'\\''`)}'`;
}

export function promptLines(p: InputPrompt): string[] {
  switch (p.type) {
    case "approval":
      return [`Allow ${p.tool} (${p.class})? ${inputSummary(p.input)}`, `reason: ${p.reason.replaceAll("_", " ")}`];
    case "ambiguous_tool_call":
      return [`Did this ${p.tool} call happen before homerund stopped? ${inputSummary(p.input)}`];
    case "question":
      return p.questions.flatMap((q) => [
        (q.header ? `[${q.header}] ` : "") + q.question,
        ...q.options.map((o, i) => `  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
      ]);
  }
}

/** Whether this CLI can answer the prompt: "Did this happen?" in a development build (INPUT_ANSWER_RIGHTS). */
export function cliAnswers(p: InputPrompt, role: CallerRole): boolean {
  return p.type === "ambiguous_tool_call" && mayAnswer(role, p.type);
}

/** Where a prompt can be answered from (INPUT_ANSWER_RIGHTS). */
export function answerHint(p: InputPrompt, role: CallerRole, requestId: string): string {
  if (cliAnswers(p, role)) return `Answer it in the Homerun app, or here: homerun answer ${shortId(requestId)} --completed | --not-run`;
  if (!mayAnswer(role, p.type)) return "Answer it in the Homerun app; the CLI may not answer this kind of request.";
  return "Answer it in the Homerun app. Answering from the CLI arrives in a later version.";
}
