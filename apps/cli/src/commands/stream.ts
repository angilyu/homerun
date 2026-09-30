import { createInterface } from "node:readline";
import { mayAnswer, type InputPrompt, type MethodResult, type ThreadEvent, type UnknownThreadEvent } from "@homerun/core";
import { intOption } from "../args";
import { lastSeqOf, readAll, subscribe, type Ctx, type Received, type Subscription } from "../context";
import { CliError, EXIT, usageError } from "../exit";
import { oneLine, shortId, truncate } from "../format";
import { resolveThread } from "../ids";
import { EventRenderer } from "../render";
import { inlineAnswer, inlineHint, sendInline } from "./input";

type AnyEvent = ThreadEvent | UnknownThreadEvent;
const runOf = (e: AnyEvent): string | null => (e.type === "unknown" ? null : e.run_id);

function printer(x: Ctx, own: Set<string>, transcript: boolean) {
  const render = new EventRenderer(x.o, { role: x.role, transcript, own });
  return {
    show(r: Received) {
      if (x.o.json) x.o.value(r.raw);
      else render.render(r.event);
    },
    finish: () => render.finish(),
  };
}

const invalid = (x: Ctx) => (why: string) => x.o.note(x.o.ce.yellow(`homerun: skipped an event homerund sent that does not parse: ${why}`));

function closedError(x: Ctx): CliError {
  // The release role's connection also closes when its token is revoked in the app (§5.2).
  const hint = x.role === "cli" ? "if this tool's access was revoked in the Homerun app, run `homerun login`" : undefined;
  return new CliError("homerund closed the connection while the CLI was following the thread", EXIT.UNAVAILABLE, hint);
}

// ---------------------------------------------------------------- send

export async function send(x: Ctx): Promise<number> {
  const { c, o, values, positionals, io } = x;
  let threadArg: string | undefined;
  let text: string | undefined;
  if (values.new) {
    if (positionals.length > 1) throw usageError(`unexpected argument: ${positionals[1]}`, "with --new, give only the message");
    text = positionals[0];
  } else {
    if (values.title !== undefined) throw usageError("--title goes with --new");
    threadArg = positionals[0];
    text = positionals[1];
    if (!threadArg) throw usageError("give a THREAD, or --new to start one", "usage: homerun send (THREAD | --new) [TEXT | -]");
  }
  if (text === undefined || text === "-") {
    if (text === undefined && io.stdin.isTTY) throw usageError("no message: give TEXT, or - to read it from stdin");
    text = (await readAll(io.stdin)).replace(/\s+$/, "");
  }
  if (!text.trim()) throw usageError("the message is empty");

  const thread_id = threadArg ? await resolveThread(c, threadArg) : (await c.call("threads.create", values.title !== undefined ? { title: values.title as string } : { title: titleFrom(text) })).thread.thread_id;
  if (!threadArg && !o.json) o.note(o.ce.dim(`new thread ${shortId(thread_id)}`));
  const client_msg_id = crypto.randomUUID();

  if (values.detach) {
    const r = await c.call("messages.send", { thread_id, client_msg_id, text });
    if (o.json) o.value(r);
    else o.note(`${dispositionText(r.disposition)} run ${shortId(r.run_id)} on thread ${shortId(thread_id)}. Follow it: homerun watch ${shortId(thread_id)}`);
    return EXIT.OK;
  }
  return follow(x, thread_id, client_msg_id, text);
}

function dispositionText(d: MethodResult<"messages.send">["disposition"]): string {
  return d === "started_run" ? "started" : d === "steered" ? "steered the active" : "held for the waiting";
}

export function titleFrom(text: string): string {
  return truncate(oneLine(text), 80);
}

