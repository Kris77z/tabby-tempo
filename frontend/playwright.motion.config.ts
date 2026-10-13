import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.LANDING_MOTION_BASE_URL || "http://127.0.0.1:3026";

// First-paint motion acceptance runs separately from the hosted/browser fixture suites.
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "landing-motion.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results/landing-motion",
  use: {
    baseURL,
    launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    { name: "narrow", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 740 } } },
  ],
  webServer: process.env.LANDING_MOTION_BASE_URL ? undefined : {
    command: "npm run dev -- --port 3026",
    env: { NEXT_DIST_DIR: ".next-motion-test", FRONTEND_MODE: "fixture", HOSTED_AGENTS_URL: "", HOSTED_FRONTEND_ORIGIN: "" },
    url: "http://127.0.0.1:3026",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
