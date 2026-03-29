import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Cap workers to avoid resource contention from many simultaneous Electron instances.
  // Note: workers is a top-level-only option — per-project workers is silently ignored.
  // GitHub Actions ubuntu-latest has 2 vCPUs, so "75%" would give just 1 worker.
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI ? [["github"], ["html"]] : "html",
  timeout: 60000,
  use: {
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "unit",
      testDir: "./tests/unit",
      testMatch: /.*\.spec\.ts/,
      fullyParallel: true,
    },
    {
      name: "e2e",
      testDir: "./tests/e2e",
      testMatch: /.*\.spec\.ts/,
      // Each worker gets an isolated database via TEST_WORKER_INDEX,
      // so E2E tests can now run fully in parallel across files.
      // Tests within a describe block stay serial (they share an Electron instance).
      fullyParallel: true,
    },
    {
      name: "integration",
      testDir: "./tests",
      testMatch: /.*\.spec\.ts/,
      testIgnore: [/unit\//, /e2e\//, /problematic\//],
      fullyParallel: true,
    },
    {
      name: "problematic",
      testDir: "./tests/problematic",
      testMatch: /.*\.spec\.ts/,
      // These tests are flaky and excluded from the main test run
      // Run manually with: npx playwright test --project=problematic
      fullyParallel: false,
      workers: 1,
    },
  ],
});
