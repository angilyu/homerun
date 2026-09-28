import type { Content } from "@homerun/core";

/** Human output shows ids by their first 8 characters; arguments accept any unique prefix. */
export const shortId = (id: string) => id.slice(0, 8);

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  return [...s].length <= max ? s : [...s].slice(0, Math.max(0, max - 1)).join("") + "…";
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function usd(n: number | null): string {
  return n === null ? "" : `$${n.toFixed(4)}`;
}

/** A tool input on one line: a shell command as is, anything else as compact JSON. */
export function inputSummary(c: Content, max = 160): string {
  if (c.kind === "blob") return truncate(`${oneLine(c.preview)} [${bytes(c.size)}]`, max);
  const v = c.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "url", "pattern", "query"])
      if (typeof o[k] === "string" && Object.keys(o).length <= 3) return truncate(oneLine(o[k] as string), max);
  }
  return truncate(typeof v === "string" ? oneLine(v) : JSON.stringify(v), max);
}

/** The text of an output: a string as is, anything else as JSON. */
export function contentText(c: Content): string {
  if (c.kind === "blob") return c.preview;
  const v = c.value;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((p) => p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"))
    return v.map((p) => (p as { text: string }).text).join("\n");
  return JSON.stringify(v, null, 2);
}

/** At most `n` lines, each at most `width` characters, and how many lines were left out. */
export function headLines(text: string, n: number, width = 200): { lines: string[]; more: number } {
  const all = text.replace(/\n+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return { lines: [], more: 0 };
  return { lines: all.slice(0, n).map((l) => truncate(l, width)), more: Math.max(0, all.length - n) };
}

export function table(rows: string[][], widths?: number[]): string {
  if (!rows.length) return "";
  const cols = rows[0]!.length;
  const w = widths ?? Array.from({ length: cols }, (_, i) => Math.max(...rows.map((r) => visible(r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === cols - 1 ? cell : cell + " ".repeat(Math.max(0, w[i]! - visible(cell).length)))).join("  ").trimEnd()).join("\n") + "\n";
}

// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
