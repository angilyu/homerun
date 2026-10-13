#!/usr/bin/env bun
/**
 * Signs the minimum-version and kill-switch policy (design.md §11 "Updates and control") with the
 * offline Ed25519 policy key. The key never lives in a repository: this refuses a key path inside
 * any git work tree. See apps/relay/README.md "Publishing a policy".
 *
 *   bun scripts/release/sign-policy.ts keygen --out ~/secure/homerun-policy-2026-01.key
 *   bun scripts/release/sign-policy.ts pubkey --key ~/secure/homerun-policy-2026-01.key
 *   bun scripts/release/sign-policy.ts sign --key <file> --key-id 2026-01 --in policy.json --out signed.json
 *   bun scripts/release/sign-policy.ts verify --in signed.json [--key-id 2026-01 --public-key <base64url>]
 *
 * In policy.json, `issued_at` and `expires_at` may be ISO 8601 strings or epoch milliseconds;
 * `issued_at` defaults to now. The key file holds the 32-byte Ed25519 seed as base64url.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { VERSION_POLICY_MAX_LIFETIME_MS, VersionPolicy } from "../../packages/core/src/index";
import {
  PolicyKeyId,
  VERSION_POLICY_KEYS,
  ed25519Key,
  fromB64url,
  generateEd25519,
  signVersionPolicy,
  toB64url,
  verifySignedVersionPolicy,
  type VersionPolicyKeys,
} from "../../packages/protocol/src/index";

const REPO = resolve(import.meta.dir, "../..");
/** How far ahead of now `issued_at` may be: the clients' allowance for clock skew. */
const MAX_AHEAD_MS = 24 * 3_600_000;

export class UsageError extends Error {}

export interface Io {
  out(line: string): void;
  now(): number;
}

const defaultIo: Io = { out: (l) => console.log(l), now: () => Date.now() };

function flags(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--") || i + 1 >= args.length) throw new UsageError(`unexpected argument: ${a}`);
    m.set(a.slice(2), args[++i]!);
  }
  return m;
}

function need(f: Map<string, string>, name: string): string {
  const v = f.get(name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
}

/** `path` with symlinks in its existing part resolved. */
function realish(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  return join(realish(dirname(abs)), basename(abs));
}

/** Refuses a key path inside this repository or any git work tree. */
export function assertOutsideRepos(path: string): void {
  const real = realish(path);
  const rel = relative(realpathSync(REPO), real);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new UsageError(`refusing a key inside this repository: ${path}. Keep the policy key offline.`);
  let dir = dirname(real);
  while (!existsSync(dir)) dir = dirname(dir);
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim()) throw new UsageError(`refusing a key inside a git work tree (${git.stdout.trim()}): ${path}. Keep the policy key offline.`);
}

function readKey(path: string) {
  assertOutsideRepos(path);
  const seed = fromB64url(readFileSync(path, "utf8").trim());
  if (seed.length !== 32) throw new UsageError(`${path} isn't a policy key (32 bytes, base64url)`);
  return ed25519Key(seed);
}

function time(v: unknown, name: string): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  throw new UsageError(`${name} must be an ISO 8601 time or epoch milliseconds`);
}

/** Reads policy JSON with ISO or millisecond times, and checks what the clients will check. */
export function readPolicy(text: string, now: number): VersionPolicy {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const issued_at = raw.issued_at === undefined ? now : time(raw.issued_at, "issued_at");
  if (raw.expires_at === undefined) throw new UsageError("expires_at is required");
  const parsed = VersionPolicy.safeParse({ ...raw, issued_at, expires_at: time(raw.expires_at, "expires_at") });
  if (!parsed.success) throw new UsageError(`not a valid policy: ${parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; ")}`);
  const p = parsed.data;
  if (p.issued_at > now + MAX_AHEAD_MS) throw new UsageError("issued_at is more than 24 hours ahead; clients would refuse it");
  if (p.expires_at <= now) throw new UsageError("expires_at has passed; clients would ignore it");
  if (p.expires_at - p.issued_at > VERSION_POLICY_MAX_LIFETIME_MS) throw new UsageError("a policy may be valid for at most 90 days");
  return p;
}

function summary(p: VersionPolicy): string[] {
  const lines = [`issued ${new Date(p.issued_at).toISOString()}, expires ${new Date(p.expires_at).toISOString()}, ${p.rules.length} rule(s)`];
  for (const r of p.rules) {
    const parts = [
      r.min_version && `min ${r.min_version}`,
      r.blocked_versions?.length && `blocked ${r.blocked_versions.join(", ")}`,
      r.kill?.length && `KILL ${r.kill.join(", ")}${r.kill_interactive ? " (chat too)" : ""}`,
    ].filter(Boolean);
    lines.push(`  ${r.platform}/${r.channel}: ${parts.join("; ") || "no restriction"}`);
  }
  return lines;
}

export async function main(argv: string[], io: Io = defaultIo, keys: VersionPolicyKeys = VERSION_POLICY_KEYS): Promise<void> {
  const [cmd, ...rest] = argv;
  const f = flags(rest);
  switch (cmd) {
    case "keygen": {
      const out = need(f, "out");
      assertOutsideRepos(out);
      if (existsSync(out)) throw new UsageError(`${out} already exists`);
      const key = generateEd25519();
      writeFileSync(out, toB64url(key.secretKey) + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(out, 0o600);
      io.out(`wrote ${out}`);
      io.out(`public key (add it to VERSION_POLICY_KEYS in packages/protocol/src/version-policy.ts): ${toB64url(key.publicKey)}`);
      return;
    }
    case "pubkey": {
      io.out(toB64url(readKey(need(f, "key")).publicKey));
      return;
    }
    case "sign": {
      const key = readKey(need(f, "key"));
      const keyId = PolicyKeyId.safeParse(need(f, "key-id"));
      if (!keyId.success) throw new UsageError("--key-id must be like 2026-01");
      const policy = readPolicy(readFileSync(need(f, "in"), "utf8"), io.now());
      const signed = await signVersionPolicy(policy, keyId.data, key);
      // Check the result the way a client will before anyone publishes it.
      if (!verifySignedVersionPolicy(signed, { [keyId.data]: toB64url(key.publicKey) })) throw new Error("the signed policy didn't verify");
      const out = need(f, "out");
      writeFileSync(out, JSON.stringify(signed) + "\n");
      for (const l of summary(policy)) io.out(l);
      const known = keys[keyId.data];
      if (known !== toB64url(key.publicKey)) io.out(`note: key ${keyId.data} isn't in VERSION_POLICY_KEYS${known ? " (a different key has that id)" : ""}; released builds won't accept this policy`);
      io.out(`wrote ${out}`);
      return;
    }
    case "verify": {
      const signed = JSON.parse(readFileSync(need(f, "in"), "utf8")) as unknown;
      const using: VersionPolicyKeys = f.has("public-key") ? { [need(f, "key-id")]: need(f, "public-key") } : keys;
      const p = verifySignedVersionPolicy(signed, using);
      if (!p) throw new UsageError(`the policy doesn't verify against ${f.has("public-key") ? "that key" : "VERSION_POLICY_KEYS"}`);
      for (const l of summary(p)) io.out(l);
      if (p.expires_at <= io.now()) io.out("note: it has expired; clients ignore it");
      return;
    }
    default:
      throw new UsageError("usage: sign-policy.ts keygen|pubkey|sign|verify …  (see the header of scripts/release/sign-policy.ts)");
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof UsageError ? 64 : 1);
  });
}
