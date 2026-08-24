import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  outputDir: "test-results",
  reporter: "list",
  retries: 0,
  testDir: "tests/black-box",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  use: {
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { height: 800, width: 1_024 },
  },
  workers: 1,
});
