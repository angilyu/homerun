import { dirname } from "node:path";
import {
  ConnectionClosedError,
  DevTokenError,
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
}

/** The socket from the shared data-dir rules (§5.2), and the dev token beside it. */
export function resolveTarget(values: Values, env: Env): Target {
  const socketPath = (values.socket as string | undefined) ?? (env.HOMERUN_SOCKET || chooseRunDir(dataDir(env)).socketPath);
  const tokenPath = (values["dev-token-file"] as string | undefined) ?? devTokenPath(dirname(socketPath));
  return { socketPath, tokenPath };
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
      throw new CliError(e.message, EXIT.NOPERM, e.reason === "missing" ? "only a development build of homerund writes a development token" : undefined);
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
