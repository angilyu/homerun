// Compiles the phone's protocol self-test (every vector file the phone verifies, with @noble and
// the protocol code) to Hermes bytecode with the hermesc react-native ships. This catches syntax
// Hermes can't take, on Linux, per pull request. hermes-compiler has no VM, so running the vectors
// under Hermes is the nightly simulator job's (`-HomerunSelfTest 1`, ios.yml ios-sim).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "homerun-hermes-"));
try {
  const entry = join(dir, "entry.ts");
  writeFileSync(
    entry,
    `import { runSelfTest, selfTestLine } from ${JSON.stringify(join(here, "../src/selftest.ts"))};\n` +
      `void runSelfTest().then((r) => print(selfTestLine(r)));\n`,
  );
  const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", outdir: dir, naming: "vectors.js" });
  if (!built.success) throw new AggregateError(built.logs, "bundling the self-test failed");

  // hermes-compiler is react-native's dependency; resolve it from there.
  const rn = createRequire(createRequire(join(here, "../package.json")).resolve("react-native/package.json"));
  const bin = ({ darwin: "osx-bin", linux: "linux64-bin", win32: "win64-bin" } as Record<string, string>)[process.platform];
  if (!bin) throw new Error(`no hermesc for ${process.platform}`);
  const hermesc = join(dirname(rn.resolve("hermes-compiler/package.json")), "hermesc", bin, process.platform === "win32" ? "hermesc.exe" : "hermesc");

  const p = Bun.spawnSync([hermesc, "-emit-binary", "-Werror", "-out", join(dir, "vectors.hbc"), join(dir, "vectors.js")], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0) throw new Error(`hermesc failed (${p.exitCode})`);
  console.log(`hermesc: the self-test bundle (${Math.round(built.outputs[0]!.size / 1024)} KiB) compiles to Hermes bytecode`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
