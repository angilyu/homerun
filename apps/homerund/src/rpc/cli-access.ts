import { randomUUID } from "node:crypto";
import { CLI_ACCESS_MAX_PENDING, CLI_ACCESS_REQUEST_TTL_MS, RPC_ERROR, type NotificationName, type NotificationParams } from "@homerun/core";
import { log } from "../log";
import type { Clock } from "../schedule/clock";
import { issueCliToken, revokeCliToken } from "../store/cli-tokens";
import type { Store } from "../store/store";
import { RpcFail } from "./handlers";

/**
 * Command-line access (§5.2). An unapproved CLI calls `cli.request_access` before `hello`; the
 * shell shows a native prompt and answers with `cli.approve` or `cli.deny`; the decision, with
 * the token when approved, goes to the requesting connection and to no other. The CLI then says
 * `hello` with the token on that connection.
 *
 * Limits: one request per connection, `CLI_ACCESS_MAX_PENDING` waiting at once, and each expires
 * after `CLI_ACCESS_REQUEST_TTL_MS`. While a request waits, its connection's hello timeout is
 * held; after the decision it starts again, so a connection that never says hello still closes.
 */

type Decision = NotificationParams<"cli.access_decision">;

/** The requesting connection, before `hello`. */
export interface AccessRequester {
  /** Send `cli.access_decision` on this connection, which has no role yet. */
  sendAccessDecision(params: Decision): void;
  holdHelloTimeout(): void;
  restartHelloTimeout(): void;
}

interface Pending {
  request_id: string;
  conn: AccessRequester;
  client: { name: string; version: string };
  hostname: string;
  requested_at: number;
  expires_at: number;
  cancelTimer: () => void;
}

export interface CliAccessDeps {
  store: Store;
  clock: Clock;
  /** Notify the shell's connection (`cli.access_requested`, `cli.access_withdrawn`). */
  toShell: <N extends NotificationName>(method: N, params: NotificationParams<N>) => void;
  /** Close every live connection that authenticated with this token. */
  closeTokenConnections: (tokenId: string) => void;
  ttlMs?: number;
  maxPending?: number;
}

export class CliAccess {
  private pending = new Map<string, Pending>();
  private asked = new WeakSet<AccessRequester>();

  constructor(private d: CliAccessDeps) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  request(conn: AccessRequester, client: { name: string; version: string }, hostname: string) {
    if (this.asked.has(conn)) throw new RpcFail(RPC_ERROR.INVALID_REQUEST, "This connection has already asked for access. Connect again to ask again.");
    if (this.pending.size >= (this.d.maxPending ?? CLI_ACCESS_MAX_PENDING)) {
      throw new RpcFail(RPC_ERROR.UNAVAILABLE, "Other command-line tools are already waiting for an answer in the Homerun app.", { reason: "too_many_requests" });
    }
    this.asked.add(conn);
    const ttl = this.d.ttlMs ?? CLI_ACCESS_REQUEST_TTL_MS;
    const requested_at = this.d.clock.now();
    const request_id = randomUUID();
    const p: Pending = {
      request_id,
      conn,
      client: { name: client.name, version: client.version },
      hostname,
      requested_at,
      expires_at: requested_at + ttl,
      cancelTimer: this.d.clock.setTimer(ttl, () => this.expire(request_id)),
    };
    this.pending.set(request_id, p);
    conn.holdHelloTimeout();
    log.info("cli access requested", { request_id, client: p.client.name, version: p.client.version });
    return { result: { request_id, expires_at: p.expires_at }, after: () => this.d.toShell("cli.access_requested", this.announcement(p)) };
  }

  approve(requestId: string): { token_id: string } {
    const p = this.take(requestId);
    const { token, token_id } = issueCliToken(this.d.store, p.client, p.hostname, this.d.clock.now());
    p.conn.sendAccessDecision({ request_id: p.request_id, approved: true, token, token_id });
    p.conn.restartHelloTimeout();
    log.info("cli access approved", { request_id: p.request_id, token_id });
    return { token_id };
  }

  deny(requestId: string): void {
    const p = this.take(requestId);
    p.conn.sendAccessDecision({ request_id: p.request_id, approved: false, reason: "denied" });
    p.conn.restartHelloTimeout();
    log.info("cli access denied", { request_id: p.request_id });
  }

  /** The requesting connection closed, or said `hello` without waiting: withdraw its prompt. */
  cancel(conn: AccessRequester): void {
    for (const p of [...this.pending.values()]) {
      if (p.conn !== conn) continue;
      this.pending.delete(p.request_id);
      p.cancelTimer();
      this.d.toShell("cli.access_withdrawn", { request_id: p.request_id, reason: "cancelled" });
      log.info("cli access request cancelled", { request_id: p.request_id });
    }
  }

  /** The shell (re)connected: show what is still waiting. */
  replay(send: (method: "cli.access_requested", params: NotificationParams<"cli.access_requested">) => void): void {
    for (const p of this.pending.values()) send("cli.access_requested", this.announcement(p));
  }

  /** Revoke a token and close its live connections. False when there is no such token. */
  revoke(tokenId: string): boolean {
    const at = revokeCliToken(this.d.store, tokenId, this.d.clock.now());
    if (at === null) return false;
    log.info("cli token revoked", { token_id: tokenId });
    this.d.closeTokenConnections(tokenId);
    return true;
  }

  stop(): void {
    for (const p of this.pending.values()) p.cancelTimer();
    this.pending.clear();
  }

  private expire(requestId: string): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.conn.sendAccessDecision({ request_id: p.request_id, approved: false, reason: "expired" });
    p.conn.restartHelloTimeout();
    this.d.toShell("cli.access_withdrawn", { request_id: p.request_id, reason: "expired" });
    log.info("cli access request expired", { request_id: p.request_id });
  }

  private take(requestId: string): Pending {
    const p = this.pending.get(requestId);
    if (!p) throw new RpcFail(RPC_ERROR.NOT_FOUND, "No such access request: it was answered, expired, or its command-line tool went away.");
    this.pending.delete(requestId);
    p.cancelTimer();
    return p;
  }

  private announcement(p: Pending): NotificationParams<"cli.access_requested"> {
    return { request_id: p.request_id, client: p.client, hostname: p.hostname, requested_at: p.requested_at, expires_at: p.expires_at };
  }
}
