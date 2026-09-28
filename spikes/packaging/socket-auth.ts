/**
 * §5.2 local socket security + idle-memory measurement against a *signed* homerund.
 *   bun run spikes/packaging/socket-auth.ts <path/to/homerund> <short-data-dir>
 * Prints one JSON object with pass/fail per check.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const [exe, dir] = process.argv.slice(2);
if (!exe || !dir) throw new Error("usage: socket-auth.ts <homerund> <data-dir>");
const token = randomBytes(32).toString("hex");
const child = spawn(exe, ["serve"], { env: { HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR!, PATH: "/usr/bin:/bin", HOMERUN_DATA_DIR: dir }, stdio: ["pipe", "pipe", "inherit"] });
child.stdin.write(token + "\n");
const sock = join(dir, "run", "homerund.sock");
await new Promise<void>((r) => child.stdout.on("data", (d) => String(d).includes("serving") && r()));

function session(lines: object[], waitMs = 3000): Promise<{ replies: any[]; closedAfterMs: number | null }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const replies: any[] = [];
    let closed: number | null = null;
    const s = connect(sock);
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) replies.push(JSON.parse(buf.slice(0, i)));
    });
    s.on("close", () => {
      closed = Date.now() - t0;
      resolve({ replies, closedAfterMs: closed });
    });
    s.on("connect", () => lines.forEach((l) => s.write(JSON.stringify(l) + "\n")));
    setTimeout(() => (s.destroy(), resolve({ replies, closedAfterMs: closed })), waitMs);
  });
}

const out: Record<string, unknown> = {};
const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
out.socketDirMode = mode(join(dir, "run"));
out.socketMode = mode(sock);
const noHello = await session([], 4000);
out.noHandshakeClosedAfterMs = noHello.closedAfterMs;
const wrong = await session([{ id: 0, method: "hello", params: { token: "0".repeat(64), protocol: 1 } }, { id: 1, method: "ping" }]);
out.wrongToken = wrong;
const skip = await session([{ id: 1, method: "ping" }]);
out.methodBeforeHello = skip;
const ok = await session([{ id: 0, method: "hello", params: { token, protocol: 1 } }, { id: 1, method: "ping" }], 1000);
out.correctToken = ok.replies;
out.pass =
  out.socketDirMode === "700" &&
  noHello.closedAfterMs !== null && noHello.closedAfterMs < 3000 &&
  wrong.replies.length === 1 && wrong.replies[0].error?.code === 401 && wrong.closedAfterMs !== null &&
  skip.replies[0]?.error?.code === 401 &&
  ok.replies[1]?.result?.pong === true;

// Idle memory: RSS and phys_footprint (what Activity Monitor shows) after 10 s idle.
await Bun.sleep(10_000);
const rss = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]).stdout.toString().trim();
const fp = Bun.spawnSync(["footprint", "-p", String(child.pid)]).stdout.toString();
out.idle = { pid: child.pid, rssKiB: Number(rss), footprint: fp.match(/Footprint:\s*([\d.]+ \w+)/)?.[1] ?? fp.split("\n").find((l) => /phys_footprint/i.test(l)) };

child.stdin.end(); // EOF → graceful exit
out.exitCode = await new Promise((r) => child.on("exit", (c) => r(c)));
console.log(JSON.stringify(out, null, 2));
