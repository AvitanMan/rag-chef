import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.RAG_CHEF_TEST_BASE_URL;
if (!baseURL || !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname) || new URL(baseURL).port === "3000") {
  throw new Error("Run the isolated smoke runner with a disposable database and preview.");
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined);

export default defineConfig({
  testDir: "./tests/browser-smoke",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalTimeout: 180_000,
  reporter: [["list"], ["json", { outputFile: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/results.json` }]],
  outputDir: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/test-results`,
  use: {
    baseURL, timezoneId: "Asia/Jerusalem", serviceWorkers: "allow",
    trace: "retain-on-failure", screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-offline", use: { ...devices["Desktop Chrome"], launchOptions: { executablePath } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
