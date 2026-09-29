import { METHODS, type MethodName, type MethodParams, type MethodResult } from "@homerun/core";
import { ProtocolError } from "./errors";
import type { Transport } from "./transport";

/**
 * Typed calls. Every result is checked against its core schema (§5.2), so a view never renders
 * a shape it doesn't know; a mismatch is a `ProtocolError`.
 */
export class Rpc {
  constructor(private readonly transport: Transport) {}

  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const raw = await this.transport.call(method, params);
    const r = METHODS[method].result.safeParse(raw);
    if (!r.success) throw new ProtocolError(`${method}: the runtime's answer doesn't match the protocol`, r.error.issues);
    return r.data as MethodResult<M>;
  }
}
