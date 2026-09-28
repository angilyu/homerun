#!/usr/bin/env bun
/**
 * homerun: the Homerun CLI (docs/design.md §16 milestone 3). Drives homerund over its local
 * socket (§5.2) with no UI.
 *
 * A development build (running from source, or compiled with
 * `--define HOMERUN_CLI_BUILD='"development"'`) authenticates as `cli_dev` with the development
 * token homerund writes at each start. A release build (any other compiled binary) has no
 * credential until the desktop app can approve it (M7): it runs `version` and `help`, refuses
 * everything that needs the runtime with exit 77, and refuses the development switches with
 * exit 64 before any socket I/O.
 */
import { PROTOCOL_VERSION, type BuildChannel, type CallerRole } from "@homerun/core";
import { helpText, parse, type Parsed } from "./args";
import { BUILD_CHANNEL, CLI_VERSION } from "./build";
import * as records from "./commands/records";
import * as streaming from "./commands/stream";
import { connect, refuseDevSwitches, releaseRefusal, resolveTarget, toCliError } from "./connect";
import type { Ctx, Io } from "./context";
import { CliError, EXIT } from "./exit";
import { Output, colorWanted } from "./output";

type Handler = (x: Ctx, socketPath: string) => Promise<number>;

const HANDLERS: Record<string, Handler> = {
  status: records.status,
  chat: streaming.chat,
  send: streaming.send,
  watch: streaming.watch,
  "threads list": records.threadsList,
  "threads new": records.threadsNew,
  "threads show": records.threadsShow,
  "runs list": records.runsList,
  "runs show": records.runsShow,
  stop: records.stop,
  "tasks list": records.tasksList,
  "tasks show": records.tasksShow,
  "tasks create": records.tasksCreate,
  "input list": records.inputList,
  blob: records.blob,
};

export const roleFor = (channel: BuildChannel): CallerRole => (channel === "development" ? "cli_dev" : "cli");

export async function main(io: Io): Promise<number> {
  const early = new Output(io.stdout, io.stderr, false, colorWanted(io.env, io.argv.includes("--no-color")));
  const fail = (o: Output, e: unknown) => {
    const err = toCliError(e);
    o.note(`${o.ce.red("homerun:")} ${err.message}`);
    if (err.hint) o.note(o.ce.dim(`  ${err.hint}`));
    return err.code;
  };
  let parsed: Parsed;
  try {
    parsed = parse(io.argv);
  } catch (e) {
    return fail(early, e);
  }
  const { command, values, positionals } = parsed;
  const o = new Output(io.stdout, io.stderr, !!values.json, colorWanted(io.env, !!values["no-color"]));
  try {
    refuseDevSwitches(io.channel, values, io.env);
    if (command.name === "help") {
      o.out(helpText(positionals.join(" ") || undefined));
      return EXIT.OK;
    }
    if (command.name === "version") {
      if (o.json) o.value({ version: CLI_VERSION, build: io.channel, protocol: PROTOCOL_VERSION });
      else o.line(`homerun ${CLI_VERSION} (${io.channel})`);
      return EXIT.OK;
    }
    if (command.name === "chat" && values.title !== undefined && positionals.length) throw new CliError("--title applies to a new chat", EXIT.USAGE);
    const handler = HANDLERS[command.name];
    if (!handler) throw new CliError(`no handler for ${command.name}`);
    // A release build has no credential yet. It never reads the development token.
    if (io.channel !== "development") throw releaseRefusal();
    const target = resolveTarget(values, io.env);
    const c = await connect(io.channel, target);
    try {
      return await handler({ io, o, c, values, positionals, role: roleFor(io.channel) }, target.socketPath);
    } finally {
      c.close();
    }
  } catch (e) {
    return fail(o, e);
  }
}

if (import.meta.main) {
  const interrupts = new Set<() => void>();
  process.on("SIGINT", () => {
    if (!interrupts.size) process.exit(EXIT.INTERRUPTED);
    for (const fn of [...interrupts]) fn();
  });
  // A closed pipe (`homerun … | head`) is not an error.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(EXIT.OK);
  });
  const code = await main({
    argv: process.argv.slice(2),
    env: process.env,
    channel: BUILD_CHANNEL,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    onInterrupt(fn) {
      interrupts.add(fn);
      return () => interrupts.delete(fn);
    },
  });
  await new Promise<void>((r) => process.stdout.write("", () => r()));
  process.exit(code);
}
