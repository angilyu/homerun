import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Canonical form of a path: realpath of its nearest existing ancestor, plus the rest. Symlinks
 * and `..` are resolved, so a path can't reach around a root or the denylist (§5.5, §13).
 */
export function canonicalPath(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(head.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    head = up;
  }
  try {
    head = realpathSync(head);
  } catch {
    // unreadable ancestor: compare lexically
  }
  return rest.length ? join(head, ...rest) : head;
}

/** `~` and `~/…` against a home directory; anything else unchanged. */
export function expandTilde(p: string, home: string): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}
