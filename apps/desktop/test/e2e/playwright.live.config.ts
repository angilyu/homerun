import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

/**
 * The manual real-key check (live.manual.ts): the bridge in live mode, one attempt, and no
 * traces or videos, which would record the key as it is typed.
 */
export default defineConfig({
  ...base,
  testMatch: /live\.manual\.ts$/,
  timeout: 600_000,
  reporter: "list",
  use: { ...base.use, trace: "off", video: "off", screenshot: "off" },
  webServer: { ...(base.webServer as object), command: "bun test/e2e/bridge-server.ts", env: { HOMERUN_E2E_LIVE: "1" } } as never,
});
