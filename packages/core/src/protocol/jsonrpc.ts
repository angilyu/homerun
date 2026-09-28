import { z } from "zod";
import { named } from "../registry";
import { JsonValue } from "../common";

/**
 * Framing (§5.2): JSON-RPC 2.0 messages, one per line (NDJSON), UTF-8, over the local socket,
 * or one per relay frame inside the E2E channel (§9.4). Requests go both ways: the runtime
 * calls the shell for `secrets.persist`.
 */

/** Largest frame either side accepts. `blobs.get` pages stay well under it. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const RpcId = named("RpcId", z.union([z.int(), z.string().min(1).max(128)]), "Request id; null is not allowed");
export type RpcId = z.infer<typeof RpcId>;

export const RpcRequest = named(
  "RpcRequest",
  z.object({
    jsonrpc: z.literal("2.0"),
    id: RpcId,
    method: z.string().min(1).max(128),
    params: z.record(z.string(), JsonValue).optional(),
  }),
);
export type RpcRequest = z.infer<typeof RpcRequest>;

export const RpcNotification = named(
  "RpcNotification",
  z.strictObject({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1).max(128),
    params: z.record(z.string(), JsonValue).optional(),
  }),
);
export type RpcNotification = z.infer<typeof RpcNotification>;

// ---------------------------------------------------------------- errors

/**
 * Error codes. -32700…-32603 are JSON-RPC's. Application codes live in -32001…-32099, the range
 * JSON-RPC reserves for implementations.
 */
export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Bad or missing credentials in `hello`. The connection is closed after the reply. */
  UNAUTHENTICATED: -32001,
  /** The method exists but this caller's role may not call it (see `callers.ts`). */
  FORBIDDEN: -32002,
  /** No protocol version in common. `data` is `IncompatibleProtocolData`. */
  INCOMPATIBLE_PROTOCOL: -32003,
  NOT_FOUND: -32004,
  /** Optimistic concurrency failed. `data` is `ConflictData`. */
  CONFLICT: -32005,
  /** Well-formed but rejected by a domain rule (for example an invalid task spec edit). */
  VALIDATION_FAILED: -32006,
  /** The caller's authority is too low, e.g. the web client approving a destructive call (§9.9). */
  AUTHORITY_INSUFFICIENT: -32007,
  /** A method other than `hello` / `cli.request_access` before the handshake. */
  HANDSHAKE_REQUIRED: -32008,
  /** Temporarily unable, e.g. the shell has not sent the API key yet. Retry later. */
  UNAVAILABLE: -32009,
  /** A budget cap blocks the action (§7.4). */
  BUDGET_EXCEEDED: -32010,
} as const;
export type RpcErrorCode = (typeof RPC_ERROR)[keyof typeof RPC_ERROR];

const errorCodes = Object.values(RPC_ERROR) as [RpcErrorCode, ...RpcErrorCode[]];

export const RpcError = named(
  "RpcError",
  z.object({
    /** Known codes are listed in RPC_ERROR; readers must accept unknown ones. */
    code: z.int(),
    message: z.string().max(10_000),
    data: JsonValue.optional(),
  }),
);
export type RpcError = z.infer<typeof RpcError>;

export const KNOWN_ERROR_CODES: readonly RpcErrorCode[] = errorCodes;

export const IncompatibleProtocolData = named(
  "IncompatibleProtocolData",
  z.object({ supported: z.object({ min: z.int().min(1), max: z.int().min(1) }) }),
);
export const ConflictData = named("ConflictData", z.object({ current_version: z.int().min(1) }));

export const RpcSuccess = named(
  "RpcSuccess",
  z.strictObject({ jsonrpc: z.literal("2.0"), id: RpcId, result: JsonValue }),
);
export type RpcSuccess = z.infer<typeof RpcSuccess>;

export const RpcFailure = named(
  "RpcFailure",
  /** `id` is null only when the request id could not be read (parse error). */
  z.strictObject({ jsonrpc: z.literal("2.0"), id: RpcId.nullable(), error: RpcError }),
);
export type RpcFailure = z.infer<typeof RpcFailure>;

export const RpcResponse = named("RpcResponse", z.union([RpcSuccess, RpcFailure]));
export type RpcResponse = z.infer<typeof RpcResponse>;

/** Any frame. Classified by shape: `method` + `id` = request, `method` alone = notification. */
export const RpcMessage = named("RpcMessage", z.union([RpcRequest, RpcNotification, RpcSuccess, RpcFailure]));
export type RpcMessage = z.infer<typeof RpcMessage>;

export type RpcFrameKind = "request" | "notification" | "success" | "failure";

export function classifyFrame(raw: unknown): { kind: RpcFrameKind; frame: RpcMessage } | { kind: "invalid"; error: z.ZodError } {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const [kind, schema] =
    "method" in o
      ? "id" in o
        ? (["request", RpcRequest] as const)
        : (["notification", RpcNotification] as const)
      : "error" in o
        ? (["failure", RpcFailure] as const)
        : (["success", RpcSuccess] as const);
  const r = (schema as z.ZodType<RpcMessage>).safeParse(raw);
  return r.success ? { kind, frame: r.data } : { kind: "invalid", error: r.error };
}
