import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", testMatch: "rejection-evidence.spec.ts", workers: 1, retries: 0, reporter: "list",
  use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } },
});
