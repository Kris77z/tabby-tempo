import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Wallet, getBytes, toUtf8String } from "ethers";
import { chromium, devices, expect, type Page } from "@playwright/test";

// Read-only browser acceptance. Only the local owner login challenge is signed;
// no HTTP routing/mocks, wallet transaction methods, business POSTs or stored cookies.
const runtime = resolve(process.argv[2] ?? "demo-output/local-hosted-20261012/runtime");
const phase = process.argv[3] ?? "baseline";
assert.ok(["baseline", "final"].includes(phase), "phase must be baseline or final");
const ready = JSON.parse(await readFile(join(runtime, "ready.json"), "utf8"));
assert.equal(ready.chainId, "31337"); assert.equal(ready.frontendOrigin, "http://127.0.0.1:3024");
const acceptance = JSON.parse(await readFile(join(runtime, "acceptance.json"), "utf8"));
const agentKinds = ["cheap", "strong", "autonomy", ...(acceptance.agents["autonomy-credit"] ? ["autonomy-credit"] : [])];
const entries = agentKinds.map(kind => { assert.ok(acceptance.agents[kind]?.agent?.id, `${kind} agent has not been created`); return { kind, ...acceptance.agents[kind] }; });
const owner = new Wallet((await readFile(join(runtime, "owner.key"), "utf8")).trim());
const output = resolve("frontend/acceptance/local-real-20261012"); await mkdir(output, { recursive: true });
const report: any = { phase, observedAt: new Date().toISOString(), frontendOrigin: ready.frontendOrigin, chainId: ready.chainId,
  authentication: "real owner personal_sign in Node; real hosted HTTP; no API mocks", paidOperationsStarted: 0, surfaces: [], issues: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
async function capture(page: Page, name: string, surface: any) {
  const file = join(output, `${phase}-${surface.name}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const dimensions = await page.evaluate(() => {
    const panels = [];
    for (const id of ["panel-agent", "panel-requests", "panel-resources"]) {
      const element = document.getElementById(id);
      if (element && element.getBoundingClientRect().height > 0) panels.push({ id, visibleHeight: element.clientHeight, contentHeight: element.scrollHeight });
    }
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, panels };
  });
  surface.screenshots.push({ file, ...dimensions });
  if (dimensions.scrollWidth > dimensions.viewport + 1) report.issues.push({ surface: surface.name, name, issue: "horizontal overflow", ...dimensions });
}
try {
  for (const [name, settings] of [["desktop", { viewport: { width: 1440, height: 1000 } }], ["mobile", { ...devices["Pixel 5"] }]] as const) {
    const context = await browser.newContext({ ...settings, locale: "zh-CN" });
    const surface: any = { name, walletMethods: [], signatures: 0, http: [], requestFailures: [], pageErrors: [], screenshots: [], agents: [] }; report.surfaces.push(surface);
    const finances = new Map<string, any>();
    try {
      const page = await context.newPage();
      page.on("pageerror", error => surface.pageErrors.push(error.message));
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/hosted")) {
          if (request.method() !== "GET" && !["/api/hosted/auth/challenge", "/api/hosted/auth/login", "/api/hosted/auth/logout"].includes(url.pathname))
            report.issues.push({ surface: name, issue: "Unexpected business mutation", method: request.method(), path: url.pathname });
        }
      });
      page.on("requestfailed", request => surface.requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
      page.on("response", async response => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith("/api/hosted")) return;
        surface.http.push({ method: response.request().method(), path, status: response.status() });
        if (path.endsWith("/finance") && response.ok()) { try { finances.set(path.split("/").at(-2)!, await response.json()); } catch { /* capture incomplete reads separately */ } }
      });
      await page.exposeFunction("__localOwnerWallet", async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
        surface.walletMethods.push(method);
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [owner.address];
        if (method === "eth_chainId") return "0x7a69";
        if (method === "personal_sign") {
          assert.equal(String(params[1]).toLowerCase(), owner.address.toLowerCase());
          const encoded = String(params[0]), message = encoded.startsWith("0x") ? toUtf8String(getBytes(encoded)) : encoded;
          const prefix = `AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 31337\nNonce: `;
          assert.ok(message.startsWith(prefix), "Only this local hosted login challenge may be signed");
          assert.ok(message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
          surface.signatures++; return owner.signMessage(message);
        }
        throw new Error(`Read-only wallet rejects ${method}`);
      });
      await page.addInitScript({ content: `(() => {
        const listeners = new Map();
        Object.defineProperty(window, "ethereum", { configurable: true, value: {
          request: call => window.__localOwnerWallet(call),
          on: (event, listener) => { const current = listeners.get(event) || new Set(); current.add(listener); listeners.set(event, current); },
          removeListener: (event, listener) => { const current = listeners.get(event); if (current) current.delete(listener); },
        } });
      })();` });
      await page.goto(ready.frontendOrigin + "/dashboard", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "签名登录", exact: true }).click();
      await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeVisible({ timeout: 30000 });
      const select = page.getByLabel("当前 Agent", { exact: true }); await expect(select).toBeVisible({ timeout: 30000 });
      assert.equal(surface.signatures, 1);
      for (const entry of entries) {
        await select.selectOption(entry.agent.id);
        await expect(select).toHaveValue(entry.agent.id);
        if (name === "mobile") await page.getByRole("tab", { name: "资源", exact: true }).click();
        const financial = page.getByTestId("hosted-financial-snapshot");
        await expect(financial).toContainText("已核验快照", { timeout: 60000 });
        const chainAgentId = entry.financeBefore?.agentId ?? entry.agent.binding?.agentId;
        await expect(financial).toContainText(`CHAIN IDENTITY · #${chainAgentId}`);
        await expect.poll(() => finances.get(entry.agent.id)?.agentId, { timeout: 10000 }).toBe(chainAgentId);
        const finance = finances.get(entry.agent.id); assert.equal(finance.status, "confirmed");
        await expect(financial).toContainText(`InferScore ${finance.credit.score}`);
        if (name === "mobile") await page.locator("#panel-resources > div").filter({ has: financial }).evaluate(element => { element.scrollTop = 0; });
        await capture(page, `${entry.kind}-resources`, surface);
        const financialText = await financial.innerText();
        if (name === "mobile") {
          const scrollable = page.locator("#panel-resources > div").filter({ has: financial });
          const pages = await scrollable.evaluate(element => {
            const snapshot = element.querySelector('[data-testid="hosted-financial-snapshot"]')!;
            const bottom = snapshot.getBoundingClientRect().bottom - element.getBoundingClientRect().top + element.scrollTop;
            return Math.ceil(Math.max(0, bottom - element.clientHeight) / Math.max(1, element.clientHeight - 20));
          });
          for (let index = 1; index <= pages; index++) {
            const position = await scrollable.evaluate(element => {
              element.scrollTop += Math.max(1, element.clientHeight - 20);
              return { scrollTop: element.scrollTop, visibleHeight: element.clientHeight, contentHeight: element.scrollHeight };
            });
            assert.ok(position.scrollTop > 0, "Mobile resource content must actually scroll");
            await capture(page, `${entry.kind}-resources-scrolled-${index}`, surface);
            surface.screenshots.at(-1).resourceScroll = position;
          }
          await page.getByRole("tab", { name: "请求", exact: true }).click();
        }
        const history = page.getByRole("region", { name: "请求记录", exact: true }); await expect(history).toBeVisible();
        const historyText = await history.innerText(); assert.ok(historyText.includes("已确认推理费"), "Confirmed provisioning/deposit should appear in request history");
        await capture(page, `${entry.kind}-requests`, surface);
        surface.agents.push({ kind: entry.kind, id: entry.agent.id, name: entry.agent.name, finance, financialText, requestsText: historyText,
          alerts: (await page.getByRole("alert").allTextContents()).filter(text => text.trim()) });
        if (name === "mobile") {
          await page.getByRole("tab", { name: "Agent", exact: true }).click();
          await expect(page.getByTestId("hosted-panel-agent")).toContainText(entry.agent.name);
          await capture(page, `${entry.kind}-agent`, surface);
        }
      }
      if (surface.pageErrors.length) report.issues.push({ surface: name, issue: "pageerror", errors: surface.pageErrors });
      const failedHttp = surface.http.filter((response: any) => response.status >= 400 && response.status !== 401);
      if (failedHttp.length) report.issues.push({ surface: name, issue: "HTTP failure", responses: failedHttp });
      assert.ok(surface.walletMethods.every((method: string) => ["eth_accounts", "eth_requestAccounts", "eth_chainId", "personal_sign"].includes(method)));
    } catch (error) {
      report.issues.push({ surface: name, issue: "acceptance failed", message: (error as Error).message });
      const page = context.pages()[0]; if (page) await capture(page, "failure", surface).catch(() => undefined);
    } finally { await context.close(); }
  }
} finally {
  await browser.close(); await writeFile(join(output, `${phase}-report.json`), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ phase, surfaces: report.surfaces.map((surface: any) => ({ name: surface.name, signatures: surface.signatures, agents: surface.agents.length, screenshots: surface.screenshots.length, pageErrors: surface.pageErrors.length })), issues: report.issues, output }));
if (report.issues.length) process.exitCode = 1;
