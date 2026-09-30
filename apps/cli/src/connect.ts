import { dirname, win32 } from "node:path";
import {
  ConnectionClosedError,
  DevTokenError,
  EndpointError,
  localEndpoint,
  RpcCallError,
  RpcClient,
  RpcProtocolError,
  RuntimeUnavailableError,
  chooseRunDir,
  dataDir,
  devTokenPath,
  readDevTokenFile,
} from "@homerun/client";
import { RPC_ERROR, type BuildChannel } from "@homerun/core";
import type { Values } from "./args";
import { CLI_VERSION } from "./build";
import { CliError, EXIT } from "./exit";

export type Env = Record<string, string | undefined>;

export const START_HINT = "open Homerun, or start a development runtime with `pnpm --filter @homerun/homerund dev`";

/** The switches only a development build honours. A release build exits 64 on any of them. */
export function devSwitchesUsed(values: Values, env: Env): string[] {
  const used: string[] = [];
  if (values.socket !== undefined) used.push("--socket");
  if (env.HOMERUN_SOCKET) used.push("HOMERUN_SOCKET");
  if (values["dev-token-file"] !== undefined) used.push("--dev-token-file");
  for (const flag of ["dev-role", "dev-token-store", "dev-skip-peer-check", "dev-peer-requirement", "dev-keychain"])
    if (values[flag] !== undefined) used.push(`--${flag}`);
  if (env.HOMERUN_DEV_TOKEN_STORE) used.push("HOMERUN_DEV_TOKEN_STORE");
  if (env.HOMERUN_DEV_SKIP_PEER_CHECK) used.push("HOMERUN_DEV_SKIP_PEER_CHECK");
  return used;
}

export function refuseDevSwitches(channel: BuildChannel, values: Values, env: Env): void {
  if (channel === "development") return;
  const [first] = devSwitchesUsed(values, env);
  if (first) throw new CliError(`${first} is only available in development builds; this is a release build`, EXIT.USAGE);
}

/** Commands only full authority may run: approvals, "Did this happen?" and grants (INPUT_ANSWER_RIGHTS.cli). */
export function fullAuthorityOnly(command: string, values: Values): boolean {
  if (command === "approve" || command === "deny" || command === "grants add") return true;
  return command === "answer" && (values.completed === true || values["not-run"] === true);
}

export const releaseQuestionsOnly = () =>
  new CliError(
    "the release CLI answers questions only; approve tool calls, answer \"Did this happen?\" and grant tools in the Homerun app",
    EXIT.NOPERM,
  );

export interface Target {
  socketPath: string;
  tokenPath: string;
  /** Why the development token may be missing, when the default path is only a guess. */
  tokenHint?: string;
}

const PIPE_TOKEN_HINT =
  "a pipe name doesn't say where its runtime keeps the development token: pass --dev-token-file, or set HOMERUN_DATA_DIR to that runtime's data dir";

/**
 * The socket from the shared data-dir rules (§5.2), and the dev token beside it. On Windows the
 * pipe name is the one the running runtime published, read when first needed, so a command that
 * can do without it (`logout`) still runs when homerund doesn't. A pipe has no folder, so the dev
 * token is always the data dir's unless `--dev-token-file` says otherwise.
 */
export function resolveTarget(
  values: Values,
  env: Env,
  platform: string = process.platform,
  published: (dataDir: string) => string = (d) => localEndpoint(d, "win32").socketPath,
): Target {
  const explicit = (values.socket as string | undefined) ?? (env.HOMERUN_SOCKET || undefined);
  const devToken = values["dev-token-file"] as string | undefined;
  if (platform !== "win32") {
    const socketPath = explicit ?? chooseRunDir(dataDir(env)).socketPath;
    return { socketPath, tokenPath: devToken ?? devTokenPath(dirname(socketPath)) };
  }
  const data = dataDir(env, undefined, "win32");
  const tokenPath = devToken ?? devTokenPath(win32.join(data, "run"), "win32");
  if (explicit) return { socketPath: explicit, tokenPath, ...(devToken ? {} : { tokenHint: PIPE_TOKEN_HINT }) };
  let pipe: string | undefined;
  return {
    tokenPath,
    get socketPath() {
      pipe ??= publishedPipe(() => published(data));
      return pipe;
    },
  };
}

function publishedPipe(read: () => string): string {
  try {
    return read();
  } catch (e) {
    if (!(e instanceof EndpointError)) throw e;
    if (e.reason === "missing") throw new CliError("Homerun is not running", EXIT.UNAVAILABLE, START_HINT);
    throw new CliError(`the runtime's endpoint can't be trusted: ${e.message}`, EXIT.NOPERM, "quit Homerun, delete the file, and open Homerun again");
  }
}

/**
 * Connect and authenticate a development build as `cli_dev`, with the development token homerund
 * writes at each start, read fresh on every call. The release role (`cli`) goes through
 * `CliAccess` instead: a peer check, then its own token (§5.2).
 */
export async function connectDev(channel: BuildChannel, target: Target): Promise<RpcClient> {
  if (channel !== "development") throw new CliError("a release build never uses the development token", EXIT.NOPERM);
  let c: RpcClient;
  try {
    c = await RpcClient.connect(target.socketPath);
  } catch (e) {
    if (e instanceof RuntimeUnavailableError) throw new CliError(`homerund is not running (nothing is listening on ${target.socketPath})`, EXIT.UNAVAILABLE, START_HINT);
    throw e;
  }
  let token: string;
  try {
    token = readDevTokenFile(target.tokenPath);
  } catch (e) {
    c.close();
    if (e instanceof DevTokenError)
      throw new CliError(
        e.message,
        EXIT.NOPERM,
        e.reason === "missing" ? (target.tokenHint ?? "only a development build of homerund writes a development token") : undefined,
      );
    throw e;
  }
  try {
    await c.handshake("cli_dev", { kind: "dev_token", token }, { client: { name: "homerun-cli", version: CLI_VERSION }, validate: true });
  } catch (e) {
    if (e instanceof RpcCallError && e.code === RPC_ERROR.UNAUTHENTICATED)
      throw new CliError(`homerund refused the development token: ${e.message}`, EXIT.NOPERM, "a release build of homerund accepts no development token");
    throw e;
  }
  return c;
}

/** Map a failure to a message and exit code. */
export function toCliError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  if (e instanceof RpcCallError) {
    const code =
      e.code === RPC_ERROR.UNAUTHENTICATED || e.code === RPC_ERROR.FORBIDDEN || e.code === RPC_ERROR.AUTHORITY_INSUFFICIENT
        ? EXIT.NOPERM
        : e.code === RPC_ERROR.INVALID_PARAMS
          ? EXIT.USAGE
          : EXIT.ERROR;
    const notImplemented = (e.data as { not_implemented?: unknown } | undefined)?.not_implemented === true;
    return new CliError(e.message, code, notImplemented ? "this homerund does not support it yet" : undefined);
  }
  if (e instanceof ConnectionClosedError) return new CliError("homerund closed the connection", EXIT.UNAVAILABLE);
  if (e instanceof RuntimeUnavailableError) return new CliError(`homerund is not running (${e.message})`, EXIT.UNAVAILABLE, START_HINT);
  if (e instanceof RpcProtocolError) return new CliError(e.message, EXIT.ERROR, "is homerund newer or older than this CLI?");
  return new CliError(e instanceof Error ? e.message : String(e), EXIT.ERROR);
}
