import { defineConfig, devices } from "@playwright/test";

const landingPort = Number(process.env.LANDING_TEST_PORT ?? 3024);

// Landing/navigation acceptance only. Hosted executors and external requests are blocked.
export default defineConfig({
  testDir: "./test/browser",
  testMatch: "landing.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results/landing",
  use: {
    baseURL: `http://127.0.0.1:${landingPort}`,
    launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    { name: "narrow", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 740 } } },
  ],
  webServer: {
    command: `npm run dev -- --port ${landingPort}`,
    env: { NEXT_DIST_DIR: ".next-landing-test", FRONTEND_MODE: "fixture", HOSTED_AGENTS_URL: "", HOSTED_FRONTEND_ORIGIN: "" },
    url: `http://127.0.0.1:${landingPort}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
