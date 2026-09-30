/**
 * Milestone 8b probe P8: what a `bun build --compile` executable reports about itself, and
 * whether `runningCompiled` sees it (the build channel fails closed on it). Round 3 found a
 * plain compiled homerund on Windows running as a development build.
 *
 *   bun build --compile spikes/windows-probe/compiled.ts --outfile <exe> && <exe>
 */
import { isCompiledUrl, runningCompiled } from "../../packages/client/src/build";

console.log(
  JSON.stringify({
    metaUrl: import.meta.url,
    metaPath: import.meta.path,
    main: Bun.main,
    argv: process.argv.slice(0, 2),
    execPath: process.execPath,
    isCompiledUrl: isCompiledUrl(import.meta.url),
    runningCompiled: runningCompiled(import.meta.url),
  }),
);
