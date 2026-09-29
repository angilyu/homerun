import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonValue } from "@homerun/core";
import { parseFeed } from "../../../src/monitors/feed";
import { evaluateRule } from "../../../src/monitors/rules";
import { cssTexts, jsonPath, observe, SourceError, type RuleCheck, type RuleSource } from "../../../src/monitors/sources";

let server: ReturnType<typeof Bun.serve>;
let base = "";
const dir = mkdtempSync(join(tmpdir(), "hr-rules-"));

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      switch (u.pathname) {
        case "/json":
          return Response.json({ price: { amount: "1,299.00" }, items: [{ id: 1, title: "a" }, { id: 2, title: "b" }], "odd key": [10, 20] });
        case "/html":
          return new Response(`<html><body><h1 class="t">  Hello <b>World</b> </h1><p class="t">Second</p><img class="t"></body></html>`);
        case "/rss":
          return new Response(RSS);
        case "/500":
          return new Response("no", { status: 500 });
        case "/big":
          return new Response(new ReadableStream({
            start(c) {
              const chunk = new Uint8Array(64 * 1024).fill(97);
              for (let i = 0; i < 20; i++) c.enqueue(chunk);
              c.close();
            },
          }));
        case "/slow":
          await Bun.sleep(2000);
          return new Response("late");
        default:
          return new Response("plain body text");
      }
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const opts = { roots: [dir], userHome: dir };
const obs = (s: RuleSource, o: Partial<Parameters<typeof observe>[1]> = {}) => observe(s, { ...opts, ...o });
const http = (path: string, extract: Extract<RuleSource, { type: "http" }>["extract"]): RuleSource => ({ type: "http", url: `${base}${path}`, extract });
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as SourceError).code;

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>News</title>
<item><title>First &amp; best</title><link>https://e.x/1</link><guid>g1</guid></item>
<item><title><![CDATA[Second <i>one</i>]]></title><link>https://e.x/2</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><id>urn:1</id><title type="html">Post &lt;1&gt;</title><link rel="alternate" href="https://b.x/1"/></entry>
<entry><id>urn:2</id><title>Post 2</title><link href="https://b.x/2"/></entry>
</feed>`;

describe("sources", () => {
  test("http body, json_path, css and regex", async () => {
    expect((await obs(http("/", { kind: "body" }))).value).toBe("plain body text");
    expect((await obs(http("/json", { kind: "json_path", path: "$.price.amount" }))).value).toBe("1,299.00");
    expect((await obs(http("/json", { kind: "json_path", path: "$['odd key'][1]" }))).value).toBe(20);
    expect((await obs(http("/json", { kind: "json_path", path: "$.missing.deeper" }))).value).toBe(null);
    const list = await obs(http("/json", { kind: "json_path", path: "$.items" }));
    expect(list.items?.map((i) => i.title)).toEqual(["a", "b"]);
    expect((await obs(http("/html", { kind: "css", selector: ".t" }))).value).toBe("Hello World\nSecond\n");
    expect((await obs(http("/", { kind: "regex", pattern: "body (\\w+)" }))).value).toBe("text");
    expect((await obs(http("/", { kind: "regex", pattern: "nope" }))).value).toBe(null);
  });

  test("errors carry a code", async () => {
    expect(await code(obs(http("/500", { kind: "body" })))).toBe("source_http_error");
    expect(await code(obs(http("/big", { kind: "body" }), { maxBytes: 256 * 1024 }))).toBe("source_too_large");
    expect(await code(obs(http("/slow", { kind: "body" }), { timeoutMs: 100 }))).toBe("source_timeout");
    expect(await code(obs({ type: "http", url: "http://127.0.0.1:1/", extract: { kind: "body" } }))).toBe("source_unreachable");
    expect(await code(obs(http("/", { kind: "json_path", path: "$.a" })))).toBe("source_unreadable");
    expect(await code(obs(http("/", { kind: "regex", pattern: "(" })))).toBe("invalid_check");
    expect(await code(obs({ type: "homerun_tool", tool: "homerun.notify", args: {} } as never))).toBe("unsupported_source");
  });

  test("feeds: RSS and Atom, entities and CDATA", async () => {
    const r = await obs({ type: "feed", url: `${base}/rss`, format: "auto" });
    expect(r.value).toEqual(["g1", "https://e.x/2"]);
    expect(r.items?.map((i) => i.title)).toEqual(["First & best", "Second <i>one</i>"]);
    expect(parseFeed(ATOM, "auto")).toEqual([
      { id: "urn:1", title: "Post <1>", link: "https://b.x/1" },
      { id: "urn:2", title: "Post 2", link: "https://b.x/2" },
    ]);
    expect(() => parseFeed("<html></html>", "rss")).toThrow();
    expect(() => parseFeed("not xml <", "auto")).toThrow();
    expect(await code(obs({ type: "feed", url: `${base}/html`, format: "atom" }))).toBe("source_unreadable");
  });

  test("file_hash only reads inside the task's roots, following symlinks first", async () => {
    const inside = join(dir, "in.txt");
    writeFileSync(inside, "x");
    const a = await obs({ type: "file_hash", path: inside });
    expect(typeof a.value).toBe("string");
    writeFileSync(inside, "y");
    expect((await obs({ type: "file_hash", path: inside })).value).not.toBe(a.value);
    const outside = mkdtempSync(join(tmpdir(), "hr-out-"));
    writeFileSync(join(outside, "secret"), "s");
    expect(await code(obs({ type: "file_hash", path: join(outside, "secret") }))).toBe("outside_roots");
    mkdirSync(join(dir, "sub"), { recursive: true });
    symlinkSync(join(outside, "secret"), join(dir, "sub", "link"));
    expect(await code(obs({ type: "file_hash", path: join(dir, "sub", "link") }))).toBe("outside_roots");
    expect(await code(obs({ type: "file_hash", path: join(dir, "../" + "x".repeat(8)) }))).toBe("source_missing");
    expect(await code(obs({ type: "file_hash", path: "~/in.txt" }, { roots: ["~"] }))).toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });

  test("the json_path subset and css helper", async () => {
    expect(jsonPath({ a: [{ b: 1 }] }, "$.a[0].b")).toBe(1);
    expect(jsonPath({ a: 1 }, "a")).toBe(1);
    expect(() => jsonPath({}, "$..a")).toThrow(SourceError);
    expect(await cssTexts("<ul><li>1</li><li> 2 </li></ul>", "li")).toEqual(["1", "2"]);
    expect(await cssTexts("<div class=a>x<div class=a>y</div></div>", ".a")).toEqual(["xy"]);
  });
});

const rule = (comparator: RuleCheck["comparator"], normalize?: RuleCheck["normalize"]): RuleCheck => ({
  kind: "rule",
  source: { type: "file_hash", path: "/x" },
  comparator,
  ...(normalize ? { normalize } : {}),
});
const v = (value: JsonValue, items: Array<{ id: string; title: string }> | null = null) => ({ value, items });

describe("comparators", () => {
  test("changed: a baseline first, then a report per change, with the old value", () => {
    const c = rule({ op: "changed" }, { trim: true, collapse_whitespace: true, lowercase: true });
    const a = evaluateRule(c, null, v("  Hello  World "));
    expect(a).toMatchObject({ changed: false, evidence: expect.stringContaining("Baseline") });
    expect(evaluateRule(c, a.new_state, v("hello world")).changed).toBe(false);
    const b = evaluateRule(c, a.new_state, v("hello there"));
    expect(b).toMatchObject({ changed: true, evidence: 'Changed to "hello there" (was "hello world")' });
    const big = "x".repeat(10_000);
    expect(evaluateRule(c, null, v(big)).new_state).not.toHaveProperty("value");
  });

  test("above / below / equals are edge-triggered and report on the first run", () => {
    const c = rule({ op: "below", value: 1000 });
    const a = evaluateRule(c, null, v("$999.00"));
    expect(a.changed).toBe(true);
    const b = evaluateRule(c, a.new_state, v("998"));
    expect(b.changed).toBe(false);
    const d = evaluateRule(c, evaluateRule(c, b.new_state, v("1,200")).new_state, v(900));
    expect(d.changed).toBe(true);
    expect(evaluateRule(rule({ op: "above", value: 5 }), null, v(5)).changed).toBe(false);
    expect(evaluateRule(rule({ op: "equals", value: { a: 1, b: [2] } }), null, v({ b: [2], a: 1 })).changed).toBe(true);
    expect(() => evaluateRule(c, null, v("n/a"))).toThrow(SourceError);
  });

  test("new_items: a baseline, then only unseen ids, with the seen list capped", () => {
    const c = rule({ op: "new_items" });
    const items = (ids: string[]) => v(ids, ids.map((id) => ({ id, title: `T${id}` })));
    const a = evaluateRule(c, null, items(["1", "2"]));
    expect(a.changed).toBe(false);
    const b = evaluateRule(c, a.new_state, items(["3", "1", "2"]));
    expect(b).toMatchObject({ changed: true, evidence: "1 new item:\n- T3" });
    const many = Array.from({ length: 5000 }, (_, i) => `id-${i}-${"p".repeat(20)}`);
    const s = evaluateRule(c, b.new_state, items(many)).new_state as { seen: string[] };
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(48 * 1024 + 16);
    expect(s.seen[0]).toBe(many[0]);
    const byField = rule({ op: "new_items", id_field: "id" });
    const j = evaluateRule(byField, { seen: ["1"] }, v([{ id: 1, title: "a" }, { id: 2, title: "b" }]));
    expect(j).toMatchObject({ changed: true, evidence: "1 new item:\n- b" });
    expect(() => evaluateRule(c, null, v("not a list"))).toThrow(SourceError);
  });
});
