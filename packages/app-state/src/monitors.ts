import type { Downtime, HealthDigest, MonitorHealth, ScheduleCoverage } from "@homerun/core";

/**
 * Monitor coverage and health for display (§8.3, §8.4): the week's numbers in one sentence, the
 * low-coverage suggestion, and the digest's downtime.
 */

export const COVERAGE_DAYS = 7;
/** Below this weekly share of on-time checks, suggest a fix once (§8.4). */
export const LOW_COVERAGE = 0.5;

/** `YYYY-MM-DD` of an instant in a zone. */
export function dayIn(zone: string, at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** The last seven days in the schedule's zone, today included (`schedules.coverage`). */
export function coverageRange(zone: string, now: number): { from_day: string; to_day: string; days: string[] } {
  const days: string[] = [];
  const seen = new Set<string>();
  // Walk back in 12-hour steps so DST days are neither skipped nor doubled.
  for (let t = now; days.length < COVERAGE_DAYS; t -= 12 * 3600_000) {
    const d = dayIn(zone, t);
    if (!seen.has(d)) {
      seen.add(d);
      days.unshift(d);
    }
  }
  return { from_day: days[0]!, to_day: days.at(-1)!, days };
}

export interface CoverageDay {
  day: string;
  expected: number;
  ran: number;
  asleep: number;
  not_running: number;
  merged: number;
  /** Slots still to come today, or not accounted for yet. */
  other: number;
}

export interface CoverageSummary {
  days: CoverageDay[];
  expected: number;
  ran: number;
  asleep: number;
  not_running: number;
  merged: number;
  /** ran / expected, or null with nothing expected. */
  share: number | null;
  sentence: string;
  /** Suggest the energy setting or an always-on machine (§8.4). */
  low: boolean;
}

export function summarizeCoverage(rows: readonly ScheduleCoverage[], days: readonly string[]): CoverageSummary {
  const byDay = new Map<string, CoverageDay>();
  for (const d of days) byDay.set(d, { day: d, expected: 0, ran: 0, asleep: 0, not_running: 0, merged: 0, other: 0 });
  for (const r of rows) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.expected += r.expected;
    d.ran += r.ran;
    d.asleep += r.missed_asleep;
    d.not_running += r.missed_not_running;
    d.merged += r.merged;
  }
  const list = [...byDay.values()];
  for (const d of list) d.other = Math.max(0, d.expected - d.ran - d.asleep - d.not_running - d.merged);
  const sum = (k: keyof Omit<CoverageDay, "day">) => list.reduce((n, d) => n + d[k], 0);
  const expected = sum("expected");
  const ran = sum("ran");
  const asleep = sum("asleep");
  const not_running = sum("not_running");
  const merged = sum("merged");
  const share = expected > 0 ? ran / expected : null;
  return { days: list, expected, ran, asleep, not_running, merged, share, sentence: coverageSentence(ran, expected, asleep, not_running, merged), low: share !== null && share < LOW_COVERAGE };
}

const n = (x: number) => new Intl.NumberFormat("en-US").format(x);

/** "Ran 212 of 2,016 scheduled checks this week (11%). Your Mac was asleep for most of the rest." (§8.4) */
export function coverageSentence(ran: number, expected: number, asleep: number, notRunning: number, merged: number): string {
  if (expected === 0) return "No checks were scheduled this week.";
  const pct = Math.round((ran / expected) * 100);
  const head = `Ran ${n(ran)} of ${n(expected)} scheduled checks this week (${pct}%).`;
  const missed = expected - ran;
  if (missed === 0) return head;
  const biggest = Math.max(asleep, notRunning, merged);
  if (biggest === 0) return head;
  const most = biggest * 2 > missed ? "most of" : "some of";
  if (biggest === asleep) return `${head} Your Mac was asleep for ${most} the rest.`;
  if (biggest === notRunning) return `${head} Homerun wasn't running for ${most} the rest.`;
  return `${head} ${most === "most of" ? "Most" : "Some"} of the rest were merged because a check was still running.`;
}

export interface DigestLine {
  task_id: string;
  name: string;
  text: string;
  attention: boolean;
}

/** One line per monitor: "12 checks, 1 change, 2 missed while asleep · $0.03". */
export function digestLines(d: HealthDigest): DigestLine[] {
  return d.monitors.map((m) => ({ task_id: m.task_id, name: m.name, text: monitorHealthText(m), attention: m.needs_attention }));
}

export function monitorHealthText(m: MonitorHealth): string {
  const parts: string[] = [];
  const plural = (k: number, one: string, many = `${one}s`) => `${n(k)} ${k === 1 ? one : many}`;
  parts.push(plural(m.succeeded + m.failed, "check"));
  if (m.changes) parts.push(plural(m.changes, "change"));
  if (m.failed) parts.push(`${n(m.failed)} failed`);
  if (m.missed_asleep) parts.push(`${n(m.missed_asleep)} missed while asleep`);
  if (m.missed_not_running) parts.push(`${n(m.missed_not_running)} missed while Homerun wasn't running`);
  if (m.skipped) parts.push(`${n(m.skipped)} merged`);
  if (m.caught_up) parts.push(`${n(m.caught_up)} caught up late`);
  if (!m.enabled) parts.push(m.paused_reason === "failures" ? "paused after failures" : m.paused_reason === "budget_cap" ? "paused at its budget" : "paused");
  return parts.join(", ");
}

/** "Asleep 1:00–7:40", in the digest's zone. */
export function downtimeText(d: Downtime, zone: string): string {
  const f = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: zone });
  const what = d.cause === "asleep" ? "Mac asleep" : "Homerun not running";
  return `${what} ${f.format(d.start_at)}–${f.format(d.end_at)}`;
}

/** The last 24 hours, for the health screen. */
export function lastDay(now: number): { from: number; to: number } {
  return { from: now - 24 * 3600_000, to: now };
}
