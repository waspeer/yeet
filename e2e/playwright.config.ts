import { defineConfig, devices } from "@playwright/test";

// Started by scripts/verify.mjs; tests fail with a clear message when it is missing.
const baseURL = process.env.YEET_E2E_BASE_URL;

export default defineConfig({
  testDir: "tests",
  outputDir: "results/test-output",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalTimeout: 20 * 60_000,
  fullyParallel: true,
  forbidOnly: true,
  // No retries: a test that only passes on a retry must not hide as a pass.
  // If you pass --retries, such tests are reported as FLAKY and fail the run.
  retries: 0,
  failOnFlakyTests: true,
  workers: Number(process.env.YEET_E2E_WORKERS) || 4,
  reporter: [["list"], ["./lib/summary-reporter.ts"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // CLI, HTTP and cron tests: no browser, run once.
    { name: "node", testDir: "tests/node" },
    // Download page tests, once per engine.
    { name: "chromium", testDir: "tests/browser", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", testDir: "tests/browser", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", testDir: "tests/browser", use: { ...devices["Desktop Firefox"] } },
  ],
});
