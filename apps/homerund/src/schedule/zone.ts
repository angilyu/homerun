/**
 * Wall-clock arithmetic in an IANA timezone, through Intl only. Nothing here reads the device's
 * own timezone, so a travelling laptop never shifts a schedule (§8).
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Offsets are cached per hour. An hour with a transition inside is never cached. */
const BUCKET = 60 * MINUTE;
const CACHE_MAX = 50_000;

const formats = new Map<string, Intl.DateTimeFormat>();
const cache = new Map<string, number | null>();

function format(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(zone, f);
  }
  return f;
}

function exactOffset(zone: string, at: number): number {
  const p: Record<string, number> = {};
  for (const part of format(zone).formatToParts(new Date(at))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour === 24 ? 0 : p.hour!, p.minute!, p.second!);
  return wall - Math.floor(at / 1000) * 1000;
}

/** The zone's UTC offset at instant `at`, in ms (local = at + offset). */
export function offsetAt(zone: string, at: number): number {
  const b = Math.floor(at / BUCKET);
  const key = `${zone}|${b}`;
  let v = cache.get(key);
  if (v === undefined) {
    const start = exactOffset(zone, b * BUCKET);
    const end = exactOffset(zone, b * BUCKET + BUCKET - 1000);
    v = start === end ? start : null;
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, v);
  }
  return v ?? exactOffset(zone, at);
}

export interface LocalTime {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0–6, Sunday = 0 */
  weekday: number;
}

/** The wall-clock time in `zone` at instant `at`. */
export function localTime(zone: string, at: number): LocalTime {
  const d = new Date(at + offsetAt(zone, at));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD` in `zone` at instant `at`. */
export function localDay(zone: string, at: number): string {
  const t = localTime(zone, at);
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

/** `HH:MM` in `zone` at instant `at`. */
export function localClock(zone: string, at: number): string {
  const t = localTime(zone, at);
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

/**
 * The instant a wall-clock time happens in `zone`, by the rules of §8:
 * - a time that occurs twice (the fall-back overlap) resolves to its first occurrence;
 * - a time that does not exist (the spring-forward gap) resolves to the first valid instant
 *   after it, which is the transition itself.
 * `wall` is the wall-clock time written as if it were UTC (`Date.UTC(y, m - 1, d, h, mi)`).
 */
export function resolveWall(zone: string, wall: number): number {
  const before = offsetAt(zone, wall - DAY);
  const after = offsetAt(zone, wall + DAY);
  let best: number | null = null;
  for (const o of before === after ? [before] : [before, after]) {
    const u = wall - o;
    if (offsetAt(zone, u) === o && (best === null || u < best)) best = u;
  }
  if (best !== null) return best;
  // In the gap: the answer is the transition, the first instant whose offset is `after`.
  let lo = wall - before - DAY;
  let hi = wall - before + DAY;
  if (offsetAt(zone, lo) === after || offsetAt(zone, hi) !== after) return wall - after;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000;
    if (offsetAt(zone, mid) === after) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The instant a local day (`YYYY-MM-DD`) starts in `zone`. */
export function dayStartInstant(zone: string, day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return resolveWall(zone, Date.UTC(y, m - 1, d));
}

/** The next local day, `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
