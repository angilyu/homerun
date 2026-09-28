/**
 * A development stand-in for the Homerun shell (§5.1, §5.2), until the desktop app exists.
 *
 *   pnpm --filter @homerun/homerund dev [--no-key] [-- <homerund serve switches>]
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
 * Development only: this script is not part of any build.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RpcClient } from "@homerun/client";

const MAIN = join(import.meta.dir, "..", "src", "main.ts");

function usage(code: number): never {
  process.stderr.write("usage: dev-shell [--no-key] [-- <homerund serve switches>]\n");
  process.exit(code);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const serveArgs = sep >= 0 ? argv.slice(sep + 1) : [];
let wantKey = true;
for (const a of own) {
  if (a === "--no-key") wantKey = false;
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
process.stderr.write(
  `dev-shell: homerund ${shell.hello?.runtime_version} is ready on ${socket}, ${wantKey ? "with" : "without"} an API key.\n` +
    "dev-shell: in another terminal, try `pnpm homerun status`. Ctrl-C stops it.\n",
);
await exited;
