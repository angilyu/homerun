/**
 * homerund (§5.1): the local runtime.
 *
 *   homerund serve [--dev-auto-approve] [--dev-mcp-overrides <file>] [--no-launch-token]
 *       Reads the shell's launch token from stdin line 1 (§5.2), then serves until stdin closes.
 *       `--no-launch-token` (development only) skips it: connect with the dev token instead,
 *       and stop with SIGTERM.
 *   homerund version
 *
 * Exit codes: 0 clean stop, 1 startup failure, 2 stdin closed before the token, 3 another
 * runtime is already serving this data dir, 64 usage.
 */
import { BUILD_CHANNEL, RUNTIME_VERSION, loadConfig } from "./config";
import { log } from "./log";
import { LAUNCH_TOKEN_RE } from "./rpc/auth";
import { AlreadyRunningError } from "./rpc/server";
import { AlreadyRunningLockError, startRuntime, type Runtime } from "./runtime";
import { DatabaseTooNewError } from "./store/migrate";

async function readToken(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let pending = "";
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      log.error("stdin closed before the launch token");
      process.exit(2);
    }
    pending += dec.decode(value, { stream: true });
    const nl = pending.indexOf("\n");
    if (nl >= 0) return pending.slice(0, nl).trim();
  }
}

async function serve(argv: string[]): Promise<void> {
  const noToken = argv.includes("--no-launch-token");
  if (noToken && BUILD_CHANNEL !== "development") {
    log.error("--no-launch-token is only available in development builds");
    process.exit(64);
  }
  const reader = noToken ? null : Bun.stdin.stream().getReader();
  const token = reader ? await readToken(reader) : null;
  if (token !== null && !LAUNCH_TOKEN_RE.test(token)) {
    log.error("malformed launch token");
    process.exit(2);
  }

  let rt: Runtime;
  try {
    const config = loadConfig({ argv });
    rt = await startRuntime({ config, launchToken: token, checkResults: config.build === "development" });
  } catch (e) {
    if (e instanceof AlreadyRunningError || e instanceof AlreadyRunningLockError) {
      log.warn("another homerund is serving; exiting", { err: e.message });
      process.exit(3);
    }
    if (e instanceof DatabaseTooNewError) log.error("database is too new", { err: e.message });
    else log.error("startup failed", { err: e instanceof Error ? e : String(e) });
    process.exit(1);
  }
  log.info("ready", {
    version: RUNTIME_VERSION,
    build: rt.config.build,
    socket: rt.config.socketPath,
    pid: process.pid,
    recovered: rt.report.recovered.length,
    killed_groups: rt.report.killedGroups.length,
  });

  const stop = async (why: string) => {
    log.info("shutting down", { why });
    await rt.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  // Stdin EOF: the shell asked us to stop, or it died (§5.1).
  if (reader) {
    void (async () => {
      while (!(await reader.read()).done) {}
      await stop("stdin EOF");
    })();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "serve":
    await serve(rest);
    break;
  case "version":
  case "--version":
    console.log(RUNTIME_VERSION);
    break;
  default:
    process.stderr.write("usage: homerund serve [--dev-auto-approve] [--dev-mcp-overrides <file>] [--no-launch-token] | homerund version\n");
    process.exit(64);
}
