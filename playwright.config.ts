import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.RAG_CHEF_TEST_BASE_URL;
const secureLanTest = process.env.RAG_CHEF_SECURE_LAN_TEST === "1";
const lanTest = process.env.RAG_CHEF_LAN_TEST === "1";
const testHost = baseURL ? new URL(baseURL).hostname : "";
const privateHost = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(testHost);
if (!baseURL || !(["127.0.0.1", "localhost"].includes(testHost) || lanTest && privateHost) || new URL(baseURL).port === "3000") {
  throw new Error("Run pnpm test:e2e to use a disposable database and preview.");
}
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? (existsSync(chrome) ? chrome : undefined);

export default defineConfig({
  testDir: "./tests/e2e",
  ...(process.env.RAG_CHEF_SETUP_TEST === "1" ? { testMatch: "first-run.spec.ts" } : { testIgnore: secureLanTest ? ["first-run.spec.ts", "lan.spec.ts"] : lanTest ? ["first-run.spec.ts", "secure-lan.spec.ts"] : ["first-run.spec.ts", "lan.spec.ts", "secure-lan.spec.ts"] }),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  // Both device projects run serially; shared CI runners need time for the full suite.
  globalTimeout: 600_000,
  reporter: [["list"], ["json", { outputFile: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/results.json` }]],
  outputDir: `${process.env.RAG_CHEF_TEST_ARTIFACTS}/test-results`,
  use: {
    baseURL,
    ...(secureLanTest ? { ignoreHTTPSErrors: true } : {}),
    timezoneId: "Asia/Jerusalem",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
    launchOptions: { executablePath, ...(secureLanTest ? { args: [`--host-resolver-rules=MAP ragchef.local ${testHost}`] } : {}) },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" } },
  ],
});
