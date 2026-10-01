import { describe, expect, test } from "bun:test";
import type { ThreadSummary } from "@homerun/core";
import { CACHED_THREADS } from "@homerun/app-state";
import { HistoryCache } from "../src/cache";
import { parseConfig } from "../src/config";
import { bunDriver } from "./sqlite";

const KEY = "ab".repeat(32);
const summary = (n: number) => ({ thread_id: `thr_${n}`, title: `t${n}` }) as unknown as ThreadSummary;
const thread = (n: number) => ({ events: [], has_earlier: n % 2 === 0, outbox: [] });

describe("the history cache (§9.8)", () => {
  test("keeps each desktop's list and threads apart, across closing and reopening", async () => {
    const sql = bunDriver();
    const c = new HistoryCache(sql, async () => KEY, false);
    const a = c.forDesktop("dsk_a");
    const b = c.forDesktop("dsk_b");
    await a.saveList([summary(1)]);
    await a.saveThread("thr_1", thread(1));
    await b.saveList([summary(2)]);
    await c.close();
    expect(await a.loadList()).toEqual([summary(1)]);
    expect(await a.loadThread("thr_1")).toEqual(thread(1));
    expect(await b.loadThread("thr_1")).toBeNull();
    expect(await b.loadList()).toEqual([summary(2)]);
    expect(sql.opened).toBe(2);

    await c.forget("dsk_a");
    expect(await a.loadList()).toBeNull();
    expect(await a.loadThread("thr_1")).toBeNull();
    expect(await b.loadList()).toEqual([summary(2)]);
  });

  test("holds the first page only, and drops threads that fell off it", async () => {
    const c = new HistoryCache(bunDriver(), async () => KEY, false);
    const a = c.forDesktop("dsk_a");
    await a.saveThread("thr_0", thread(0));
    await a.saveThread("thr_gone", thread(1));
    await a.saveList(Array.from({ length: CACHED_THREADS + 5 }, (_, i) => summary(i)));
    expect((await a.loadList())!.length).toBe(CACHED_THREADS);
    expect(await a.loadThread("thr_0")).toEqual(thread(0));
    expect(await a.loadThread("thr_gone")).toBeNull();
    await a.saveList([]);
    expect(await a.loadThread("thr_0")).toBeNull();
  });

  test("is empty after a wipe", async () => {
    const c = new HistoryCache(bunDriver(), async () => KEY, false);
    const a = c.forDesktop("dsk_a");
    await a.saveList([summary(1)]);
    await c.wipe();
    expect(await a.loadList()).toBeNull();
  });

  test("refuses an unencrypted database or a bad key, costing only the head start, and retries the next time", async () => {
    const sql = bunDriver();
    expect(await new HistoryCache(sql, async () => KEY).forDesktop("d").loadList()).toBeNull();
    let key = "not hex";
    const c = new HistoryCache(sql, async () => key, false);
    const a = c.forDesktop("d");
    await a.saveList([summary(1)]);
    expect(await a.loadList()).toBeNull();
    key = KEY;
    await a.saveList([summary(1)]);
    expect(await a.loadList()).toEqual([summary(1)]);
  });
});

describe("the build's configuration", () => {
  const homerun = { relayUrl: "wss://relay.example", issuer: "https://auth.example", clientId: "client_1" };

  test("reads extra.homerun", () => {
    expect(parseConfig({ homerun: { ...homerun, authParams: { provider: "authkit" }, dev: true, version: "1.2.3" } })).toEqual({
      ...homerun,
      authParams: { provider: "authkit" },
      dev: true,
      version: "1.2.3",
    });
    expect(parseConfig({ homerun: { ...homerun, authParams: {} } })).toEqual({ ...homerun, dev: false, version: "0.0.0" });
  });

  test("is null without the relay, the issuer or the client id, and ignores malformed parameters", () => {
    expect(parseConfig(undefined)).toBeNull();
    expect(parseConfig({})).toBeNull();
    expect(parseConfig({ homerun: { ...homerun, clientId: "" } })).toBeNull();
    expect(parseConfig({ homerun: { ...homerun, relayUrl: 7 } })).toBeNull();
    expect(parseConfig({ homerun: { ...homerun, authParams: { a: 1 } } })).toEqual({ ...homerun, dev: false, version: "0.0.0" });
  });
});
