import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OidcIssuer } from "@homerun/testkit";
import { buildWeb, securityHeaders } from "../../scripts/build";

let issuer: OidcIssuer;
const dir = mkdtempSync(join(tmpdir(), "homerun-web-"));
beforeAll(async () => {
  issuer = await OidcIssuer.start();
});
afterAll(async () => {
  await issuer.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("the web build (§9.9)", () => {
  test("bundles one page with hashed assets, the headers and the callback route", async () => {
    const out = await buildWeb({ relayUrl: "http://127.0.0.1:8787/", issuer: issuer.url, clientId: "client_test", dev: true, outdir: join(dir, "dist") });
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[a-z0-9]+\.js">/);
    expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/assets\/index-[a-z0-9]+\.css">/);
    expect(html).not.toContain("<script>");
    const js = readdirSync(join(out, "assets")).filter((f) => f.endsWith(".js"));
    expect(js).toHaveLength(1);
    const bundle = readFileSync(join(out, "assets", js[0]!), "utf8");
    expect(bundle).toContain('"http://127.0.0.1:8787"');
    expect(bundle).not.toContain("@tauri-apps");
    const headers = readFileSync(join(out, "_headers"), "utf8");
    expect(headers).toContain(`connect-src 'self' http://127.0.0.1:8787 ws://127.0.0.1:8787 ${issuer.url}`);
    expect(headers).not.toContain("Strict-Transport-Security");
    expect(readFileSync(join(out, "_redirects"), "utf8")).toBe("/auth/callback /index.html 200\n");
  });

  test("production needs https, and adds HSTS and upgrade-insecure-requests", async () => {
    expect(buildWeb({ relayUrl: "http://127.0.0.1:8787", issuer: issuer.url, clientId: "c", outdir: join(dir, "prod") })).rejects.toThrow("must be https");
    const h = securityHeaders(["https://relay.example", "wss://relay.example", "https://auth.example"], false);
    expect(h).toContain("Strict-Transport-Security: max-age=63072000; includeSubDomains");
    const csp = h.split("\n").find((l) => l.includes("Content-Security-Policy"))!;
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "frame-ancestors 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'", "upgrade-insecure-requests"]) {
      expect(csp).toContain(d);
    }
    expect(csp).not.toContain("unsafe");
  });
});
