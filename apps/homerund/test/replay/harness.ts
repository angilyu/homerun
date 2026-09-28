import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import type { ThreadEvent } from "@homerun/core";
import { RpcClient } from "../../src/rpc/client";

export const HOMERUND_DIR = resolve(import.meta.dir, "..", "..");
export const MAIN = join(HOMERUND_DIR, "src", "main.ts");
export const FIXTURE_MCP = join(HOMERUND_DIR, "test", "fixtures", "mcp-fixture.ts");
export const REPLAY_KEY = "sk-ant-replay-not-a-key";

export interface HomerundOptions {
  /** Data dir; created if omitted. Reuse it across restarts. */
  dataDir?: string;
  /** HOME for homerund itself (the isolation scenario uses a canary home). */
  home?: string;
  baseUrl: string;
  env?: Record<string, string>;
  args?: string[];
}

/**
 * A real `homerund serve` subprocess, driven over its socket as the shell would drive it. Every
 * scenario runs the product binary path end to end: real `claude`, real SDK, real SQLite; only
 * the Messages API is the replay server.
 */
export class Homerund {
  readonly dataDir: string;
  readonly token = crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  proc: Subprocess<"pipe", "inherit" | "pipe", "pipe"> | null = null;
  stderr = "";
  private clients: RpcClient[] = [];

  constructor(private o: HomerundOptions) {
    this.dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), "hr-replay-"));
  }

  get socketPath(): string {
    const primary = join(this.dataDir, "run", "homerund.sock");
    return Buffer.byteLength(primary) < 104 ? primary : join(tmpdir(), `hr-${process.getuid!()}`, "homerund.sock");
  }

  get dbPath(): string {
    return join(this.dataDir, "homerun.db");
  }

  async start(): Promise<void> {
    const overrides = join(this.dataDir, "mcp-overrides.json");
    writeFileSync(overrides, JSON.stringify({ "fixture-mcp@1.0.0": { command: process.execPath, args: [FIXTURE_MCP] } }));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.o.home ?? this.dataDir,
      HOMERUN_DATA_DIR: this.dataDir,
      HOMERUN_ANTHROPIC_BASE_URL: this.o.baseUrl,
      HOMERUN_DEV_AUTO_APPROVE: "1",
      HOMERUN_DEV_MCP_OVERRIDES: overrides,
      HOMERUN_FORCE_MODEL: "claude-haiku-4-5",
      HOMERUN_CHAT_MODEL: "claude-haiku-4-5",
      HOMERUN_CHAT_MAX_BUDGET_USD: "0.05",
      HOMERUN_SHUTDOWN_GRACE_MS: "3000",
      HOMERUN_LOG_LEVEL: "debug",
      ...this.o.env,
    };
    if (process.env.HOMERUN_CLAUDE_PATH) env.HOMERUN_CLAUDE_PATH = process.env.HOMERUN_CLAUDE_PATH;
    this.stderr = "";
    const proc = Bun.spawn([process.execPath, MAIN, "serve", ...(this.o.args ?? [])], {
      cwd: HOMERUND_DIR,
      env,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "pipe",
    });
    this.proc = proc;
    proc.stdin.write(this.token + "\n");
    proc.stdin.flush();
    void (async () => {
      const dec = new TextDecoder();
      for await (const chunk of proc.stderr) {
        const s = dec.decode(chunk);
        this.stderr += s;
        if (process.env.HOMERUN_REPLAY_VERBOSE) process.stderr.write(s);
      }
    })();
    const deadline = Date.now() + 15_000;
    while (!this.stderr.includes('"msg":"ready"')) {
      if (proc.exitCode !== null) throw new Error(`homerund exited ${proc.exitCode}:\n${this.stderr}`);
      if (Date.now() > deadline) throw new Error(`homerund did not become ready:\n${this.stderr}`);
      await Bun.sleep(20);
    }
  }

  async shell(apiKey: string): Promise<RpcClient> {
    const c = await RpcClient.open(this.socketPath, "shell", { kind: "launch_token", token: this.token });
    this.clients.push(c);
    await c.call("secrets.set", { name: "anthropic_api_key", value: apiKey });
    return c;
  }

  /** SIGKILL homerund alone, like a crash: its `claude` groups keep running. */
  async kill(): Promise<void> {
    for (const c of this.clients.splice(0)) c.close();
    this.proc?.kill("SIGKILL");
    await this.proc?.exited;
  }

  /** Graceful stop: close stdin, as the shell does. */
  async stop(): Promise<number> {
    for (const c of this.clients.splice(0)) c.close();
    if (!this.proc) return 0;
    this.proc.stdin.end();
    const code = await Promise.race([this.proc.exited, Bun.sleep(15_000).then(() => -1)]);
    if (code === -1) this.proc.kill("SIGKILL");
    return code;
  }

  logs(): Array<Record<string, unknown>> {
    return this.stderr
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  cleanup(): void {
    if (!process.env.HOMERUN_REPLAY_KEEP) rmSync(this.dataDir, { recursive: true, force: true });
  }
}

/** Collects `thread.event` notifications for one subscription. */
export class Subscription {
  readonly events: ThreadEvent[] = [];
  constructor(c: RpcClient) {
    c.onNotification((method, params) => {
      if (method === "thread.event") this.events.push((params as { event: ThreadEvent }).event);
    });
  }

  persisted(): Array<Extract<ThreadEvent, { seq: number }>> {
    return this.events.filter((e): e is Extract<ThreadEvent, { seq: number }> => "seq" in e);
  }

  async waitFor(pred: (e: ThreadEvent) => boolean, timeoutMs = 60_000, what = "event"): Promise<ThreadEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; got ${this.events.map((e) => e.type).join(", ")}`);
      await Bun.sleep(20);
    }
  }
}

export function loadEnvLocal(): Record<string, string> {
  const p = resolve(HOMERUND_DIR, "..", "..", ".env.local");
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(d, { recursive: true });
  return d;
}
