import { describe, expect, test } from "bun:test";
import { checkOrigin, parseWebOrigins, withCors } from "../../src/core/cors";

describe("WEB_ORIGINS", () => {
  test("takes exact https origins, and loopback http for a dev server", () => {
    expect(parseWebOrigins(" https://app.homerun.dev ,http://127.0.0.1:5173,http://localhost:5173")).toEqual([
      "https://app.homerun.dev",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ]);
    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins("")).toEqual([]);
  });

  test("refuses wildcards, paths, trailing slashes, null and plain http", () => {
    for (const bad of ["*", "https://*.homerun.dev", "https://app.homerun.dev/", "https://app.homerun.dev/web", "null", "http://app.homerun.dev", "app.homerun.dev"]) {
      expect(() => parseWebOrigins(bad)).toThrow(/WEB_ORIGINS/);
    }
  });
});

describe("checkOrigin", () => {
  const allowed = ["https://app.homerun.dev"];
  const req = (origin?: string) => new Request("https://relay.homerun.dev/v1/devices", origin ? { headers: { origin } } : {});

  test("no Origin, or the relay's own, is a native client and gets no CORS headers", () => {
    expect(checkOrigin(req(), allowed)).toEqual({ ok: true, origin: null });
    expect(checkOrigin(req("https://relay.homerun.dev"), allowed)).toEqual({ ok: true, origin: null });
  });

  test("only a listed origin, compared exactly", () => {
    expect(checkOrigin(req("https://app.homerun.dev"), allowed)).toEqual({ ok: true, origin: "https://app.homerun.dev" });
    for (const o of ["null", "https://APP.homerun.dev", "https://app.homerun.dev.evil.example", "http://app.homerun.dev", "https://app.homerun.dev:8443"]) {
      expect(checkOrigin(req(o), allowed)).toEqual({ ok: false });
    }
  });

  test("withCors leaves WebSocket upgrades and native answers alone", () => {
    const r = new Response("x");
    expect(withCors(r, null)).toBe(r);
    expect(withCors(r, "https://app.homerun.dev").headers.get("access-control-allow-origin")).toBe("https://app.homerun.dev");
  });
});
