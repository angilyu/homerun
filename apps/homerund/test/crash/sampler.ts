import { createHash } from "node:crypto";

/**
 * Which boundaries a crash sweep kills at (§16.2).
 *
 * - `full` (the default): every boundary.
 * - `sample` (CI on every pull request and push): the first and last boundary, one boundary of
 *   every kind (`boundaries.ts`), and random others up to a budget. The draw comes from a seed:
 *   `HOMERUN_CRASH_SEED`, else `GITHUB_SHA`, else the time. So each commit tries a different
 *   subset, and the printed seed reproduces a failing one exactly.
 * - `exhaustive`: `full`, and a second crash during recovery after every first crash, not only
 *   those that left a call ambiguous.
 *
 * The nightly workflow runs `full` on main.
 */
export type SweepMode = "sample" | "full" | "exhaustive";

export function sweepMode(env: Record<string, string | undefined> = process.env): SweepMode {
  const v = env.HOMERUN_CRASH_SWEEP || "full";
  if (v !== "sample" && v !== "full" && v !== "exhaustive") throw new Error(`HOMERUN_CRASH_SWEEP must be sample, full or exhaustive, not ${JSON.stringify(v)}`);
  return v;
}

export function crashSeed(env: Record<string, string | undefined> = process.env): string {
  return env.HOMERUN_CRASH_SEED || env.GITHUB_SHA || String(Date.now());
}

/** A seeded stream of numbers in [0, 1); `stream` keeps each sweep's draws independent of the others. */
export function random(seed: string, stream: string): () => number {
  let a = createHash("sha256").update(`${seed}\u0000${stream}`).digest().readUInt32LE(0);
  // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface SampleOptions {
  mode: SweepMode;
  seed: string;
  /** Names this draw, e.g. `serial/kill`. */
  stream: string;
  /** How many boundaries to take, unless the required ones alone are more. */
  budget: number;
}

/**
 * The 1-based boundaries to crash at, ascending, given each boundary's kind (`kinds[k - 1]`).
 * Always the first and the last, and one of each kind (a random one of it); then random others
 * until `budget`. Every boundary unless the mode is `sample`.
 */
export function sampleBoundaries(kinds: readonly string[], o: SampleOptions): number[] {
  const n = kinds.length;
  const all = Array.from({ length: n }, (_, i) => i + 1);
  if (o.mode !== "sample" || n === 0) return all;
  const rnd = random(o.seed, o.stream);
  const chosen = new Set<number>([1, n]);
  const byKind = new Map<string, number[]>();
  kinds.forEach((kind, i) => byKind.set(kind, [...(byKind.get(kind) ?? []), i + 1]));
  for (const kind of [...byKind.keys()].sort()) {
    const ks = byKind.get(kind)!;
    if (!ks.some((k) => chosen.has(k))) chosen.add(ks[Math.floor(rnd() * ks.length)]!);
  }
  for (const k of shuffle(all, rnd)) {
    if (chosen.size >= o.budget) break;
    chosen.add(k);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Up to `count` of `items`, in their order: all of them unless the mode is `sample`. */
export function sampleItems<T>(items: readonly T[], count: number, o: Omit<SampleOptions, "budget">): T[] {
  if (o.mode !== "sample" || items.length <= count) return [...items];
  const keep = new Set(shuffle(items.map((_, i) => i), random(o.seed, o.stream)).slice(0, count));
  return items.filter((_, i) => keep.has(i));
}
