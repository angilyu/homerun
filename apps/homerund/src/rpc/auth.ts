import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { roleAllowedInBuild, type BuildChannel, type HelloParams } from "@homerun/core";

/**
 * Connection authentication for `hello` (§5.2). In M2:
 * - `launch_token`: the 64-hex token the shell passes on homerund's stdin; authenticates the
 *   shell and its webview.
 * - `dev_token`: development builds only (`roleAllowedInBuild`). Regenerated on every start and
 *   written to `<run dir>/dev-token` (0600) for local tools and the replay harness (plan Q8).
 * - `cli_token` and `paired_device` arrive with the CLI (M3) and remote access (M9).
 */
export class Authenticator {
  constructor(
    private build: BuildChannel,
    private launchToken: string | null,
    private devToken: string | null,
  ) {}

  check(p: HelloParams): { ok: true } | { ok: false; message: string } {
    if (!roleAllowedInBuild(p.role, this.build)) return { ok: false, message: `The ${p.role} role is not available in release builds.` };
    switch (p.auth.kind) {
      case "launch_token":
        return equal(this.launchToken, p.auth.token) ? { ok: true } : { ok: false, message: "Invalid launch token." };
      case "dev_token":
        return equal(this.devToken, p.auth.token) ? { ok: true } : { ok: false, message: "Invalid development token." };
      case "cli_token":
        return { ok: false, message: "CLI tokens arrive in a later version of Homerun; use a development token." };
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
  const p = join(runDir, "dev-token");
  writeFileSync(p, token + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}
