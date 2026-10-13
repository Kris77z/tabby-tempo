import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Wallet, getBytes, toUtf8String } from "ethers";
import { chromium, devices, expect, type Page } from "@playwright/test";
import { verifyTempoBrowserAudit } from "./tempo-browser-audit.js";

// Read-only browser acceptance. Only the local owner login challenge is signed;
// Allowed requests use real HTTP. A browser route guard blocks unexpected writes,
// external requests and wallet transactions; no API fixtures or saved cookies.
const runtime = resolve(process.argv[2] ?? ".data/tempo-20261012/runtime");
const phase = process.argv.slice(3).find(value => !value.startsWith("--")) ?? "final";
const checkOnly = process.argv.includes("--check");
assert.ok(["baseline", "observed", "final"].includes(phase), "phase must be baseline, observed or final");
const ready = JSON.parse(await readFile(join(runtime, "ready.json"), "utf8"));
assert.equal(ready.chainId, "42431"); assert.equal(ready.frontendOrigin, "http://127.0.0.1:3028");
const bootstrap = JSON.parse(await readFile(ready.bootstrapFile, "utf8"));
assert.equal(bootstrap.chainId, "42431"); assert.equal(bootstrap.frontendOrigin, ready.frontendOrigin);
assert.equal(bootstrap.asset.symbol, "PathUSD"); assert.equal(bootstrap.asset.decimals, 6);
const gateway = JSON.parse(await readFile(bootstrap.gatewayReadyFile, "utf8"));
const gatewayDirectory = dirname(bootstrap.gatewayReadyFile);
const healthUrl = new URL(gateway.bridgeHealthUrl);
assert.equal(healthUrl.protocol, "http:"); assert.equal(healthUrl.hostname, "127.0.0.1");
assert.equal(healthUrl.pathname, "/health"); assert.equal(healthUrl.search, "");
assert.equal(healthUrl.username + healthUrl.password, "");
if (checkOnly) {
  console.log(JSON.stringify({ checked: true, chainId: ready.chainId, frontendOrigin: ready.frontendOrigin, registryMode: ready.registryMode,
    settlement: "test PathUSD, 6 decimals", businessOperationsStarted: 0, modelRequestsStarted: 0 }));
  process.exit(0);
}
const acceptance = JSON.parse(await readFile(join(runtime, "acceptance.json"), "utf8"));
const agentKinds = ["cheap", "strong", "autonomy", ...(acceptance.agents["autonomy-validation"] ? ["autonomy-validation"] : [])];
const expectedSuccesses = (kind: string) => kind === "autonomy-validation" ? 2 : kind === "autonomy" && !acceptance.agents["autonomy-validation"] ? 2 : 1;
const entries = agentKinds.map(kind => { assert.ok(acceptance.agents[kind]?.agent?.id, `${kind} agent has not been created`); return { kind, ...acceptance.agents[kind] }; });
const auditFile = process.argv.slice(3).find(value => value.startsWith("--canonical-audit="))?.slice("--canonical-audit=".length);
const canonicalHistory = phase === "final" && auditFile ? verifyTempoBrowserAudit(JSON.parse(await readFile(resolve(auditFile), "utf8")), bootstrap.contracts, entries) : undefined;
if (phase === "final") {
  for (const entry of entries) {
    const run = acceptance.runs[entry.kind]?.result;
    const preservedFailedWindow = entry.kind === "autonomy" && Boolean(acceptance.agents["autonomy-validation"]);
    assert.equal(run?.status, preservedFailedWindow ? "Failed" : "Succeeded", `${entry.kind} original run must have its actual terminal status`);
    assert.equal(run.result?.terminal, true);
    assert.equal(entry.financeAfter?.status, "confirmed", `${entry.kind} needs its confirmed final finance snapshot`);
    assert.equal(entry.financeAfter.chainId, "42431");
    assert.equal(entry.financeAfter.debtRaw, "0", `${entry.kind} must have no outstanding task debt`);
    if (entry.kind.startsWith("autonomy")) assert.equal(run.result?.autonomousTasks, expectedSuccesses(entry.kind), "Each parent needs its own completed task count");
    else assert.equal(run.result?.settlement?.passed, true, `${entry.kind} needs independent task settlement`);
  }
}
const owner = new Wallet((await readFile(join(runtime, "owner.key"), "utf8")).trim());
const output = resolve("frontend/acceptance/tempo-hosted-20261012"); await mkdir(output, { recursive: true });
const report: any = { phase, observedAt: new Date().toISOString(), frontendOrigin: ready.frontendOrigin, chainId: ready.chainId,
  completeBusinessAcceptance: phase === "final",
  canonicalHistory,
  authentication: "real owner personal_sign in Node; real hosted HTTP; no API mocks", paidOperationsStarted: 0, businessOperationsStarted: 0, registryMode: ready.registryMode, settlement: "test PathUSD", surfaces: [], issues: [] };