/** Send, then stream the run it started or steered until it ends, waits for input, or Ctrl-C. */
async function follow(x: Ctx, thread_id: string, client_msg_id: string, text: string): Promise<number> {
  const { c, o, values, io } = x;
  const p = printer(x, new Set([client_msg_id]), false);
  const exit = Promise.withResolvers<number>();
  let runId: string | null = null;
  const early: Received[] = [];
  const handle = (r: Received) => {
    if (runOf(r.event) !== runId) return;
    p.show(r);
    const e = r.event;
    if (e.type === "run.end") exit.resolve(e.payload.state === "succeeded" ? EXIT.OK : EXIT.ERROR);
    else if (e.type === "input.requested") exit.resolve(EXIT.WAITING_INPUT);
  };
  const sub = await subscribe(c, thread_id, await lastSeqOf(c, thread_id), (r) => (runId === null ? early.push(r) : handle(r)), invalid(x));

  let stopping = false;
  const offInterrupt = io.onInterrupt(() => {
    p.finish();
    if (runId === null || stopping) return exit.resolve(EXIT.INTERRUPTED);
    if (values["stop-on-interrupt"]) {
      stopping = true;
      o.note(o.ce.yellow(`stopping run ${shortId(runId)}… (Ctrl-C again to leave it)`));
      void c.call("runs.stop", { run_id: runId }).catch((e) => o.note(`homerun: ${(e as Error).message}`));
      return;
    }
    o.note(o.ce.dim(`detached; the run continues. Follow it: homerun watch ${shortId(thread_id)} · stop it: homerun stop ${shortId(runId)}`));
    exit.resolve(EXIT.INTERRUPTED);
  });
  void c.closed.then(() => exit.reject(closedError(x)));

  try {
    const r = await c.call("messages.send", { thread_id, client_msg_id, text });
    runId = r.run_id;
    if (r.disposition === "steered" && !o.json) o.note(o.ce.dim(`steering the active run ${shortId(r.run_id)}`));
    for (const e of early.splice(0)) handle(e);
    if (r.disposition === "held") {
      if (!o.json) o.note(o.ce.yellow(`run ${shortId(r.run_id)} is waiting for input; your message will be delivered with the answer (homerun input list)`));
      exit.resolve(EXIT.WAITING_INPUT);
    }
    let code = await exit.promise;
    if (stopping && code !== EXIT.INTERRUPTED) code = EXIT.INTERRUPTED;
    return code;
  } finally {
    p.finish();
    offInterrupt();
    await sub.close();
  }
}

// ---------------------------------------------------------------- watch

export async function watch(x: Ctx): Promise<number> {
  const { c, io } = x;
  const thread_id = await resolveThread(c, x.positionals[0]!);
  const n = intOption(x.values, "history", { min: 0, max: 500 }) ?? 10;
  const p = printer(x, new Set(), true);
  let after: number;
  if (n > 0) {
    const h = await c.call("threads.history", { thread_id, limit: n });
    for (const e of h.events) p.show({ event: e, raw: e });
    after = h.events.at(-1)?.seq ?? 0;
  } else after = await lastSeqOf(c, thread_id);
  const exit = Promise.withResolvers<number>();
  const sub = await subscribe(c, thread_id, after, (r) => p.show(r), invalid(x));
  const off = io.onInterrupt(() => exit.resolve(EXIT.INTERRUPTED));
  void c.closed.then(() => exit.reject(closedError(x)));
  try {
    return await exit.promise;
  } finally {
    p.finish();
    off();
    await sub.close();
  }
}

// ---------------------------------------------------------------- chat

/**
 * A conversation on one thread. On a terminal, a line typed while a run is active steers it,
 * Ctrl-C stops the run, and Ctrl-C or Ctrl-D at the prompt leaves. From a pipe, each line is
 * sent after the previous run ends, and the chat ends after the last one; a run that stops for
 * input (or a message held for one) ends it with 75, as `send` does, since nothing can answer.
 * On a terminal, a request this CLI may answer is answered inline (§5.6): the next line is read
 * as the answer when it is one (`inlineAnswer`), and otherwise sent as a message, held until the
 * answer.
 */
