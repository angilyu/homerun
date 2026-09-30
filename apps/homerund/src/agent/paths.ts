import { existsSync, readdirSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * The file-system operations path checks need, and which path syntax applies. The host's by
 * default; tests pass a Windows flavour with a fake file system so the Windows rules run on any
 * OS (§5.5).
 */
export interface PathOps {
  flavor: "posix" | "win32";
  exists(p: string): boolean;
  realpath(p: string): string;
  readdir(p: string): string[];
}

export const hostPathOps: PathOps = {
  flavor: process.platform === "win32" ? "win32" : "posix",
  exists: existsSync,
  // On Windows the native realpath resolves junctions and symlinks and expands 8.3 short names
  // (`C:\PROGRA~1`), and returns the on-disk case.
  realpath: process.platform === "win32" ? (p) => realpathSync.native(p) : (p) => realpathSync(p),
  readdir: (p) => readdirSync(p),
};

export const pathApi = (ops: PathOps) => (ops.flavor === "win32" ? win32 : posix);

/**
 * A Windows path in the form the file system would open, lexically: the `\\?\` and `\??\`
 * prefixes and `\\.\` before a drive letter dropped, `/` as `\`, and in every component the
 * alternate-stream suffix (`id_rsa::$DATA` is `id_rsa`'s contents) and trailing dots and spaces
 * (which Win32 ignores) removed. UNC and other device paths come back as they are:
 * `isNetworkOrDevicePath` refuses them before anything touches the file system.
 */
export function normalizeWin(p: string): string {
  let s = p.replace(/\//g, "\\");
  if (/^\\\\\?\\UNC\\/i.test(s)) return `\\\\${s.slice(8)}`;
  s = s.replace(/^(\\\\\?\\|\\\?\?\\|\\\\\.\\)(?=[a-zA-Z]:)/, "");
  if (s.startsWith("\\\\")) return s;
  const m = /^([a-zA-Z]:)?(.*)$/.exec(s)!;
  const parts = m[2]!.split("\\").map((c) => {
    if (c === "." || c === "..") return c;
    const noStream = c.includes(":") ? c.slice(0, c.indexOf(":")) : c;
    const trimmed = noStream.replace(/[. ]+$/, "");
    return trimmed || noStream;
  });
  return (m[1] ?? "") + parts.join("\\");
}

/**
 * `\\server\share\…`, `\\?\UNC\…`, `\\.\pipe\…`, `\\?\GLOBALROOT\…`: nothing an agent's file
 * tool may name on Windows. Checked lexically, before any file-system call, since even resolving
 * such a path would connect to the server (and offer it the user's NTLM credentials).
 */
export function isNetworkOrDevicePath(p: string): boolean {
  return normalizeWin(p).startsWith("\\\\");
}

/**
 * `/c/Users/…` (MSYS, Git Bash) and `/cygdrive/c/…` as `C:\Users\…`, or null. Checked as an extra
 * form of a Windows path, since a tool may accept either.
 */
export function msysToWin(p: string): string | null {
  const m = /^[\\/](?:cygdrive[\\/])?([a-zA-Z])(?:[\\/](.*))?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}` : null;
}

/**
 * Canonical form of a path: realpath of its nearest existing ancestor, plus the rest. Symlinks,
 * junctions and `..` are resolved, so a path can't reach around a root or the denylist (§5.5,
 * §13). On Windows a network or device path is left alone (see `isNetworkOrDevicePath`).
 */
export function canonicalPath(p: string, ops: PathOps = hostPathOps): string {
  const P = pathApi(ops);
  if (ops.flavor === "win32") {
    if (isNetworkOrDevicePath(p)) return normalizeWin(p);
    p = normalizeWin(p);
  }
  let head = P.resolve(p);
  const rest: string[] = [];
  while (!ops.exists(head)) {
    const up = P.dirname(head);
    if (up === head) break;
    rest.unshift(head.slice(up.length + (up.endsWith(P.sep) ? 0 : 1)));
    head = up;
  }
  try {
    head = ops.realpath(head);
  } catch {
    // unreadable ancestor: compare lexically
  }
  return rest.length ? P.join(head, ...rest) : head;
}

/** `~` and `~/…` (and `~\…` on Windows) against a home directory; anything else unchanged. */
export function expandTilde(p: string, home: string, ops: Pick<PathOps, "flavor"> = hostPathOps): string {
  const P = ops.flavor === "win32" ? win32 : posix;
  if (p === "~") return home;
  if (p.startsWith("~/") || (ops.flavor === "win32" && p.startsWith("~\\"))) return P.join(home, p.slice(2));
  return p;
}
