import { describe, expect, test } from "bun:test";
import { crashSeed, random, sampleBoundaries, sampleItems, sweepMode } from "../crash/sampler";

// A sweep's boundary kinds, shaped like a real one: a few kinds that recur and some that occur once.
const KINDS = [
  "commit:startup",
  "commit:runs",
  "commit:user.message+runs",
  "commit:runs",
  "commit:sdk_transcripts",
  "commit:tool.call+threads",
  "tool:before_effect",
  "tool:after_effect",
  "commit:tool.result+threads",
  "commit:sdk_transcripts",
  "commit:tool.call+threads",
  "tool:before_effect",
  "tool:after_effect",
  "commit:tool.result+threads",
  "commit:sdk_transcripts",
  "commit:runs",
  "commit:none",
  "commit:none",
  "commit:message.final+threads",
  "commit:sdk_transcripts",
  "commit:tool.call+threads",
  "tool:before_effect",
  "tool:after_effect",
  "commit:tool.result+threads",
  "commit:runs",
  "commit:run.end+runs",
  "commit:runtime_lives",
  "commit:runtime_lives",
];
const sample = (seed: string, budget: number, stream = "serial/kill", kinds = KINDS) => sampleBoundaries(kinds, { mode: "sample", seed, stream, budget });

describe("crash sweep sampling (§16.2)", () => {
  test("the same seed and stream draw the same boundaries", () => {
    expect(sample("abc", 12)).toEqual(sample("abc", 12));
    expect(sample("abc", 12, "serial/die")).toEqual(sample("abc", 12, "serial/die"));
    const draws = new Set(["a", "b", "c", "d", "e", "f"].map((s) => sample(s, 12).join()));
    expect(draws.size).toBeGreaterThan(1);
    expect(sample("abc", 12, "serial/kill").join()).not.toBe(sample("abc", 12, "parallel/kill").join());
    const r = random("abc", "x");
    const s = random("abc", "x");
    for (let i = 0; i < 5; i++) expect(r()).toBe(s());
  });

  test("always the first and last boundary and one of every kind", () => {
    for (const seed of Array.from({ length: 50 }, (_, i) => `seed-${i}`)) {
      for (const budget of [0, 5, 12]) {
        const ks = sample(seed, budget);
        expect(ks[0]).toBe(1);
        expect(ks.at(-1)).toBe(KINDS.length);
        expect(new Set(ks.map((k) => KINDS[k - 1]))).toEqual(new Set(KINDS));
        expect(ks).toEqual([...new Set(ks)].sort((a, b) => a - b));
      }
    }
  });

  test("takes the budget, unless the required boundaries alone are more", () => {
    // One of every kind: the first and last boundaries are the only ones of theirs.
    for (const seed of ["a", "b", "c"]) expect(sample(seed, 0)).toHaveLength(new Set(KINDS).size);
    for (const budget of [15, 20, 25]) expect(sample("abc", budget)).toHaveLength(budget);
    expect(sample("abc", 1000)).toHaveLength(KINDS.length);
    const one = Array.from({ length: 40 }, () => "commit:runs");
    expect(sample("abc", 10, "s", one)).toHaveLength(10);
    expect(sample("abc", 0, "s", one)).toEqual([1, 40]);
  });

  test("full and exhaustive take every boundary", () => {
    const all = KINDS.map((_, i) => i + 1);
    expect(sampleBoundaries(KINDS, { mode: "full", seed: "abc", stream: "s", budget: 3 })).toEqual(all);
    expect(sampleBoundaries(KINDS, { mode: "exhaustive", seed: "abc", stream: "s", budget: 3 })).toEqual(all);
    expect(sampleItems(["a", "b", "c"], 1, { mode: "full", seed: "abc", stream: "s" })).toEqual(["a", "b", "c"]);
  });

  test("a sample of items keeps their order and is reproducible", () => {
    const items = ["a", "b", "c", "d", "e", "f"];
    const got = sampleItems(items, 2, { mode: "sample", seed: "abc", stream: "s" });
    expect(got).toHaveLength(2);
    expect(got).toEqual(items.filter((i) => got.includes(i)));
    expect(sampleItems(items, 2, { mode: "sample", seed: "abc", stream: "s" })).toEqual(got);
    expect(sampleItems(items, 9, { mode: "sample", seed: "abc", stream: "s" })).toEqual(items);
  });

  test("the mode and seed come from the environment", () => {
    expect(sweepMode({})).toBe("full");
    expect(sweepMode({ HOMERUN_CRASH_SWEEP: "sample" })).toBe("sample");
    expect(sweepMode({ HOMERUN_CRASH_SWEEP: "exhaustive" })).toBe("exhaustive");
    expect(() => sweepMode({ HOMERUN_CRASH_SWEEP: "some" })).toThrow("HOMERUN_CRASH_SWEEP");
    expect(crashSeed({ HOMERUN_CRASH_SEED: "s1", GITHUB_SHA: "sha" })).toBe("s1");
    expect(crashSeed({ GITHUB_SHA: "sha" })).toBe("sha");
    expect(crashSeed({})).toMatch(/^\d+$/);
  });
});
