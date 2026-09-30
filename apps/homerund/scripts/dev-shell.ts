/**
 * A development stand-in for the Homerun shell (§5.1, §5.2), until the desktop app exists.
 *
 *   pnpm --filter @homerun/homerund dev [--no-key] [--cli-access ask|allow|deny] [-- <homerund serve switches>]
 *
 * It starts `homerund serve` from source, hands it a fresh launch token on stdin, and then, on
 * the shell's own connection, sends the API key with `secrets.set`. That is the only path by
 * which a secret reaches the runtime. The key comes from `ANTHROPIC_API_KEY` in this process's
 * environment, or from a hidden prompt. It is never read from a file and never passed to
 * homerund's environment. `--no-key` skips it: use this with `HOMERUN_ANTHROPIC_BASE_URL` pointing
 * at a replay server.
 *
 * Ctrl-C closes homerund's stdin, as the shell does on quit. The runtime then shuts down
 * gracefully, and this script exits with its exit code. Connect with the development CLI from
 * another terminal: `pnpm homerun status`.
 *
 * It also stands in for the shell's native *"Allow the Homerun CLI to control your agents?"*
 * prompt (§5.2): a `cli.access_requested` asks on this terminal (`--cli-access ask`, the default),
 * or is answered without asking (`allow`, `deny`). Try it with a development CLI in release-role
 * mode: `pnpm homerun --dev-role cli --dev-token-store /tmp/t --dev-skip-peer-check login`.
 *
 * Development only: this script is not part of any build.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RpcClient } from "@homerun/client";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function usage(code: number): never {
  process.stderr.write("usage: dev-shell [--no-key] [--cli-access ask|allow|deny] [-- <homerund serve switches>]\n");
  process.exit(code);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const serveArgs = sep >= 0 ? argv.slice(sep + 1) : [];
let wantKey = true;
let cliAccess = "ask" as "ask" | "allow" | "deny";
for (let i = 0; i < own.length; i++) {
  const a = own[i]!;
  if (a === "--no-key") wantKey = false;
  else if (a === "--cli-access" && ["ask", "allow", "deny"].includes(own[i + 1] ?? "")) cliAccess = own[++i] as typeof cliAccess;
  else if (a === "-h" || a === "--help") usage(0);
  else usage(64);
}
if (serveArgs.includes("--no-launch-token")) {
  process.stderr.write("dev-shell: --no-launch-token does not apply; the dev shell holds the launch token\n");
  process.exit(64);
}

/** Read a line from the terminal without echoing it. */
async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("no ANTHROPIC_API_KEY in the environment and stdin is not a terminal (use --no-key for replay)");
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return value;
        if (ch === "\u0003") {
          process.stderr.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    }
    return value;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

/** Read one echoed line from the terminal. */
async function readLine(): Promise<string> {
  process.stdin.resume();
  try {
    let line = "";
    for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
      line += chunk.toString("utf8");
      const nl = line.indexOf("\n");
      if (nl >= 0) return line.slice(0, nl);
    }
    return line;
  } finally {
    process.stdin.pause();
  }
}

let apiKey: string | null = null;
if (wantKey) {
  apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim() || (await readHidden("Anthropic API key (not echoed): ")).trim();
  if (!apiKey) {
    process.stderr.write("dev-shell: no API key; pass --no-key to start without one\n");
    process.exit(64);
  }
}

const launchToken = randomBytes(32).toString("hex");
const env: Record<string, string | undefined> = { ...process.env };
delete env.ANTHROPIC_API_KEY;
const proc = Bun.spawn([process.execPath, MAIN, "serve", ...serveArgs], { env, stdin: "pipe", stdout: "inherit", stderr: "pipe" });
proc.stdin.write(launchToken + "\n");
proc.stdin.flush();

const ready = Promise.withResolvers<string>();
void (async () => {
  const dec = new TextDecoder();
  let buf = "";
  let found = false;
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk, { stream: true });
    process.stderr.write(s);
    buf += s;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (found || !line.includes('"msg":"ready"')) continue;
      try {
        ready.resolve((JSON.parse(line) as { socket: string }).socket);
        found = true;
      } catch {}
    }
  }
})();

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  process.stderr.write("dev-shell: stopping homerund (closing its stdin)\n");
  try {
    proc.stdin.end();
  } catch {}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const exited = proc.exited.then((code) => process.exit(code));
const socket = await Promise.race([ready.promise, exited]);
const shell = await RpcClient.open(socket, "shell", { kind: "launch_token", token: launchToken }, { client: { name: "homerun-dev-shell", version: "0" }, validate: true });
if (apiKey) {
  await shell.call("secrets.set", { name: "anthropic_api_key", value: apiKey });
  apiKey = null;
}
/** The stand-in for the native CLI access prompt (§5.2). Nothing is answered unless the user types y. */
const answering = new Set<string>();
shell.onNotification((method, params) => {
  if (method === "cli.access_withdrawn") {
    const p = params as { request_id: string; reason: string };
    process.stderr.write(`dev-shell: CLI access request ${p.request_id} ${p.reason}\n`);
    return;
  }
  if (method !== "cli.access_requested") return;
  const p = params as { request_id: string; client: { name: string; version: string }; hostname: string };
  if (answering.has(p.request_id)) return;
  answering.add(p.request_id);
  void (async () => {
    let allow = cliAccess === "allow";
    if (cliAccess === "ask") {
      if (!process.stdin.isTTY) {
        process.stderr.write("dev-shell: a CLI asked for access, but stdin is not a terminal; denying (use --cli-access allow)\n");
      } else {
        process.stderr.write(`dev-shell: allow ${p.client.name} ${p.client.version} on "${p.hostname}" to control your agents? [y/N] `);
        allow = (await readLine()).trim().toLowerCase() === "y";
      }
    }
    try {
      await shell.call(allow ? "cli.approve" : "cli.deny", { request_id: p.request_id });
      process.stderr.write(`dev-shell: CLI access ${allow ? "allowed" : "denied"}\n`);
    } catch (e) {
      process.stderr.write(`dev-shell: couldn't answer: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  })();
});

process.stderr.write(
  `dev-shell: homerund ${shell.hello?.runtime_version} is ready on ${socket}, ${wantKey ? "with" : "without"} an API key.\n` +
    "dev-shell: in another terminal, try `pnpm homerun status`. Ctrl-C stops it.\n",
);
await exited;
