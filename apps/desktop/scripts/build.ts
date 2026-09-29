#!/usr/bin/env bun
/**
 * Build the webview bundle into dist/ (tauri.conf.json `frontendDist`). With --e2e, build the
 * browser entry that talks to the E2E bridge instead of Tauri (test/e2e/, plan §9).
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const e2e = process.argv.includes("--e2e");
const entry = e2e ? join(root, "test/e2e/index.html") : join(root, "index.html");
const outdir = e2e ? join(root, "test/e2e/dist") : join(root, "dist");

await rm(outdir, { recursive: true, force: true });
const r = await Bun.build({
  entrypoints: [entry],
  outdir,
  minify: !e2e,
  sourcemap: e2e ? "inline" : "none",
  target: "browser",
  define: { "process.env.NODE_ENV": JSON.stringify(e2e ? "development" : "production") },
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
const bytes = r.outputs.reduce((n, o) => n + o.size, 0);
console.log(`built ${r.outputs.length} files, ${(bytes / 1024).toFixed(0)} KB → ${outdir}`);
