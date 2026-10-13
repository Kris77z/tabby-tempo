import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", testIgnore: ["**/rejection-evidence.spec.ts", "**/holdem.spec.ts", "**/hosted-agents.spec.ts", "**/hosted-financial.spec.ts", "**/hosted-onboarding.spec.ts", "**/terminal-pages.spec.ts", "**/landing.spec.ts", "**/landing-motion.spec.ts"], fullyParallel: false, workers: 1, retries: 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:3010", launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, screenshot: "only-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["Pixel 5"] } }],
  webServer: { command: "FRONTEND_MODE=fixture npm run dev -- --port 3010", url: "http://127.0.0.1:3010", reuseExistingServer: false, timeout: 90_000 },
});
