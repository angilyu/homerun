import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.HOMERUN_E2E_PORT ?? 5179);

/**
 * The E2E smoke test (plan §9): the production views in Chromium, over the bridge to a real
 * homerund (test/e2e/bridge-server.ts). One runtime at a time, so one worker.
 * `HOMERUN_E2E_CHANNEL=chrome` uses an installed Chrome instead of Playwright's Chromium.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "report" }]] : "list",
  outputDir: "results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1100, height: 760 },
    ...(process.env.HOMERUN_E2E_CHANNEL ? { channel: process.env.HOMERUN_E2E_CHANNEL } : {}),
  },
  webServer: {
    command: "bun test/e2e/bridge-server.ts",
    cwd: "../..",
    url: `http://127.0.0.1:${PORT}/__e2e/health`,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  },
});
