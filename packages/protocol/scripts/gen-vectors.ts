/**
 * Writes vectors/*.json (everything but the vendored noise-cacophony.json) from fixed seeds.
 *   bun run scripts/gen-vectors.ts           write
 *   bun run scripts/gen-vectors.ts --check   fail if anything differs from what is committed
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAll } from "../src/vectors/build";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const check = process.argv.includes("--check");
const stale: string[] = [];
for (const [name, value] of Object.entries(buildAll())) {
  const path = join(DIR, name);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === content) continue;
  if (check) stale.push(name);
  else {
    writeFileSync(path, content);
    console.log(`wrote vectors/${name}`);
  }
}
if (stale.length > 0) {
  console.error(`stale vectors (run \`pnpm --filter @homerun/protocol vectors\`): ${stale.join(", ")}`);
  process.exit(1);
}
if (check) console.log("vectors are up to date");
