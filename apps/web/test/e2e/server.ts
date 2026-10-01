#!/usr/bin/env bun
/**
 * The web client end to end (§9.9, §16.2): the production bundle, served with its `_headers` and
 * `_redirects` the way Cloudflare Pages applies them, against the local OIDC issuer, the relay's
 * Bun adapter and a desktop: a real homerund with the fake engine and a stand-in shell
 * (homerund's test/remote harness). No API spend.
 *
 * POST /__e2e/scene gives each test a new person and a new desktop, signed in and on the relay,
 * with a session task that may run Bash and ask questions. The desktop's side of linking is
 * POST /__e2e/link (approve or decline the link prompt, as a person would in its native prompt).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { sessionSpec } from "../../../homerund/test/helpers";
import { connected, desktop, newUser, startWorld } from "../../../homerund/test/remote/harness";
import { e2eScript } from "../../../desktop/test/e2e/fake-script";
import { buildWeb } from "../../scripts/build";

const PORT = Number(process.env.HOMERUN_WEB_E2E_PORT ?? 5189);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DIST = join(import.meta.dir, "dist");

const world = await startWorld({ webOrigins: [ORIGIN] });
await buildWeb({ relayUrl: world.relay.url, issuer: world.issuer.url, clientId: world.issuer.clientId, dev: true, outdir: DIST });

// --- Cloudflare Pages' `_headers`: a path pattern, then indented `Name: value` lines ---
const rules: { pattern: RegExp; headers: [string, string][] }[] = [];
for (const line of readFileSync(join(DIST, "_headers"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  if (!line.startsWith(" ")) {
    rules.push({ pattern: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`), headers: [] });
  } else {
    const i = line.indexOf(":");
    rules.at(-1)!.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
}
const rewrites = new Map(
  readFileSync(join(DIST, "_redirects"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(/\s+/) as [string, string, string])
    .map(([from, to]) => [from, to]),
);

function serveStatic(path: string): Response {
  const file = path === "/" ? "/index.html" : (rewrites.get(path) ?? path);
  const full = normalize(join(DIST, file));
  if (!full.startsWith(DIST) || file.startsWith("/_")) return new Response("not found", { status: 404 });
  const f = Bun.file(full);
  const res = new Response(f);
  for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of r.headers) res.headers.set(k, v);
  return res;
}

// --- the scene: one desktop at a time ---
type Desk = Awaited<ReturnType<typeof desktop>>;
let desk: Desk | null = null;

async function scene(): Promise<Record<string, unknown>> {
  await desk?.srt.close();
  desk = null;
  newUser(world);
  const d = await desktop(world, { script: e2eScript, env: { HOMERUN_DEV_AUTO_APPROVE: "0", HOMERUN_INPUT_GRACE_MS: "600000" } });
  desk = d;
  await connected(d.sh);
  const work = join(d.srt.dir, "work");
  mkdirSync(work, { recursive: true });
  const spec = sessionSpec({ name: "Repo helper", roots: [work], builtin: ["Bash", "AskUserQuestion"] });
  const created = await d.sh.c.call("tasks.create", { spec: spec as never });
  return { task_name: created.task.name, thread_id: created.thread_id };
}

/** The desktop's native link prompt: waits for an undecided one, then approves or declines it. */
const decided = new Set<string>();
async function decideLink(approve: boolean): Promise<Record<string, unknown>> {
  const d = desk;
  if (!d) throw new Error("no scene");
  const deadline = Date.now() + 10_000;
  let prompt = d.sh.prompts.find((p) => !decided.has(p.request_id));
  while (!prompt) {
    if (Date.now() > deadline) throw new Error("no link prompt");
    await Bun.sleep(25);
    prompt = d.sh.prompts.find((p) => !decided.has(p.request_id));
  }
  decided.add(prompt.request_id);
  await d.sh.c.call("devices.link.decide", { request_id: prompt.request_id, approve });
  return { code: prompt.code, name: prompt.name, platform: prompt.platform };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/__e2e/health") return Response.json({ ok: true });
      if (url.pathname === "/__e2e/scene" && req.method === "POST") return Response.json(await scene());
      if (url.pathname === "/__e2e/link" && req.method === "POST") {
        const { approve } = (await req.json()) as { approve: boolean };
        return Response.json(await decideLink(approve));
      }
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
    if (url.pathname.startsWith("/__e2e/")) return new Response("not found", { status: 404 });
    return serveStatic(url.pathname);
  },
});

console.log(`web e2e on ${ORIGIN}`);
const stop = async () => {
  server.stop(true);
  await desk?.srt.close();
  await world.stop();
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
