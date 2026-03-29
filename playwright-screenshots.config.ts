import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60000,
  projects: [
    {
      name: "chromium",
      testMatch: /.*screenshots.*\.spec\.ts/,
      use: { browserName: "chromium" },
    },
  ],
});
