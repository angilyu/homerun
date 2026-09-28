/**
 * §16.1 measurements: memory of the signed homerund at idle and with 1 and 3 concurrent
 * active runs (each run = one bundled `claude` process tree executing a Bash tool call).
 *
 *   bun run spikes/packaging/memory.ts [path/to/Homerun.app]
 *   HOMERUN_CHILD_SHELL=/bin/sh bun run spikes/packaging/memory.ts …   (F9: skip the user's login shell)
 *
 * The model is the scripted mock API (spikes/sdk/src/mock-api.ts), so this measures the
 * runtime + claude processes only, not network or model latency. Prints JSON.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

const app = resolve(process.argv[2] ?? "dist/macos/0.0.2/Homerun.app");
const exe = join(app, "Contents/MacOS/homerund");
// Short path: the socket path must stay under 104 bytes (§5.2).
const dir = mkdtempSync("/private/tmp/hrmem-");
const cwd = join(dir, "cwd");
Bun.spawnSync(["mkdir", "-p", cwd]);
const MOCK_PORT = 8772;
const mock = Bun.spawn([process.execPath, "run", "spikes/sdk/src/mock-api.ts", String(MOCK_PORT), join(dir, "mock")], { stdout: "ignore", stderr: "ignore" });
await Bun.sleep(800);

const token = randomBytes(32).toString("hex");
const child = spawn(exe, ["serve"], {
  env: {
    HOME: process.env.HOME!,
    TMPDIR: process.env.TMPDIR!,
    PATH: "/usr/bin:/bin",
    HOMERUN_DATA_DIR: join(dir, "d"),
    ANTHROPIC_API_KEY: "sk-ant-mock-not-a-key",
    HOMERUN_ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/mem`,
    ...(process.env.HOMERUN_CHILD_SHELL ? { HOMERUN_CHILD_SHELL: process.env.HOMERUN_CHILD_SHELL } : {}),
  },
  stdio: ["pipe", "pipe", "ignore"],
});
child.stdin.write(token + "\n");
await new Promise<void>((r) => child.stdout.on("data", (d) => String(d).includes("serving") && r()));

const s = connect(join(dir, "d", "run", "homerund.sock"));
let buf = "";
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
s.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    pending.get(m.id)?.(m.result ?? m.error);
    pending.delete(m.id);
  }
});
await new Promise((r) => s.on("connect", r));
const call = (method: string, params: object = {}) =>
  new Promise<any>((r) => {
    const id = nextId++;
    pending.set(id, r);
    s.write(JSON.stringify({ id, method, params }) + "\n");
  });
await call("hello", { token, protocol: 1 });

type Proc = { pid: number; ppid: number; rssKiB: number; comm: string };
function tree(root: number): Proc[] {
  const rows = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,comm="]).stdout.toString().trim().split("\n");
  const all = rows.map((l) => {
    const [pid, ppid, rss, ...c] = l.trim().split(/\s+/);
    return { pid: +pid!, ppid: +ppid!, rssKiB: +rss!, comm: c.join(" ").split("/").pop()! };
  });
  const keep = new Set([root]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of all) if (!keep.has(p.pid) && keep.has(p.ppid)) (keep.add(p.pid), (changed = true));
  }
  return all.filter((p) => keep.has(p.pid));
}
function footprintMB(pids: number[]): number {
  if (!pids.length) return 0;
  const out = Bun.spawnSync(["footprint", ...pids.flatMap((p) => ["-p", String(p)])]).stdout.toString();
  // Multi-process output ends with a "Summary Footprint" or per-process "Footprint:" lines.
  const vals = [...out.matchAll(/^\S.*?\[\d+\].*?:\s*([\d.]+)\s*(KB|MB|GB)/gm)].map((m) => +m[1]! * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as any)[m[2]!]);
  if (vals.length) return Math.round(vals.reduce((a, b) => a + b, 0));
  const one = out.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
  return one ? Math.round(+one[1]! * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as any)[one[2]!]) : NaN;
}
function sample() {
  const t = tree(child.pid!);
  const byComm: Record<string, number> = {};
  for (const p of t) byComm[p.comm] = (byComm[p.comm] ?? 0) + p.rssKiB;
  return { procs: t.length, rssKiB: t.reduce((a, p) => a + p.rssKiB, 0), byCommKiB: byComm, footprintMB: footprintMB(t.map((p) => p.pid)), claudeProcs: t.filter((p) => p.comm === "claude").length };
}

async function phase(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await call("run.start", { prompt: "Run `sleep 18 && echo ok` then reply with the single word DONE.", cwd })).run_id);
  let peak: ReturnType<typeof sample> | null = null;
  const samples: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await Bun.sleep(1500);
    const sm = sample();
    samples.push(sm.rssKiB);
    if (sm.claudeProcs >= n && (!peak || sm.rssKiB > peak.rssKiB)) peak = sm;
    const runs: any[] = await call("run.list");
    if (ids.every((id) => runs.find((r) => r.run_id === id)?.status === "completed")) break;
  }
  const runs: any[] = await call("run.list");
  return { concurrentRuns: n, statuses: ids.map((id) => runs.find((r) => r.run_id === id)?.status), peak, seconds: Math.round((Date.now() - t0) / 1000) };
}

await Bun.sleep(5000);
const idle = sample();
const one = await phase(1);
await Bun.sleep(3000);
const three = await phase(3);
await Bun.sleep(3000);
const after = sample();

const perRun = (p: typeof one) => (p.peak ? Math.round((p.peak.rssKiB - idle.rssKiB) / p.concurrentRuns / 1024) : null);
console.log(
  JSON.stringify(
    {
      exe,
      idle: { ...idle, rssMiB: Math.round(idle.rssKiB / 1024) },
      one,
      three,
      afterRunsIdle: { ...after, rssMiB: Math.round(after.rssKiB / 1024) },
      perActiveRunRssMiB: { oneRun: perRun(one), threeRuns: perRun(three) },
    },
    null,
    2,
  ),
);
child.stdin.end();
await new Promise((r) => child.on("exit", r));
mock.kill();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
