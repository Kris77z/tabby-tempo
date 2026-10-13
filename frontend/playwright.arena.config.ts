import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser", testMatch: "arena-play.spec.ts", workers: 1, retries: 0, reporter: "list",
  use: { baseURL: process.env.ARENA_TEST_URL || "http://127.0.0.1:3020", launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, screenshot: "only-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1512, height: 900 } } }, { name: "mobile", use: { ...devices["Pixel 5"] } }],
});
