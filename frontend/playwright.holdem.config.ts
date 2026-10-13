import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const reportPath = process.env.HOLDEM_TEST_REPORT_PATH || resolve("../demo-output/holdem-20261004-root/report.json");
const optionalReports = [["HOLDEM_DELIVERY_REPORT_PATH", process.env.HOLDEM_TEST_DELIVERY_REPORT_PATH], ["HOLDEM_PURCHASE_REPORT_PATH", process.env.HOLDEM_TEST_PURCHASE_REPORT_PATH]].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([name, path]) => `${name}=${quote(path)}`).join(" ");
export default defineConfig({
  testDir: "./test/browser", testMatch: "holdem.spec.ts", workers: 1, retries: 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:3014", launchOptions: { executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, screenshot: "only-on-failure" },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"] } }, { name: "mobile", use: { ...devices["Pixel 5"] } }],
  webServer: { command: `FRONTEND_MODE=fixture HOLDEM_REPORT_PATH=${quote(reportPath)} ${optionalReports} npm run start -- --port 3014`, url: "http://127.0.0.1:3014/arena/holdem", reuseExistingServer: false, timeout: 90_000 },
});
