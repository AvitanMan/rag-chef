import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const baseURL = process.env.RAG_CHEF_TEST_BASE_URL;
if (!baseURL || !["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname) || new URL(baseURL).port === "3000") {
  throw new Error("Run pnpm test:dev to use a disposable development app.");
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export default defineConfig({
  testDir: "./tests/dev-smoke", workers: 1, retries: 0, timeout: 30_000,
  reporter: [["list"], ["json", { outputFile: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/results.json` }]],
  outputDir: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/test-results`,
  use: { ...devices["Desktop Chrome"], baseURL, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined) } },
});
