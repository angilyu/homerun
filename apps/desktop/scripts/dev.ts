#!/usr/bin/env bun
/**
 * The dev server for `pnpm tauri dev` (tauri.conf.json `devUrl`): Bun bundles index.html and its
 * imports on request, with hot reload. Port 5178 matches the devUrl and the dev CSP.
 */
import index from "../index.html";

const port = Number(process.env.HOMERUN_DEV_PORT ?? 5178);
const server = Bun.serve({
  port,
  hostname: "localhost",
  development: { hmr: true, console: true },
  routes: { "/": index },
  fetch: () => new Response("not found", { status: 404 }),
});
console.log(`homerun desktop dev server on ${server.url}`);
