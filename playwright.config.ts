import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.RAG_CHEF_TEST_BASE_URL;
if (!baseURL || !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname) || new URL(baseURL).port === "3000") {
  throw new Error("Run pnpm test:e2e to use a disposable database and preview.");
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 300_000,
  reporter: [["list"], ["json", { outputFile: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/results.json` }]],
  outputDir: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/test-results`,
  use: {
    baseURL,
    timezoneId: "Asia/Jerusalem",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    launchOptions: { executablePath },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
