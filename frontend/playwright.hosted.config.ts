import { defineConfig, devices } from "@playwright/test";

// This suite uses intercepted synthetic API responses and a local signer only.
// Empty hosted configuration also prevents a missed route from reaching an executor.
export default defineConfig({
  testDir: "./test/browser",
  testMatch: ["hosted-agents.spec.ts", "hosted-financial.spec.ts", "hosted-onboarding.spec.ts", "tempo-hosted.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "./test-results/hosted-agents",
  use: {
    baseURL: "http://127.0.0.1:3014",
    launchOptions: {
      executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1512, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
  webServer: {
    command: "npm run dev -- --port 3014",
    env: { NEXT_DIST_DIR: ".next-hosted-test", HOSTED_AGENTS_URL: "", HOSTED_FRONTEND_ORIGIN: "" },
    url: "http://127.0.0.1:3014",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
