import type { BuildChannel } from "@homerun/core";

/**
 * The build channel fails closed. A compiled executable is release unless it was built with an
 * explicit development define, so a binary that forgot the define never gets development
 * switches or dev tokens. Running from source (`bun run`, `bun test`) is development. Any other
 * defined value is release.
 */
export function resolveBuildChannel(defined: string | undefined, compiled: boolean): BuildChannel {
  if (defined !== undefined) return defined === "development" ? "development" : "release";
  return compiled ? "release" : "development";
}

/** Whether `meta.url` (the caller's `import.meta.url`) is inside a `bun build --compile` executable. */
export function isCompiledUrl(url: string): boolean {
  return url.includes("$bunfs") || url.includes("~BUN");
}
