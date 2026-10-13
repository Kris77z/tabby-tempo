import { defineConfig, devices } from "@playwright/test";

// Isolated fixture rendering and in-memory practice engines. No public executor,
// wallet transaction or paid inference is reachable from this acceptance suite.
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "terminal-pages.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results/terminal-pages",
  use: {
    baseURL: "http://127.0.0.1:3015",
    launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1512, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3015",
    env: {
      NEXT_DIST_DIR: ".next-terminal-test", FRONTEND_MODE: "fixture",
      HOLDEM_REPORT_PATH: "", HOLDEM_DELIVERY_REPORT_PATH: "", HOLDEM_PURCHASE_REPORT_PATH: "",
      HOSTED_AGENTS_URL: "", HOSTED_FRONTEND_ORIGIN: "",
    },
    url: "http://127.0.0.1:3015/arena",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
