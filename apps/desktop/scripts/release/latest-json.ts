#!/usr/bin/env bun
/**
 * The release's one latest.json (design §11), from per-platform fragments, checked before it is
 * published: every entry's payload must be in the release's assets, its minisign signature must
 * verify against the public key compiled into the app (tauri.conf.json), and the signed version
 * must be the release's. A mismatched key fails the release rather than shipping updates no
 * installed app would accept.
 *
 *   bun latest-json.ts fragment --platform windows-x86_64 --version 0.2.0 --url URL --sig FILE.sig --out frag.json
 *   bun latest-json.ts merge --version 0.2.0 --assets DIR --out latest.json [--notes TEXT] frag.json…
 *
 * A fragment has latest.json's shape (scripts/macos/updater-artifacts.sh writes macOS's). Only the
 * platforms present are offered; an unsigned build never gets a fragment (§18 row 134).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const PLACEHOLDER_PUBKEY = "HOMERUN_UPDATER_PUBKEY_NOT_SET";
export const PLATFORMS = ["darwin-aarch64", "windows-x86_64"] as const;
export const RELEASES = "https://github.com/angilyu/homerun/releases/download/";

type Entry = { signature: string; url: string };
export type Manifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, Entry>;
  homerun?: Record<string, unknown>;
};

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** The second line of a base64-wrapped minisign file (Tauri's format), decoded. */
function minisignLines(b64: string, what: string): string[] {
  let text: string;
  try {
    text = Buffer.from(b64.trim(), "base64").toString("utf8");
  } catch {
    throw new Error(`${what} is not base64`);
  }
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`${what} is not a minisign file`);
  return lines;
}

/**
 * Verifies a Tauri updater signature (minisign, Ed25519; "ED" = BLAKE2b-512 prehash) and returns
 * its trusted comment, which only the global signature makes trustworthy.
 */
export function verifyMinisign(pubkeyB64: string, signatureB64: string, data: Uint8Array): string {
  const pk = Buffer.from(minisignLines(pubkeyB64, "public key")[1] ?? "", "base64");
  if (pk.length !== 42 || pk.subarray(0, 2).toString() !== "Ed") throw new Error("not a minisign Ed25519 public key");
  const [, sigLine, tcLine, globalLine] = minisignLines(signatureB64, "signature");
  const sig = Buffer.from(sigLine ?? "", "base64");
  if (sig.length !== 74) throw new Error("malformed signature");
  const alg = sig.subarray(0, 2).toString();
  if (alg !== "ED" && alg !== "Ed") throw new Error(`unknown signature algorithm ${alg}`);
  if (!sig.subarray(2, 10).equals(pk.subarray(2, 10))) {
    throw new Error(`signed with key ${keyId(sig)}, but the app trusts key ${keyId(pk)}`);
  }
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pk.subarray(10)]), format: "der", type: "spki" });
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!verify(null, message, key, sig.subarray(10))) throw new Error("signature does not match the payload");
  if (!tcLine?.startsWith("trusted comment: ")) throw new Error("signature has no trusted comment");
  const trusted = tcLine.slice("trusted comment: ".length);
  const global = Buffer.from(globalLine ?? "", "base64");
  if (global.length !== 64 || !verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, global)) {
    throw new Error("the trusted comment's signature does not verify");
  }
  return trusted;
}

function keyId(b: Buffer): string {
  return Buffer.from(b.subarray(2, 10)).reverse().toString("hex").toUpperCase();
}

/** The `version:` field Tauri's signer writes into the trusted comment (requireSignedVersion). */
export function signedVersion(trustedComment: string): string | null {
  for (const f of trustedComment.split("\t")) if (f.startsWith("version:")) return f.slice("version:".length);
  return null;
}

