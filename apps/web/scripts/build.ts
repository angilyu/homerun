#!/usr/bin/env bun
/**
 * Builds the web client (§9.9) into dist/: index.html, hashed assets under /assets, and
 * Cloudflare Pages' `_headers` (CSP and the other security headers) and `_redirects`.
 *
 *   HOMERUN_RELAY_URL=https://relay.example HOMERUN_OIDC_ISSUER=https://auth.example \
 *   HOMERUN_OIDC_CLIENT_ID=client_... [HOMERUN_OIDC_AUTH_PARAMS='{"provider":"authkit"}'] \
 *   bun scripts/build.ts [--dev] [--out dir]
 *
 * The CSP's connect-src names the relay and every origin of the provider's discovery document,
 * which is fetched once here. `--dev` allows plain http on 127.0.0.1 (the local issuer and relay)
 * and leaves out HSTS and upgrade-insecure-requests.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../package.json";

export interface WebBuild {
  relayUrl: string;
  issuer: string;
  clientId: string;
  authParams?: Record<string, string>;
  dev?: boolean;
  outdir?: string;
}

const root = join(import.meta.dir, "..");
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function checkUrl(what: string, raw: string, dev: boolean): URL {
  const u = new URL(raw);
  if (u.protocol !== "https:" && !(dev && u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error(`${what} must be https${dev ? " (or http on 127.0.0.1)" : ""}`);
  return u;
}

/** The origins the page talks to: the relay (https and its WebSocket) and the provider's endpoints. */
async function connectOrigins(b: WebBuild): Promise<string[]> {
  const dev = b.dev === true;
  const relay = checkUrl("the relay URL", b.relayUrl, dev);
  const ws = new URL(relay.href);
  ws.protocol = relay.protocol === "https:" ? "wss:" : "ws:";
  const origins = new Set([relay.origin, ws.origin, checkUrl("the issuer", b.issuer, dev).origin]);
  const res = await fetch(`${b.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`the issuer's discovery document: ${res.status}`);
  const d = (await res.json()) as Record<string, unknown>;
  for (const k of ["token_endpoint", "jwks_uri", "revocation_endpoint"]) {
    if (typeof d[k] === "string") origins.add(checkUrl(k, d[k], dev).origin);
  }
  return [...origins];
}

export function securityHeaders(connect: string[], dev: boolean): string {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${connect.join(" ")}`,
    "manifest-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
  const all = [
    `Content-Security-Policy: ${csp}`,
    ...(dev ? [] : ["Strict-Transport-Security: max-age=63072000; includeSubDomains"]),
    "X-Content-Type-Options: nosniff",
    "X-Frame-Options: DENY",
    "Referrer-Policy: no-referrer",
    "Cross-Origin-Opener-Policy: same-origin",
    "Cross-Origin-Resource-Policy: same-origin",
    "Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  ];
  return [
    "/*",
    ...all.map((h) => `  ${h}`),
    "/",
    "  Cache-Control: no-cache",
    "/index.html",
    "  Cache-Control: no-cache",
    "/auth/*",
    "  Cache-Control: no-store",
    "/assets/*",
    "  Cache-Control: public, max-age=31536000, immutable",
    "",
  ].join("\n");
}

/** Builds into `outdir` (default dist/); returns the output directory. */
export async function buildWeb(b: WebBuild): Promise<string> {
  const dev = b.dev === true;
  const outdir = b.outdir ?? join(root, "dist");
  const connect = await connectOrigins(b);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  const r = await Bun.build({
    entrypoints: [join(root, "index.html")],
    outdir,
    minify: !dev,
    sourcemap: "none",
    target: "browser",
    publicPath: "/",
    naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
    define: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
      HOMERUN_WEB_RELAY_URL: JSON.stringify(b.relayUrl.replace(/\/+$/, "")),
      HOMERUN_WEB_OIDC_ISSUER: JSON.stringify(b.issuer),
      HOMERUN_WEB_OIDC_CLIENT_ID: JSON.stringify(b.clientId),
      HOMERUN_WEB_AUTH_PARAMS: JSON.stringify(b.authParams ? JSON.stringify(b.authParams) : ""),
      HOMERUN_WEB_DEV: JSON.stringify(dev ? "1" : "0"),
      HOMERUN_WEB_VERSION: JSON.stringify(pkg.version),
    },
  });
  if (!r.success) throw new AggregateError(r.logs, "the web build failed");
  await writeFile(join(outdir, "_headers"), securityHeaders(connect, dev));
  // The sign-in callback is the one path besides "/": the app routes in memory.
  await writeFile(join(outdir, "_redirects"), "/auth/callback /index.html 200\n");
  return outdir;
}

if (import.meta.main) {
  const env = process.env;
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  const relayUrl = env.HOMERUN_RELAY_URL;
  const issuer = env.HOMERUN_OIDC_ISSUER;
  const clientId = env.HOMERUN_OIDC_CLIENT_ID;
  if (!relayUrl || !issuer || !clientId) {
    console.error("set HOMERUN_RELAY_URL, HOMERUN_OIDC_ISSUER and HOMERUN_OIDC_CLIENT_ID");
    process.exit(2);
  }
  const outdir = await buildWeb({
    relayUrl,
    issuer,
    clientId,
    ...(env.HOMERUN_OIDC_AUTH_PARAMS ? { authParams: JSON.parse(env.HOMERUN_OIDC_AUTH_PARAMS) as Record<string, string> } : {}),
    dev: args.includes("--dev"),
    ...(out ? { outdir: out } : {}),
  });
  console.log(`built → ${outdir}`);
}
