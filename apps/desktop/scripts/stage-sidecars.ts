/**
 * Stage the helpers `tauri dev` bundles next to the shell (`externalBin`, §5.1):
 * a development-channel `homerund` compiled from source, and `claude` from the Agent SDK's
 * platform package in node_modules. No network. `--release` builds the release channel, which is
 * what scripts/macos/fetch-toolchain.sh (and so package.sh) stages for a bundle.
 *
 *   [HOMERUND_VERSION=x.y.z] bun scripts/stage-sidecars.ts [--release]
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findClaude } from "../../homerund/src/config";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(import.meta.dir, "..", "src-tauri", "binaries");
const TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`no sidecars for ${process.platform}-${process.arch}`);
const release = process.argv.includes("--release");

mkdirSync(OUT, { recursive: true });
const homerund = join(OUT, `homerund-${triple}`);
const main = join(ROOT, "apps", "homerund", "src", "main.ts");
// Release: no build define (a compiled binary defaults to the release channel), minified, and the
// app version when package.sh passes one.
const define = release
  ? ["--minify", ...(process.env.HOMERUND_VERSION ? ["--define", `HOMERUND_VERSION=${JSON.stringify(process.env.HOMERUND_VERSION)}`] : [])]
  : ["--define", `HOMERUND_BUILD="development"`];
// The release CLI trusts this process (§5.2): no bunfig.toml or .env from its working directory.
const noAutoload = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv"];
const t0 = Date.now();
const r = Bun.spawnSync([process.execPath, "build", "--compile", ...noAutoload, ...define, main, "--outfile", homerund], { stdout: "pipe", stderr: "pipe" });
if (r.exitCode !== 0) throw new Error(`building homerund failed:\n${r.stderr.toString()}`);

const claude = join(OUT, `claude-${triple}`);
const src = findClaude({});
if (!existsSync(claude) || statSync(claude).size !== statSync(src).size) copyFileSync(src, claude);
for (const f of [homerund, claude]) chmodSync(f, 0o755);
process.stderr.write(`staged ${release ? "release" : "development"} homerund and claude for ${triple} in ${Date.now() - t0} ms\n`);
