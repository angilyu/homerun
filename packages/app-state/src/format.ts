import type { Content, ScheduleSpec, ToolClass } from "@homerun/core";

/**
 * Text for people: times, money, schedules, tool calls. `Intl` only, so every client formats the
 * same way (§9.8). Times take `now` so tests and previews are stable.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "$0.04", "$1.20", "<$0.01". */
export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`;
  if (d < DAY) return `${Math.floor(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** "in 12 min", "in 3 h", "in 2 days"; "now" once due. */
export function inTime(ts: number, now: number): string {
  const d = ts - now;
  if (d <= 30_000) return "now";
  if (d < HOUR) return `in ${Math.max(1, Math.round(d / MIN))} min`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    const m = Math.round((d - h * HOUR) / MIN);
    return m ? `in ${h} h ${m} min` : `in ${h} h`;
  }
  const days = Math.round(d / DAY);
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

/** "9:41", "Tue 9:41", "3 Mar 9:41" depending on distance from now, in `timeZone` (default: the device's). */
export function when(ts: number, now: number, timeZone?: string): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(ts);
  const day = (t: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(t);
  if (day(ts) === day(now)) return time;
  if (Math.abs(now - ts) < 6 * DAY) return `${new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone }).format(ts)} ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone }).format(ts)} ${time}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < MIN) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ${Math.round((ms % MIN) / 1000)} s`;
  return `${Math.floor(ms / HOUR)} h ${Math.round((ms % HOUR) / MIN)} min`;
}

/** "Every 15 minutes", "Every hour", "Cron 0 9 * * 1-5 (Europe/Paris)". */
export function scheduleText(s: ScheduleSpec): string {
  if (s.kind === "interval") {
    const m = s.every_minutes;
    if (m % (24 * 60) === 0) return m === 24 * 60 ? "Every day" : `Every ${m / (24 * 60)} days`;
    if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
    return m === 1 ? "Every minute" : `Every ${m} minutes`;
  }
  return `${cronText(s.cron)} (${s.timezone})`;
}

/** Common cron shapes in words; anything else as the expression. */
export function cronText(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const everyN = (f: string | undefined) => (f && /^\*\/\d+$/.test(f) ? Number(f.slice(2)) : null);
  const n = everyN(min);
  if (n && hour === "*" && dom === "*" && mon === "*" && dow === "*") return n === 1 ? "Every minute" : `Every ${n} minutes`;
  if (min && /^\d+$/.test(min) && hour && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
    const t = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    if (dow === "*") return `Every day at ${t}`;
    if (dow === "1-5") return `Weekdays at ${t}`;
  }
  if (min && /^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every hour at :${min.padStart(2, "0")}`;
  return `Cron ${cron}`;
}

export const CLASS_LABEL: Readonly<Record<ToolClass, string>> = {
  read: "Reads",
  write: "Writes",
  destructive: "Can't be undone",
  network: "Network",
};

/** The value of an inline input or output, or a blob's preview. */
export function contentValue(c: Content): unknown {
  return c.kind === "inline" ? c.value : c.preview;
}

/** A tool input on one line: the command, path, URL or query, else compact JSON. */
export function toolSummary(tool: string, input: Content, max = 120): string {
  if (input.kind === "blob") return truncate(oneLine(input.preview), max);
  const v = input.value;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["command", "file_path", "path", "url", "pattern", "query"]) if (typeof o[k] === "string") return truncate(oneLine(o[k] as string), max);
  }
  return truncate(typeof v === "string" ? oneLine(v) : JSON.stringify(v), max);
}

/** A tool input or output as readable text: a string as is, a shell result's output, else pretty JSON. */
export function contentText(c: Content): string {
  if (c.kind === "blob") return c.preview;
  const v = c.value;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.stdout === "string") return [o.stdout, typeof o.stderr === "string" ? o.stderr : ""].filter(Boolean).join("\n");
  }
  return JSON.stringify(v, null, 2);
}

/** Friendlier tool names: `mcp__github__create_issue` → "github · create_issue". */
export function toolName(tool: string): string {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return m ? `${m[1]} · ${m[2]}` : tool;
}
