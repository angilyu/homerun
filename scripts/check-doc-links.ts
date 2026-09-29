#!/usr/bin/env bun
/**
 * Fails if a relative link or #anchor in a tracked Markdown file does not resolve.
 * Anchors follow GitHub's heading slugs: lowercase, punctuation dropped (except `-` and `_`),
 * spaces turned into `-`, and `-1`, `-2`, … appended to repeated headings.
 * External links (any `scheme:`) are not checked. Usage: bun scripts/check-doc-links.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const FENCE = /^\s*(```|~~~)/;
const anchorCache = new Map<string, Set<string>>();

/** Lines outside fenced code blocks, with their 1-based line numbers. */
function proseLines(text: string): [number, string][] {
  const out: [number, string][] = [];
  let inFence = false;
  text.split("\n").forEach((line, i) => {
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence) out.push([i + 1, line]);
  });
  return out;
}

function anchors(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const text = readFileSync(file, "utf8");
  const set = new Set<string>();
  const seen = new Map<string, number>();
  for (const [, line] of proseLines(text)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    set.add(n ? `${slug}-${n}` : slug);
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]!);
  anchorCache.set(file, set);
  return set;
}

let checked = 0;
let broken = 0;
for (const file of files) {
  const abs = join(root, file);
  for (const [lineNo, line] of proseLines(readFileSync(abs, "utf8"))) {
    const withoutCode = line.replace(/`[^`]*`/g, "");
    for (const m of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      checked++;
      const [path, anchor] = href.split("#", 2) as [string, string | undefined];
      const target = path ? resolve(dirname(abs), decodeURI(path)) : abs;
      if (!existsSync(target)) {
        broken++;
        console.log(`${file}:${lineNo}: missing file: ${href}`);
      } else if (anchor && target.endsWith(".md") && statSync(target).isFile()) {
        if (!anchors(target).has(decodeURIComponent(anchor))) {
          broken++;
          console.log(`${file}:${lineNo}: missing anchor: ${href}`);
        }
      }
    }
  }
}

console.log(`${checked} relative links checked in ${files.length} files, ${broken} broken`);
process.exit(broken ? 1 : 0);
