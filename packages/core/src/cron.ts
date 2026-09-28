/**
 * Strict validator for 5-field cron expressions (minute hour day-of-month month day-of-week).
 * Validation only; computing fire times, including the DST rules of §8, is the scheduler's job
 * (milestone 5).
 *
 * Accepted: `*`, numbers, ranges `a-b`, steps `*\/n`, `a-b/n` and `a/n`, comma lists, month
 * names JAN–DEC and weekday names SUN–SAT (case-insensitive), day-of-week 0–7 (0 and 7 are
 * Sunday), and the macros `@hourly @daily @midnight @weekly @monthly @yearly @annually`.
 * Rejected: seconds or year fields, `? L W #`, `@reboot`, extra whitespace, and expressions
 * that can never fire (such as `0 0 30 2 *`).
 *
 * When both day-of-month and day-of-week are restricted, a day matches if either does
 * (Vixie cron semantics).
 */

export const CRON_MACROS: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

/** Coarse shape, exported into JSON Schema. The full grammar is in `parseCron`. */
export const CRON_SHAPE_PATTERN = /^(@(hourly|daily|midnight|weekly|monthly|yearly|annually)|\S+( \S+){4})$/;

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  namesBase?: number;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesBase: 1 },
  { name: "day-of-week", min: 0, max: 7, names: DAYS, namesBase: 0 },
];

export interface CronFields {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  /** 0–6, Sunday = 0 (7 is folded into 0). */
  dayOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export type CronParseResult = { ok: true; fields: CronFields } | { ok: false; error: string };

function parseValue(raw: string, f: FieldSpec): number | string {
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n < f.min || n > f.max) return `${f.name}: ${n} is outside ${f.min}-${f.max}`;
    return n;
  }
  if (f.names) {
    const i = f.names.indexOf(raw.toUpperCase() as never);
    if (i >= 0) return i + (f.namesBase ?? 0);
  }
  return `${f.name}: invalid value "${raw}"`;
}

function parseField(raw: string, f: FieldSpec): Set<number> | string {
  const out = new Set<number>();
  for (const item of raw.split(",")) {
    if (item === "") return `${f.name}: empty list item`;
    const [rangePart, stepPart, ...rest] = item.split("/");
    if (rest.length > 0 || rangePart === undefined) return `${f.name}: invalid step in "${item}"`;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) return `${f.name}: invalid step "${stepPart}"`;
      step = Number(stepPart);
      if (step > f.max - f.min + 1) return `${f.name}: step ${step} is larger than the field`;
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = f.min;
      hi = f.max;
    } else {
      const bounds = rangePart.split("-");
      if (bounds.length > 2 || bounds.some((b) => b === "")) return `${f.name}: invalid range "${rangePart}"`;
      const a = parseValue(bounds[0]!, f);
      if (typeof a === "string") return a;
      lo = a;
      if (bounds.length === 2) {
        const b = parseValue(bounds[1]!, f);
        if (typeof b === "string") return b;
        hi = b;
        if (hi < lo) return `${f.name}: range ${lo}-${hi} is backwards`;
      } else hi = stepPart !== undefined ? f.max : lo;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function parseCron(expr: string): CronParseResult {
  if (typeof expr !== "string") return { ok: false, error: "not a string" };
  if (expr.startsWith("@")) {
    const m = CRON_MACROS[expr];
    if (!m) return { ok: false, error: `unsupported macro ${expr}` };
    return parseCron(m);
  }
  const parts = expr.split(" ");
  if (parts.length !== 5 || parts.some((p) => p === "")) {
    return { ok: false, error: "expected exactly 5 fields separated by single spaces" };
  }
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i]!, FIELDS[i]!);
    if (typeof r === "string") return { ok: false, error: r };
    sets.push(r);
  }
  const [minute, hour, dom, month, dowRaw] = sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  const dow = new Set([...dowRaw].map((d) => d % 7));
  const domRestricted = parts[2] !== "*" && !parts[2]!.startsWith("*/");
  const dowRestricted = parts[4] !== "*" && !parts[4]!.startsWith("*/");

  // A day-of-month-only schedule must name a day that exists in at least one selected month.
  if (domRestricted && !dowRestricted) {
    const longest = Math.max(...[...month].map((m) => DAYS_IN_MONTH[m - 1]!));
    if (![...dom].some((d) => d <= longest)) return { ok: false, error: "day-of-month never occurs in the selected months" };
  }
  return {
    ok: true,
    fields: { minute, hour, dayOfMonth: dom, month, dayOfWeek: dow, dayOfMonthRestricted: domRestricted, dayOfWeekRestricted: dowRestricted },
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr).ok;
}
