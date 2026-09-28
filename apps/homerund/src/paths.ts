import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const APP_ID = "dev.homerun.app";

/** True when running as a `bun build --compile` executable. */
export const isCompiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");

export function dataDir(): string {
  const d = process.env.HOMERUN_DATA_DIR ?? join(homedir(), "Library", "Application Support", APP_ID);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** Homerun-private CLAUDE_CONFIG_DIR (§5.3). Never ~/.claude. */
export function claudeConfigDir(root = dataDir()): string {
  const d = join(root, "claude-config");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/** 0700 directory for the IPC socket (§5.2). */
export function socketPath(root = dataDir()): string {
  const d = join(root, "run");
  mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(d, 0o700);
  return join(d, "homerund.sock");
}

/**
 * Locate a bundled helper executable (`claude`, `node`, `uv`).
 * In the app bundle all helpers sit next to homerund in Contents/MacOS (§5.1).
 * In development, `claude` comes from the SDK's platform package.
 */
export function helperPath(name: "claude" | "node" | "uv" | "npx"): string {
  const override = process.env[`HOMERUN_${name.toUpperCase()}_PATH`];
  if (override) return override;
  const besideExe = join(dirname(process.execPath), name);
  if (isCompiled && existsSync(besideExe)) return besideExe;
  if (name === "claude") {
    // Dev fallback: walk up to find node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude
    let dir = resolve(import.meta.dir);
    for (let i = 0; i < 8; i++) {
      const p = join(dir, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`, "claude");
      if (existsSync(p)) return p;
      const pnpmDir = join(dir, "node_modules", ".pnpm");
      if (existsSync(pnpmDir)) {
        const hit = [...new Bun.Glob(`@anthropic-ai+claude-agent-sdk-${process.platform}-${process.arch}@*/node_modules/@anthropic-ai/*/claude`).scanSync({ cwd: pnpmDir })][0];
        if (hit) return join(pnpmDir, hit);
      }
      dir = dirname(dir);
    }
  }
  if (existsSync(besideExe)) return besideExe;
  throw new Error(`bundled ${name} not found (set HOMERUN_${name.toUpperCase()}_PATH)`);
}
