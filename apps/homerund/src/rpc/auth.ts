import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { roleAllowedInBuild, type BuildChannel, type CliAuthFailureData, type HelloParams } from "@homerun/core";
import { devTokenPath } from "@homerun/client";

export type AuthCheck = { ok: true; cliTokenId?: string } | { ok: false; message: string; data?: CliAuthFailureData };

/** Checks a presented CLI token (`useCliToken`), recording its use when it is valid. */
export type CliTokenCheck = (token: string) => { ok: true; token_id: string } | { ok: false; reason: CliAuthFailureData["reason"] };

/**
 * Connection authentication for `hello` (§5.2):
 * - `launch_token`: the 64-hex token the shell passes on homerund's stdin; authenticates the
 *   shell and its webview.
 * - `dev_token`: development builds only (`roleAllowedInBuild`). Regenerated on every start and
 *   written to `<run dir>/dev-token` (0600) for local tools and the replay harness.
 * - `cli_token`: issued when the user approves a CLI (milestone 8a, `cli-access.ts`), checked by
 *   its SHA-256 against `cli_tokens`.
 * - `paired_device` arrives with remote access (M9).
 */
export class Authenticator {
  constructor(
    private build: BuildChannel,
    private launchToken: string | null,
    private devToken: string | null,
    private cliTokens: CliTokenCheck | null = null,
  ) {}

  check(p: HelloParams): AuthCheck {
    if (!roleAllowedInBuild(p.role, this.build)) return { ok: false, message: `The ${p.role} role is not available in release builds.` };
    switch (p.auth.kind) {
      case "launch_token":
        return equal(this.launchToken, p.auth.token) ? { ok: true } : { ok: false, message: "Invalid launch token." };
      case "dev_token":
        return equal(this.devToken, p.auth.token) ? { ok: true } : { ok: false, message: "Invalid development token." };
      case "cli_token": {
        const r = this.cliTokens?.(p.auth.token) ?? { ok: false as const, reason: "unknown" as const };
        if (r.ok) return { ok: true, cliTokenId: r.token_id };
        const message = r.reason === "revoked" ? "This command-line tool's access was revoked in the Homerun app." : "This command-line tool's token is not recognised.";
        return { ok: false, message, data: { reason: r.reason } };
      }
      case "paired_device":
        return { ok: false, message: "Remote devices arrive in a later version of Homerun." };
    }
  }
}

function equal(expected: string | null, got: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 256 random bits, base64url without padding: 43 characters (core `CliToken`). */
export function newDevToken(): string {
  return randomBytes(32).toString("base64url");
}

export const LAUNCH_TOKEN_RE = /^[0-9a-f]{64}$/;

export function writeDevToken(runDir: string, token: string): string {
  const p = devTokenPath(runDir);
  writeFileSync(p, token + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
