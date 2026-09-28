import { parseArgs } from "node:util";
import { usageError } from "./exit";

type Opt = { type: "string" | "boolean"; short?: string };
export type Values = Record<string, string | boolean | undefined>;

export interface CommandSpec {
  /** "status", "threads list", … */
  name: string;
  args: string;
  summary: string;
  options: Record<string, Opt>;
  /** Positional arguments after the command words. */
  positionals: [min: number, max: number];
  /** Talks to homerund. The release CLI refuses these (exit 77) until the app can approve it. */
  runtime: boolean;
  /** Accepts --json. */
  json: boolean;
}

export const GLOBAL_OPTIONS: Record<string, Opt> = {
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  /** Development builds only. */
  socket: { type: "string" },
  "dev-token-file": { type: "string" },
};

const LIMIT: Record<string, Opt> = { limit: { type: "string", short: "n" } };

export const COMMANDS: CommandSpec[] = [
  { name: "status", args: "", summary: "Show whether homerund is running, active runs and pending input", options: {}, positionals: [0, 0], runtime: true, json: true },
  {
    name: "chat",
    args: "[THREAD] [--title TITLE]",
    summary: "Chat interactively: a new thread, or continue THREAD",
    options: { title: { type: "string" } },
    positionals: [0, 1],
    runtime: true,
    json: false,
  },
  {
    name: "send",
    args: "(THREAD | --new [--title TITLE]) [TEXT | -] [--detach] [--stop-on-interrupt]",
    summary: "Send a message and stream the run (steers the run if one is active). TEXT or - reads stdin",
    options: { new: { type: "boolean" }, title: { type: "string" }, detach: { type: "boolean", short: "d" }, "stop-on-interrupt": { type: "boolean" } },
    positionals: [0, 2],
    runtime: true,
    json: true,
  },
  {
    name: "watch",
    args: "THREAD [--history N]",
    summary: "Follow a thread live until Ctrl-C, after its last N events (default 10)",
    options: { history: { type: "string" } },
    positionals: [1, 1],
    runtime: true,
    json: true,
  },
  { name: "threads list", args: "[--limit N] [--task TASK]", summary: "Threads, most recently updated first", options: { ...LIMIT, task: { type: "string" } }, positionals: [0, 0], runtime: true, json: true },
  { name: "threads new", args: "[--title TITLE]", summary: "Create a chat thread and print its id", options: { title: { type: "string" } }, positionals: [0, 0], runtime: true, json: true },
  {
    name: "threads show",
    args: "THREAD [--limit N] [--before SEQ]",
    summary: "Print a thread's history (the last N events before SEQ, default 50)",
    options: { ...LIMIT, before: { type: "string" } },
    positionals: [1, 1],
    runtime: true,
    json: true,
  },
  {
    name: "runs list",
    args: "[--thread THREAD] [--task TASK] [--state STATE[,STATE…]] [--limit N]",
    summary: "Runs, newest first",
    options: { ...LIMIT, thread: { type: "string" }, task: { type: "string" }, state: { type: "string" } },
    positionals: [0, 0],
    runtime: true,
    json: true,
  },
  { name: "runs show", args: "RUN", summary: "One run", options: {}, positionals: [1, 1], runtime: true, json: true },
  { name: "stop", args: "RUN | THREAD", summary: "Stop a run, or the active run on a thread", options: {}, positionals: [1, 1], runtime: true, json: true },
  {
    name: "tasks list",
    args: "[--kind session|monitor] [--archived]",
    summary: "Tasks",
    options: { kind: { type: "string" }, archived: { type: "boolean" } },
    positionals: [0, 0],
    runtime: true,
    json: true,
  },
  { name: "tasks show", args: "TASK", summary: "A task and its spec", options: {}, positionals: [1, 1], runtime: true, json: true },
  {
    name: "tasks create",
    args: "--spec FILE|-",
    summary: "Create a task from a TaskSpec JSON file (checked before sending)",
    options: { spec: { type: "string" } },
    positionals: [0, 0],
    runtime: true,
    json: true,
  },
  { name: "input list", args: "[--thread THREAD]", summary: "Unanswered input requests, and where they can be answered", options: { thread: { type: "string" } }, positionals: [0, 0], runtime: true, json: true },
  {
    name: "blob",
    args: "SHA256 [-o FILE]",
    summary: "Write a stored tool input or output to stdout or FILE",
    options: { output: { type: "string", short: "o" } },
    positionals: [1, 1],
    runtime: true,
    json: false,
  },
  { name: "version", args: "", summary: "Print the CLI version and build", options: {}, positionals: [0, 0], runtime: false, json: true },
  { name: "help", args: "[COMMAND]", summary: "Show help", options: {}, positionals: [0, 2], runtime: false, json: false },
];

