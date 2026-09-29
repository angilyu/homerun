import { RPC_ERROR } from "@homerun/core";

/** A JSON-RPC error from the runtime (§5.2). */
export class RpcCallError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcCallError";
  }
}

/** The runtime can't be reached right now (starting, restarting, stopped). Safe to retry later. */
export class NotConnectedError extends Error {
  constructor(message = "Homerun's runtime isn't running right now.") {
    super(message);
    this.name = "NotConnectedError";
  }
}

/** A result or notification that doesn't match its core schema: a version mismatch or a bug. */
export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export const isRpcError = (e: unknown, code?: number): e is RpcCallError =>
  e instanceof RpcCallError && (code === undefined || e.code === code);

export const isConflict = (e: unknown) => isRpcError(e, RPC_ERROR.CONFLICT);

/** A sentence for the user. Runtime messages are already written for people (§5.2). */
export function errorMessage(e: unknown): string {
  if (e instanceof RpcCallError || e instanceof NotConnectedError) return e.message;
  if (e instanceof ProtocolError) return "Homerun got an answer it didn't understand. Try restarting the app.";
  if (e instanceof Error) return e.message;
  return String(e);
}
