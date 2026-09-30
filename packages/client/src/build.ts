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

/**
 * Whether `meta.url` (the caller's `import.meta.url`) is inside a `bun build --compile`
 * executable: `/$bunfs/root/…` on POSIX, `B:\~BUN\root\…` on Windows. As a URL either may be
 * percent-encoded (`%24bunfs`, `%7EBUN`), so it is decoded first; a URL that won't decode is
 * matched on its encoded forms too.
 */
export function isCompiledUrl(url: string): boolean {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // Malformed escapes elsewhere in the URL: fall through to the raw checks.
  }
  const marked = (s: string) => s.includes("$bunfs") || s.includes("~BUN");
  return marked(decoded) || marked(url) || /%24bunfs|%7[eE]BUN/.test(url);
}

/**
 * Whether this process is a `bun build --compile` executable: the caller's module URL, or
 * `Bun.main`, or `process.argv[1]` is inside the embedded file system, or the executable isn't
 * `bun` at all (running from source needs the bun binary; a compiled program is its own
 * executable). More than one signal, so a platform that reports one of them differently still
 * fails closed, to release.
 */
export function runningCompiled(
  metaUrl: string,
  main: string = typeof Bun === "undefined" ? "" : Bun.main,
  argv1: string = process.argv[1] ?? "",
  execPath: string = process.execPath,
): boolean {
  const exe = execPath.split(/[\\/]/).pop() ?? "";
  return isCompiledUrl(metaUrl) || isCompiledUrl(main) || isCompiledUrl(argv1) || !/^bun(\.exe)?$/i.test(exe);
}
