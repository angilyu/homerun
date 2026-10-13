#!/usr/bin/env bun
/**
 * The desktop app's one version (design §11, §18 row 141). tauri.conf.json is the source of truth;
 * the shell's Cargo manifests, Cargo.lock and apps/desktop/package.json carry the same number.
 *
 *   bun apps/desktop/scripts/release/bump-version.ts                 print it (fails if the files disagree)
 *   bun apps/desktop/scripts/release/bump-version.ts 0.2.0           set it everywhere
 *   bun apps/desktop/scripts/release/bump-version.ts --check v0.2.0  fail unless every file says 0.2.0
 *
 * The edits are textual, so formatting and key order are kept. Other packages version
 * independently; the release bakes this version into homerund and the CLI (HOMERUND_VERSION,
 * HOMERUN_CLI_VERSION).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

type Place = { file: string; read(text: string): string | null; write(text: string, v: string): string };

const topLevelJson: Pick<Place, "read" | "write"> = {
  read: (t) => /^ {2}"version": "([^"]*)"/m.exec(t)?.[1] ?? null,
  write: (t, v) => t.replace(/^( {2}"version": ")[^"]*(")/m, `$1${v}$2`),
};
const cargoPackage: Pick<Place, "read" | "write"> = {
  read: (t) => /^\[package\]\n(?:[^[\n].*\n|\n)*?version = "([^"]*)"/m.exec(t)?.[1] ?? null,
  write: (t, v) => t.replace(/^(\[package\]\n(?:[^[\n].*\n|\n)*?version = ")[^"]*(")/m, `$1${v}$2`),
};
const lockEntry = (name: string): Pick<Place, "read" | "write"> => ({
  read: (t) => new RegExp(`^name = "${name}"\\nversion = "([^"]*)"`, "m").exec(t)?.[1] ?? null,
  write: (t, v) => t.replace(new RegExp(`^(name = "${name}"\\nversion = ")[^"]*(")`, "m"), `$1${v}$2`),
});

export const PLACES: readonly Place[] = [
  { file: "apps/desktop/src-tauri/tauri.conf.json", ...topLevelJson },
  { file: "apps/desktop/package.json", ...topLevelJson },
  { file: "apps/desktop/src-tauri/Cargo.toml", ...cargoPackage },
  { file: "apps/desktop/src-tauri/shell-core/Cargo.toml", ...cargoPackage },
  { file: "apps/desktop/src-tauri/Cargo.lock", ...lockEntry("homerun") },
  { file: "apps/desktop/src-tauri/Cargo.lock", ...lockEntry("homerun-shell-core") },
];

/** "v1.2.3" or "1.2.3" → "1.2.3"; anything that isn't semver → null. */
export function parseVersion(s: string): string | null {
  const v = s.startsWith("v") ? s.slice(1) : s;
  return SEMVER.test(v) ? v : null;
}

/** Every place's version, in order; throws if one can't be found. */
export function readAll(root: string): { file: string; version: string }[] {
  return PLACES.map((p) => {
    const version = p.read(readFileSync(join(root, p.file), "utf8"));
    if (version === null) throw new Error(`no version found in ${p.file}`);
    return { file: p.file, version };
  });
}

/** The one version, or an error naming the files that disagree with tauri.conf.json. */
export function current(root: string): string {
  const all = readAll(root);
  const want = all[0]!.version;
  const off = all.filter((x) => x.version !== want);
  if (off.length) throw new Error(`versions disagree with tauri.conf.json (${want}): ${off.map((x) => `${x.file} ${x.version}`).join(", ")}`);
  return want;
}

export function setAll(root: string, version: string): void {
  if (parseVersion(version) !== version) throw new Error(`not a semantic version: ${version}`);
  const texts = new Map<string, string>();
  for (const p of PLACES) {
    const text = texts.get(p.file) ?? readFileSync(join(root, p.file), "utf8");
    if (p.read(text) === null) throw new Error(`no version found in ${p.file}`);
    texts.set(p.file, p.write(text, version));
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text);
  current(root);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../../..");
  const args = process.argv.slice(2);
  try {
    if (args.length === 0) {
      console.log(current(root));
    } else if (args[0] === "--check" && args.length === 2) {
      const want = parseVersion(args[1]!);
      if (!want) throw new Error(`not a version or v-tag: ${args[1]}`);
      const have = current(root);
      if (have !== want) throw new Error(`the files say ${have}, not ${want}: run bump-version.ts ${want} and commit before tagging`);
      console.log(have);
    } else if (args.length === 1 && !args[0]!.startsWith("-")) {
      const v = parseVersion(args[0]!);
      if (!v) throw new Error(`not a semantic version: ${args[0]}`);
      setAll(root, v);
      console.log(v);
    } else {
      throw new Error("usage: bump-version.ts [VERSION | --check vVERSION]");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
