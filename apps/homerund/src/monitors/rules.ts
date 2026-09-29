import { createHash } from "node:crypto";
import { jsonByteLength, type CheckResult, type JsonValue } from "@homerun/core";
import { itemsWithId, SourceError, type Observation, type RuleCheck } from "./sources";

/** A value is kept in state, for "changed from … to …" evidence, only up to this size. */
const KEEP_VALUE_BYTES = 8 * 1024;
/** `new_items` remembers ids up to about this many bytes; the oldest are forgotten first. */
const SEEN_MAX_BYTES = 48 * 1024;
const PREVIEW_CHARS = 300;

type Normalize = RuleCheck["normalize"];

/**
 * A rule check's verdict (§8.3), with no model call. The first run with no saved state records a
 * baseline and reports nothing, except the threshold comparators (`equals`, `above`, `below`),
 * which report when the condition holds. Those are edge-triggered: they report when the condition
 * becomes true, not on every run while it stays true.
 */
export function evaluateRule(check: RuleCheck, prev: JsonValue | null, obs: Observation): CheckResult {
  const value = normalize(obs.value, check.normalize);
  const c = check.comparator;
  switch (c.op) {
    case "changed": {
      const hash = hashOf(value);
      const state: JsonValue = jsonByteLength(value) <= KEEP_VALUE_BYTES ? { hash, value } : { hash };
      const old = asObject(prev);
      if (!old || typeof old.hash !== "string") return { changed: false, evidence: `Baseline recorded: ${preview(value)}`, new_state: state };
      if (old.hash === hash) return { changed: false, evidence: `Unchanged: ${preview(value)}`, new_state: state };
      const was = "value" in old ? ` (was ${preview(old.value ?? null)})` : "";
      return { changed: true, evidence: `Changed to ${preview(value)}${was}`, new_state: state };
    }
    case "equals":
    case "above":
    case "below": {
      const matched = c.op === "equals" ? hashOf(value) === hashOf(normalize(c.value, check.normalize)) : compare(c.op, numberOf(value), c.value);
      const before = asObject(prev)?.matched === true;
      const state: JsonValue = { matched, value: jsonByteLength(value) <= KEEP_VALUE_BYTES ? value : null };
      const what = c.op === "equals" ? `equals ${preview(c.value)}` : `is ${c.op} ${c.value}`;
      if (matched && !before) return { changed: true, evidence: `The value ${preview(value)} now ${what}.`, new_state: state };
      if (matched) return { changed: false, evidence: `The value ${preview(value)} still ${what}; already reported.`, new_state: state };
      return { changed: false, evidence: `The value ${preview(value)} ${c.op === "equals" ? "does not equal" : `is not ${c.op}`} ${c.op === "equals" ? preview(c.value) : c.value}.`, new_state: state };
    }
    case "new_items": {
      const items = itemsWithId({ ...obs, value }, c.id_field);
      if (!items) throw new SourceError("source_unreadable", "The source did not give a list of items.");
      const ids = items.map((i) => normalizeText(i.id, check.normalize));
      const old = asObject(prev);
      const seenBefore = old && Array.isArray(old.seen) ? old.seen.filter((x): x is string => typeof x === "string") : null;
      const seen = capSeen([...new Set([...ids, ...(seenBefore ?? [])])]);
      if (!seenBefore) return { changed: false, evidence: `Baseline recorded: ${items.length} item${items.length === 1 ? "" : "s"}.`, new_state: { seen } };
      const known = new Set(seenBefore);
      const fresh = items.filter((_, i) => !known.has(ids[i]!));
      if (fresh.length === 0) return { changed: false, evidence: `No new items among ${items.length}.`, new_state: { seen } };
      const list = fresh
        .slice(0, 20)
        .map((i) => `- ${clip(i.title, 200)}`)
        .join("\n");
      const more = fresh.length > 20 ? `\n…and ${fresh.length - 20} more` : "";
      return { changed: true, evidence: `${fresh.length} new item${fresh.length === 1 ? "" : "s"}:\n${list}${more}`, new_state: { seen } };
    }
  }
}

function normalizeText(s: string, n: Normalize): string {
  if (!n) return s;
  let out = s;
  if (n.collapse_whitespace) out = out.replace(/\s+/g, " ");
  if (n.trim) out = out.trim();
  if (n.lowercase) out = out.toLowerCase();
  return out;
}

function normalize(v: JsonValue, n: Normalize): JsonValue {
  if (!n) return v;
  if (typeof v === "string") return normalizeText(v, n);
  if (Array.isArray(v)) return v.map((x) => normalize(x, n));
  return v;
}

function compare(op: "above" | "below", v: number, limit: number): boolean {
  return op === "above" ? v > limit : v < limit;
}

function numberOf(v: JsonValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // "$1,299.00", "1 299", "USD 12": drop grouping and a leading currency, then parse strictly.
    const t = v.replace(/[,\s]/g, "").replace(/^[^\d+\-.]+/, "");
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  }
  throw new SourceError("source_unreadable", `Expected a number, got ${preview(v)}.`);
}

function asObject(v: JsonValue | null): Record<string, JsonValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** JSON with sorted keys, so equal values hash equally. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function hashOf(v: JsonValue): string {
  return createHash("sha256").update(stableJson(v)).digest("hex");
}

function capSeen(ids: string[]): string[] {
  let bytes = 2;
  const out: string[] = [];
  for (const id of ids) {
    bytes += Buffer.byteLength(JSON.stringify(id)) + 1;
    if (bytes > SEEN_MAX_BYTES) break;
    out.push(id);
  }
  return out;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function preview(v: JsonValue): string {
  return clip(typeof v === "string" ? JSON.stringify(v) : stableJson(v), PREVIEW_CHARS);
}
