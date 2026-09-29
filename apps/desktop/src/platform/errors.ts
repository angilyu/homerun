import { NotConnectedError, RpcCallError } from "@homerun/app-state";
import { ShellError } from "./types";

/** The shell's serialized error (`ShellError` in shell-core/src/allowlist.rs) as a typed one. */
export function fromShellError(e: unknown): Error {
  if (e && typeof e === "object" && "kind" in e) {
    const x = e as { kind: string; code?: number | null; message?: string; data?: unknown };
    const message = x.message ?? "Something went wrong.";
    if (x.kind === "rpc" && typeof x.code === "number") return new RpcCallError(x.code, message, x.data ?? undefined);
    if (x.kind === "not_connected") return new NotConnectedError(message);
    return new ShellError(x.kind, message);
  }
  if (e instanceof Error) return e;
  return new ShellError("shell", typeof e === "string" ? e : "Something went wrong.");
}