export function configPubkey(root: string): string {
  const conf = JSON.parse(readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  return String(conf?.plugins?.updater?.pubkey ?? "");
}

export function fragment(platform: string, version: string, url: string, signature: string): Manifest {
  if (!(PLATFORMS as readonly string[]).includes(platform)) throw new Error(`unknown platform ${platform}`);
  return { version, notes: "", pub_date: "", platforms: { [platform]: { signature: signature.trim(), url } } };
}

export function merge(o: {
  version: string;
  fragments: Manifest[];
  assetsDir: string;
  pubkey: string;
  notes?: string;
  urlPrefix?: string;
  now?: Date;
}): Manifest {
  if (!o.pubkey || o.pubkey === PLACEHOLDER_PUBKEY) throw new Error("tauri.conf.json still has the placeholder updater key: no build can verify an update");
  const prefix = `${o.urlPrefix ?? RELEASES}v${o.version}/`;
  const platforms: Record<string, Entry> = {};
  let homerun: Record<string, unknown> | undefined;
  for (const f of o.fragments) {
    if (f.version !== o.version) throw new Error(`a fragment is for ${f.version}, not ${o.version}`);
    for (const [platform, e] of Object.entries(f.platforms ?? {})) {
      if (!(PLATFORMS as readonly string[]).includes(platform)) throw new Error(`unknown platform ${platform}`);
      if (platforms[platform]) throw new Error(`${platform} appears twice`);
      if (!e.url.startsWith(prefix) || e.url.slice(prefix.length).includes("/")) throw new Error(`${platform}: ${e.url} is not an asset of v${o.version} (${prefix}…)`);
      const asset = join(o.assetsDir, basename(e.url));
      if (!existsSync(asset)) throw new Error(`${platform}: ${basename(e.url)} is not among the release's assets`);
      let trusted: string;
      try {
        trusted = verifyMinisign(o.pubkey, e.signature, readFileSync(asset));
      } catch (err) {
        throw new Error(`${platform}: ${(err as Error).message}`);
      }
      const signed = signedVersion(trusted);
      if (signed !== o.version) throw new Error(`${platform}: signed for version ${signed ?? "(none)"}, not ${o.version}`);
      platforms[platform] = { signature: e.signature.trim(), url: e.url };
    }
    if (f.homerun) {
      if (homerun && JSON.stringify(homerun) !== JSON.stringify(f.homerun)) throw new Error("the fragments' homerun extensions disagree");
      homerun = f.homerun;
    }
  }
  if (Object.keys(platforms).length === 0) throw new Error("no signed platforms: publish without a latest.json");
  const pub_date = (o.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z");
  return { version: o.version, notes: o.notes ?? "", pub_date, platforms, ...(homerun ? { homerun } : {}) };
}

function flags(args: string[]): { opts: Map<string, string>; rest: string[] } {
  const opts = new Map<string, string>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      opts.set(a.slice(2), v);
    } else rest.push(a);
  }
  return { opts, rest };
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../../..");
  const [cmd, ...args] = process.argv.slice(2);
  try {
    const { opts, rest } = flags(args);
    const need = (k: string) => opts.get(k) ?? (() => { throw new Error(`--${k} is required`); })();
    if (cmd === "fragment") {
      const m = fragment(need("platform"), need("version"), need("url"), readFileSync(need("sig"), "utf8"));
      writeFileSync(need("out"), JSON.stringify(m, null, 2) + "\n");
    } else if (cmd === "merge") {
      if (rest.length === 0) throw new Error("no fragments");
      const m = merge({
        version: need("version"),
        fragments: rest.map((f) => JSON.parse(readFileSync(f, "utf8")) as Manifest),
        assetsDir: need("assets"),
        pubkey: configPubkey(root),
        notes: opts.get("notes"),
      });
      writeFileSync(need("out"), JSON.stringify(m, null, 2) + "\n");
      console.log(`latest.json ${m.version}: ${Object.keys(m.platforms).join(", ")}`);
    } else {
      throw new Error("usage: latest-json.ts fragment|merge …");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
