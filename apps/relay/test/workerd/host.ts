import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Starts the Worker in workerd via scripts/workerd-host.mjs under Node. */
export async function startWorkerd(vars: Record<string, string>, config?: string): Promise<{ url: string; stop(): Promise<void> }> {
  const script = fileURLToPath(new URL("../../scripts/workerd-host.mjs", import.meta.url));
  const child: ChildProcess = spawn(process.env.NODE_BINARY ?? "node", [script, JSON.stringify(vars), ...(config ? [config] : [])], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CLOUDFLARE_API_TOKEN: "" },
  });
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const lines = createInterface({ input: child.stdout! });
  const url = await Promise.race([
    new Promise<string>((resolve) => lines.on("line", (l) => l.startsWith("{") && resolve((JSON.parse(l) as { url: string }).url))),
    exited.then((code) => Promise.reject(new Error(`workerd host exited with ${code}`))),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error("workerd host didn't start in 60 s")), 60_000)),
  ]);
  return {
    url,
    async stop() {
      child.stdin!.end();
      const t = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}