export async function chat(x: Ctx): Promise<number> {
  const { c, o, io } = x;
  const tty = !!io.stdin.isTTY;
  const own = new Set<string>();
  const p = printer(x, own, false);
  let thread_id: string | null = x.positionals[0] ? await resolveThread(c, x.positionals[0]) : null;
  let sub: Promise<Subscription> | null = null;
  let active: string | null = null;
  let stopping = false;
  let busy = false;
  const ended = new Set<string>();
  const waiting = new Set<string>();
  const queue: string[] = [];
  let eof = false;
  /** The request the next line may answer. */
  let asking: { request_id: string; run_id: string; prompt: InputPrompt } | null = null;
  const exit = Promise.withResolvers<number>();
  const rl = createInterface({ input: io.stdin, output: tty ? (io.stderr as unknown as NodeJS.WritableStream) : undefined, terminal: tty });
  rl.setPrompt(o.ce.bold(o.ce.cyan("› ")));

  const prompt = () => {
    if (tty && !active) rl.prompt();
  };
  const runEnded = (id: string) => {
    if (id !== active) return;
    active = null;
    stopping = false;
    void pump();
  };
  const onEvent = (r: Received) => {
    p.show(r);
    const e = r.event;
    if (e.type === "run.end" && e.run_id) {
      ended.add(e.run_id);
      runEnded(e.run_id);
    } else if (e.type === "input.requested" && e.run_id) {
      waiting.add(e.run_id);
      waitingInput(e.run_id);
      const hint = inlineHint(e.payload.prompt);
      if (tty && hint && mayAnswer(x.role, e.payload.prompt.type)) {
        asking = { request_id: e.payload.request_id, run_id: e.run_id, prompt: e.payload.prompt };
        o.note(o.ce.dim(`  ${hint}`));
        rl.setPrompt(o.ce.bold(o.ce.yellow("? ")));
        rl.prompt();
      }
    } else if (e.type === "input.resolved" && asking?.request_id === e.payload.request_id) {
      asking = null;
      rl.setPrompt(o.ce.bold(o.ce.cyan("› ")));
    }
  };
  const waitingInput = (id: string) => {
    if (!tty && id === active) exit.resolve(EXIT.WAITING_INPUT);
  };

  const start = async (first?: string): Promise<Subscription> => {
    if (!thread_id) {
      thread_id = (await c.call("threads.create", { title: x.values.title !== undefined ? (x.values.title as string) : titleFrom(first ?? "chat") })).thread.thread_id;
      o.note(o.ce.dim(`new thread ${shortId(thread_id)}`));
    }
    return subscribe(c, thread_id, await lastSeqOf(c, thread_id), onEvent, invalid(x));
  };

  async function sendLine(text: string): Promise<void> {
    await (sub ??= start(text));
    const client_msg_id = crypto.randomUUID();
    own.add(client_msg_id);
    const r = await c.call("messages.send", { thread_id: thread_id!, client_msg_id, text });
    if (r.disposition === "steered") o.note(o.ce.dim(`(steering run ${shortId(r.run_id)})`));
    if (r.disposition === "held") o.note(o.ce.yellow("(the run is waiting for input; your message is delivered with the answer)"));
    active = r.run_id;
    if (ended.has(r.run_id)) runEnded(r.run_id);
    else if (r.disposition === "held" || waiting.has(r.run_id)) waitingInput(r.run_id);
  }

  /** Send queued lines: all of them on a terminal (steering), one per run from a pipe. */
  async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && (tty || !active)) await sendLine(queue.shift()!);
    } catch (e) {
      return exit.reject(e);
    } finally {
      busy = false;
    }
    if (!active && !queue.length) {
      if (eof) return exit.resolve(EXIT.OK);
      prompt();
    }
  }

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return asking ? rl.prompt() : prompt();
    const reply = asking ? inlineAnswer(asking.prompt, text) : null;
    if (asking && reply) {
      const { request_id } = asking;
      void sendInline(c, request_id, reply).then(
        (said) => o.note(o.ce.dim(`  (${said})`)),
        (e) => exit.reject(e),
      );
      return;
    }
    queue.push(text);
    void pump();
  });
  rl.on("close", () => {
    eof = true;
    if (tty) {
      if (active) o.note(o.ce.dim(`\nleaving; run ${shortId(active)} continues (homerun watch ${shortId(thread_id!)})`));
      return exit.resolve(EXIT.OK);
    }
    if (!active && !queue.length && !busy) exit.resolve(EXIT.OK);
  });
  const interrupt = () => {
    if (active && !stopping) {
      stopping = true;
      p.finish();
      o.note(o.ce.yellow(`stopping run ${shortId(active)}… (Ctrl-C again to leave)`));
      void c.call("runs.stop", { run_id: active }).catch((e) => o.note(`homerun: ${(e as Error).message}`));
      return;
    }
    exit.resolve(active ? EXIT.INTERRUPTED : EXIT.OK);
  };
  rl.on("SIGINT", interrupt);
  const off = io.onInterrupt(interrupt);
  void c.closed.then(() => exit.reject(closedError(x)));

  if (thread_id) {
    await (sub ??= start());
    if (tty) o.note(o.ce.dim(`chatting on thread ${shortId(thread_id)}. Ctrl-C stops a run; Ctrl-D leaves.`));
  } else if (tty) o.note(o.ce.dim("new chat. Ctrl-C stops a run; Ctrl-D leaves."));
  prompt();
  try {
    return await exit.promise;
  } finally {
    p.finish();
    off();
    rl.close();
    await (await (sub as Promise<Subscription> | null)?.catch(() => null))?.close();
  }
}
