import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseRunDir, devTokenPath } from "@homerun/client";
import { ThreadEvent } from "@homerun/core";
import type { FakeScript } from "../../../homerund/src/agent/fake-engine";
import { MOCK_KEY, socketRuntime, type SocketRuntime } from "../../../homerund/test/helpers";

export const MAIN = join(import.meta.dir, "..", "..", "src", "main.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Spawned {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  stdout: () => string;
  stderr: () => string;
  done: Promise<CliResult>;
}

export interface CliOptions {
  stdin?: string;
  env?: Record<string, string>;
  /** SIGKILL the CLI after this long (default 20 s). */
  timeoutMs?: number;
}

/** Start the CLI from source (a development build) against a data dir. */
export function spawnCli(dataDir: string, args: string[], o: CliOptions = {}): Spawned {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dataDir, TMPDIR: tmpdir(), HOMERUN_DATA_DIR: dataDir, NO_COLOR: "1", ...o.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (o.stdin !== undefined) proc.stdin.write(o.stdin);
  proc.stdin.end();
  let out = "";
  let err = "";
  const read = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) add(dec.decode(chunk, { stream: true }));
  };
  const reading = Promise.all([read(proc.stdout, (t) => (out += t)), read(proc.stderr, (t) => (err += t))]);
  const timer = setTimeout(() => proc.kill("SIGKILL"), o.timeoutMs ?? 20_000);
  const done = (async () => {
    const code = await proc.exited;
    await reading;
    clearTimeout(timer);
    return { code, stdout: out, stderr: err };
  })();
  return { proc, stdout: () => out, stderr: () => err, done };
}

export const cli = (dataDir: string, args: string[], o: CliOptions = {}) => spawnCli(dataDir, args, o).done;

/** A runtime with the fake engine and the mock API key, as the dev shell would set it up. */
export async function runtime(opts: { script?: FakeScript; env?: Record<string, string> } = {}): Promise<SocketRuntime> {
  const srt = await socketRuntime(opts);
  const shell = await srt.shell();
  await shell.call("secrets.set", { name: "anthropic_api_key", value: MOCK_KEY });
  return srt;
}

export function ndjson(text: string): unknown[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function events(text: string): ThreadEvent[] {
  return ndjson(text).map((v) => ThreadEvent.parse(v));
}

export const devToken = (dataDir: string) => devTokenPath(chooseRunDir(dataDir).runDir);