const GROUPS = new Set(COMMANDS.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]!));

export interface Parsed {
  command: CommandSpec;
  values: Values;
  positionals: string[];
}

/** Every option any command takes, so the first pass knows which options consume a value. */
const ALL_OPTIONS: Record<string, Opt> = Object.assign({}, GLOBAL_OPTIONS, ...COMMANDS.map((c) => c.options));

export function findCommand(words: string[]): { command: CommandSpec; used: number } | null {
  const [a, b] = words;
  if (a === undefined) return null;
  if (GROUPS.has(a)) {
    const sub = b !== undefined ? COMMANDS.find((c) => c.name === `${a} ${b}`) : undefined;
    if (sub) return { command: sub, used: 2 };
    // A bare group lists.
    const list = COMMANDS.find((c) => c.name === `${a} list`)!;
    if (b === undefined) return { command: list, used: 1 };
    throw usageError(`unknown command: ${a} ${b}`, `try: homerun help ${a}`);
  }
  const top = COMMANDS.find((c) => c.name === a);
  if (!top) throw usageError(`unknown command: ${a}`, "try: homerun help");
  return { command: top, used: 1 };
}

/** Options may come before or after the command words. */
export function parse(argv: string[]): Parsed {
  let first;
  try {
    first = parseArgs({ args: argv, options: ALL_OPTIONS, strict: false, allowPositionals: true });
  } catch (e) {
    throw usageError((e as Error).message);
  }
  const found = findCommand(first.positionals);
  if (!found) {
    const help = COMMANDS.find((c) => c.name === "help")!;
    return { command: help, values: first.values as Values, positionals: [] };
  }
  const { command, used } = found;
  let second;
  try {
    second = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...command.options }, strict: true, allowPositionals: true });
  } catch (e) {
    throw usageError((e as Error).message.replace(/\. To specify a positional.*$/s, ""), `usage: homerun ${command.name} ${command.args}`.trimEnd());
  }
  const positionals = second.positionals.slice(used);
  const values = second.values as Values;
  if (values.help) return { command: COMMANDS.find((c) => c.name === "help")!, values, positionals: second.positionals.slice(0, used) };
  const [min, max] = command.positionals;
  if (positionals.length < min || positionals.length > max)
    throw usageError(positionals.length < min ? "missing argument" : `unexpected argument: ${positionals[max]}`, `usage: homerun ${command.name} ${command.args}`.trimEnd());
  if (values.json && !command.json) throw usageError(`${command.name} has no --json output`);
  return { command, values, positionals };
}

export function intOption(values: Values, name: string, o: { min?: number; max?: number } = {}): number | undefined {
  const v = values[name];
  if (v === undefined) return undefined;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  const min = o.min ?? 0;
  const max = o.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw usageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function helpText(name?: string): string {
  if (name) {
    const matches = COMMANDS.filter((c) => c.name === name || c.name.startsWith(`${name} `));
    if (!matches.length) throw usageError(`unknown command: ${name}`);
    return matches.map((c) => `homerun ${c.name} ${c.args}`.trimEnd() + `\n    ${c.summary}`).join("\n") + "\n";
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "homerun: drive the local Homerun runtime (homerund).",
    "",
    "usage: homerun <command> [options]",
    "",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "Options:",
    "  --json                 Machine-readable output: the method's result, or one event per line when streaming",
    "  --no-color             No colour (also NO_COLOR=1)",
    "  -h, --help             Help for a command",
    "Development builds only:",
    "  --socket PATH          homerund's socket (or HOMERUN_SOCKET); default from HOMERUN_DATA_DIR",
    "  --dev-token-file PATH  The development token (default: dev-token next to the socket)",
    "",
    "IDs can be shortened to any unique prefix of at least 4 characters.",
    "Exit codes: 0 ok, 1 error or failed run, 64 usage, 69 homerund not running,",
    "75 waiting for input, 77 not authorized, 130 interrupted.",
    "",
  ].join("\n");
}
