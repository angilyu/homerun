import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CliTokenInfo } from "@homerun/core";
import type { Store } from "./store";

/**
 * `cli_tokens` (§5.2): approved command-line tools. Only the SHA-256 of a token is stored; the
 * token itself exists in the runtime just long enough to be sent to the CLI that asked for it.
 */

interface TokenRow {
  token_id: string;
  client_name: string;
  client_version: string;
  hostname: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

const COLUMNS = "token_id, client_name, client_version, hostname, created_at, last_used_at, revoked_at";

type TokenInfo = ReturnType<typeof CliTokenInfo.parse>;

function toInfo(r: TokenRow): TokenInfo {
  return CliTokenInfo.parse({
    token_id: r.token_id,
    client: { name: r.client_name, version: r.client_version },
    hostname: r.hostname,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
  });
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issue a token: 256 random bits, base64url without padding (core `CliToken`). */
export function issueCliToken(store: Store, client: { name: string; version: string }, hostname: string, now: number): { token: string; token_id: string } {
  const token = randomBytes(32).toString("base64url");
  const token_id = randomUUID();
  store.db
    .query("INSERT INTO cli_tokens (token_id, token_sha256, client_name, client_version, hostname, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)")
    .run(token_id, tokenHash(token), client.name, client.version, hostname, now);
  return { token, token_id };
}

export type TokenCheck = { ok: true; token_id: string } | { ok: false; reason: "unknown" | "revoked" };

/** Look a presented token up by its hash. On success, record the use. */
export function useCliToken(store: Store, token: string, now: number): TokenCheck {
  const r = store.db.query<{ token_id: string; revoked_at: number | null }, [string]>("SELECT token_id, revoked_at FROM cli_tokens WHERE token_sha256 = ?").get(tokenHash(token));
  if (!r) return { ok: false, reason: "unknown" };
  if (r.revoked_at !== null) return { ok: false, reason: "revoked" };
  store.db.query("UPDATE cli_tokens SET last_used_at = ? WHERE token_id = ?").run(now, r.token_id);
  return { ok: true, token_id: r.token_id };
}

/** Tokens that still work, newest first. */
export function listCliTokens(store: Store): TokenInfo[] {
  return store.db
    .query<TokenRow, []>(`SELECT ${COLUMNS} FROM cli_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`)
    .all()
    .map(toInfo);
}

/** Revoke a token. Null when there is no such token; revoking twice keeps the first time. */
export function revokeCliToken(store: Store, tokenId: string, now: number): number | null {
  const r = store.db.query<{ revoked_at: number | null }, [string]>("SELECT revoked_at FROM cli_tokens WHERE token_id = ?").get(tokenId);
  if (!r) return null;
  if (r.revoked_at !== null) return r.revoked_at;
  store.db.query("UPDATE cli_tokens SET revoked_at = ? WHERE token_id = ?").run(now, tokenId);
  return now;
}