async function counters() {
  const response = await fetch(healthUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
  assert.equal(response.ok, true); const health = await response.json();
  assert.equal(health.ready, true); assert.ok(Number.isSafeInteger(health.acceptedRequests));
  const journal = await readFile(join(gatewayDirectory, "attempts.jsonl"), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return { acceptedRequests: health.acceptedRequests, attemptRecords: journal.trim() ? journal.trim().split("\n").length : 0 };
}
report.modelCountersBefore = await counters();
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
    await context.route("**/*", route => {
      const request = route.request(), url = new URL(request.url());
      const allowed = url.origin === ready.frontendOrigin && (request.method() === "GET" || request.method() === "POST" &&
        ["/api/hosted/auth/challenge", "/api/hosted/auth/login"].includes(url.pathname));
      if (!allowed) {
        report.issues.push({ surface: name, issue: "Blocked unexpected request", method: request.method(), path: url.pathname });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    try {
      const page = await context.newPage(); await page.bringToFront();
      surface.visibility = [];
      await page.exposeFunction("__recordVisibility", (state: string) => surface.visibility.push({ at: new Date().toISOString(), state }));
      await page.addInitScript({ content: `(() => {
        const report = () => window.__recordVisibility(document.visibilityState);
        document.addEventListener("visibilitychange", report); report();
      })();` });
      page.on("pageerror", error => surface.pageErrors.push(error.message));
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/hosted")) {
          if (request.method() !== "GET" && !["/api/hosted/auth/challenge", "/api/hosted/auth/login"].includes(url.pathname))
            report.issues.push({ surface: name, issue: "Unexpected business mutation", method: request.method(), path: url.pathname });
        }
      });
      page.on("requestfailed", request => surface.requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
      page.on("response", async response => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith("/api/hosted")) return;
        const record: any = { method: response.request().method(), path, status: response.status() };
        surface.http.push(record);
        if (path.endsWith("/finance") && response.ok()) { try {
          const value = await response.json(); finances.set(path.split("/").at(-2)!, value);
          record.financeStatus = value.status; record.financeReason = value.reason;
        } catch { /* capture incomplete reads separately */ } }
      });
      await page.exposeFunction("__tempoOwnerWallet", async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
        surface.walletMethods.push(method);
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [owner.address];
        if (method === "eth_chainId") return "0xa5bf";
        if (method === "personal_sign") {
          assert.equal(String(params[1]).toLowerCase(), owner.address.toLowerCase());
          const encoded = String(params[0]), message = encoded.startsWith("0x") ? toUtf8String(getBytes(encoded)) : encoded;
          const prefix = `AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 42431\nNonce: `;
          assert.ok(message.startsWith(prefix), "Only this Tempo hosted login challenge may be signed");
          const lines = message.slice(prefix.length).split("\n");
          assert.equal(lines.length, 3); assert.match(lines[0], /^[A-Za-z0-9_-]{1,160}$/);
          assert.ok(lines[1].startsWith("Expires: "));
          const expiry = Date.parse(lines[1].slice("Expires: ".length));
          assert.ok(expiry > Date.now() && expiry <= Date.now() + 301000);
          assert.ok(message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
          surface.signatures++; return owner.signMessage(message);
        }
        throw new Error(`Read-only wallet rejects ${method}`);
      });
      await page.addInitScript({ content: `(() => {
        const listeners = new Map();
        Object.defineProperty(window, "ethereum", { configurable: true, value: {
          request: call => window.__tempoOwnerWallet(call),
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
        await page.bringToFront();
        await select.selectOption(entry.agent.id);
        await expect(select).toHaveValue(entry.agent.id);
        if (name === "mobile") await page.getByRole("tab", { name: "资源", exact: true }).click();
        const financial = page.getByTestId("hosted-financial-snapshot");
        await expect(financial).toContainText("已核验快照", { timeout: 160000 });
        const chainAgentId = entry.financeAfter?.agentId ?? entry.financeBefore?.agentId ?? entry.agent.binding?.agentId;
        await expect(financial).toContainText(`CHAIN IDENTITY · #${chainAgentId}`);
        await expect.poll(() => finances.get(entry.agent.id)?.agentId, { timeout: 10000 }).toBe(chainAgentId);
        const finance = finances.get(entry.agent.id); assert.equal(finance.status, "confirmed");
        assert.equal(finance.chainId, "42431"); assert.equal(finance.wallet.toLowerCase(), entry.agent.wallet.toLowerCase());
        if (phase === "final") {
          for (const field of ["cashRaw", "debtRaw", "ownedTaskCount", "credit", "counts", "policy"])
            assert.deepEqual(finance[field], entry.financeAfter[field], `${entry.kind} live ${field} differs from final acceptance`);
          const history = canonicalHistory?.labels[entry.kind];
          const expectedTasks = history?.successfulTaskIds.length ?? expectedSuccesses(entry.kind);
          assert.equal(BigInt(finance.counts.successes) - BigInt(entry.financeBefore.counts.successes), BigInt(expectedTasks));
          assert.equal(BigInt(finance.counts.repayments) - BigInt(entry.financeBefore.counts.repayments), BigInt(expectedTasks));
          assert.equal(finance.ownedTaskCount - entry.financeBefore.ownedTaskCount, expectedTasks + (history?.compensatedTaskIds.length ?? 0));
          assert.equal(finance.counts.defaults, entry.financeBefore.counts.defaults);
        }
        await expect(financial).toContainText(`InferScore ${finance.credit.score}`);
        await expect(financial).toContainText("PathUSD");
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
        if (phase === "final") {
          const originalId = acceptance.runs[entry.kind].input.requestId;
          const card = page.getByTestId(`hosted-run-${originalId}`);
          await expect(card).toBeVisible();
          await expect(card).toContainText(entry.kind === "autonomy" && acceptance.agents["autonomy-validation"] ? "失败" : "已完成");
          if (entry.kind.startsWith("autonomy")) await expect(card).toContainText(`${expectedSuccesses(entry.kind)} 单`);
        }
        await capture(page, `${entry.kind}-requests`, surface);
        const links = await history.locator('a[href*="/tx/"]').evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href));
        assert.ok(links.every(url => /^https:\/\/explore\.testnet\.tempo\.xyz\/tx\/0x[0-9a-f]{64}$/i.test(url)), "Every visible receipt must use the Tempo testnet explorer");
        if (phase === "final" && entry.kind !== "autonomy") assert.ok(links.length > 0, "Completed tasks need a settlement link");
        surface.agents.push({ kind: entry.kind, id: entry.agent.id, name: entry.agent.name, finance, financialText, requestsText: historyText,
          transactionLinks: links, alerts: (await page.getByRole("alert").allTextContents()).filter(text => text.trim()) });
        if (name === "mobile") {
          await page.getByRole("tab", { name: "Agent", exact: true }).click();
          await expect(page.getByTestId("hosted-panel-agent")).toContainText(entry.agent.name);
          await capture(page, `${entry.kind}-agent`, surface);
        }
      }
      if (name === "mobile") await page.getByRole("tab", { name: "请求", exact: true }).click();
      await page.getByRole("button", { name: /资金与额度$/ }).click();
      await expect(page.getByLabel("入账金额（PathUSD）", { exact: true })).toBeVisible();
      if (phase === "final") await expect(page.getByTestId("hosted-action-dock")).toContainText("PathUSD 同时用于结算与手续费；确认入账时请保留手续费余额。");
      await capture(page, "pathusd-fee-reserve", surface);
      if (surface.pageErrors.length) report.issues.push({ surface: name, issue: "pageerror", errors: surface.pageErrors });
      const failedHttp = surface.http.filter((response: any) => response.status >= 400 && response.status !== 401);
      if (failedHttp.length) report.issues.push({ surface: name, issue: "HTTP failure", responses: failedHttp });
      assert.ok(surface.walletMethods.every((method: string) => ["eth_accounts", "eth_requestAccounts", "eth_chainId", "personal_sign"].includes(method)));
    } catch (error) {
      report.issues.push({ surface: name, issue: "acceptance failed", message: (error as Error).message });
      const page = context.pages()[0]; if (page) await capture(page, "failure", surface).catch(() => undefined);
    } finally { await context.close(); }
  }
  const advancedStarted = Date.now();
  try {
    const response = await fetch(ready.frontendOrigin + "/advanced", { redirect: "error", signal: AbortSignal.timeout(300000) });
    const headersMs = Date.now() - advancedStarted, html = await response.text();
    report.advanced = { status: response.status, headersMs, totalMs: Date.now() - advancedStarted,
      configuredSnapshot: html.includes("CHAIN SNAPSHOT"), tempoAssetVisible: html.includes("PathUSD"),
      unknownLedger: html.includes("READ UNAVAILABLE"), fixture: html.includes("FIXTURE") };
    assert.equal(response.status, 200); assert.equal(report.advanced.configuredSnapshot, true, "Protocol SSR must complete a verified snapshot");
    assert.equal(report.advanced.tempoAssetVisible, true); assert.equal(report.advanced.unknownLedger, false); assert.equal(report.advanced.fixture, false);
  } catch (error) { report.issues.push({ surface: "advanced", issue: "SSR acceptance failed", message: (error as Error).message }); }
} finally {
  await browser.close();
  try {
    report.modelCountersAfter = await counters();
    report.noNewModelRequests = report.modelCountersBefore.acceptedRequests === report.modelCountersAfter.acceptedRequests && report.modelCountersBefore.attemptRecords === report.modelCountersAfter.attemptRecords;
    if (!report.noNewModelRequests) report.issues.push({ issue: "Model counters changed during read-only acceptance" });
  } catch { report.issues.push({ issue: "Final read-only model counters unavailable" }); }
  await writeFile(join(output, `${phase}-report.json`), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ phase, surfaces: report.surfaces.map((surface: any) => ({ name: surface.name, signatures: surface.signatures, agents: surface.agents.length, screenshots: surface.screenshots.length, pageErrors: surface.pageErrors.length })), issues: report.issues, output }));
if (report.issues.length) process.exitCode = 1;
