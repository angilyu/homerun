import { LOCAL_NOTIFICATION_BODY_MAX, LOCAL_NOTIFICATION_TITLE_MAX } from "@homerun/core";
import { scrub } from "../log";

/**
 * Text for a local notification (§8.2, §9.7). A notification shows on the lock screen and in
 * Notification Center, where anyone near the Mac can read it, so it carries one plain line:
 * no markup, no links, no control or bidirectional-override characters, and nothing the runtime
 * holds as a secret (§13). Model output (a monitor's report) may come from untrusted content,
 * so it gets the same treatment as everything else.
 */

/** Control characters, and the bidi overrides and isolates that can make text read backwards. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const URL = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;

/** Zero-width characters, dropped rather than spaced, so they can't split a secret past `redact`. */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

const redact = (s: string) => scrub(s).replace(/\[REDACTED\]/g, "…");

export function plainLine(text: string, max: number): string {
  // Redact before anything rewrites the text, and again after, so neither markup stripping nor
  // invisible characters can carry a secret through.
  let s = redact(text.replace(ZERO_WIDTH, "")).replace(INVISIBLE, " ");
  s = s.replace(MARKDOWN_LINK, "$1");
  s = s.replace(URL, " ");
  s = s.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "");
  s = s.replace(/[*_`~|]+/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return truncate(redact(s), max);
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join("").trimEnd() + "…";
}

export const title = (s: string | null | undefined, fallback = "Homerun") => plainLine(s ?? "", LOCAL_NOTIFICATION_TITLE_MAX) || fallback;
export const body = (s: string, max = LOCAL_NOTIFICATION_BODY_MAX) => plainLine(s, Math.min(max, LOCAL_NOTIFICATION_BODY_MAX));

/** The first non-empty line of a report, as the body of a "monitor reported" notification (§8.2). */
export function firstLine(text: string, max = 140): string {
  for (const line of text.split(/\r?\n/)) {
    const l = plainLine(line, max);
    if (l) return l;
  }
  return "";
}
