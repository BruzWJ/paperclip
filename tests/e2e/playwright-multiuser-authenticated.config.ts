import { defineConfig } from "@playwright/test";
import { installZeroDatabasePlaywrightEnvironment } from "./zero-database-environment.js";

const webServerEnvironment = installZeroDatabasePlaywrightEnvironment();
const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3105);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const PLAYWRIGHT_CHANNEL = process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: ".",
  testMatch: "multi-user-authenticated.spec.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        ...(PLAYWRIGHT_CHANNEL ? { channel: PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @paperclipai/ui exec vite --config vite.e2e.config.ts --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: webServerEnvironment,
  },
  outputDir: "./test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
});
