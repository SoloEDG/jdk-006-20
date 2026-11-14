import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5199",
  },
  webServer: {
    command: "npm run dev -- --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
