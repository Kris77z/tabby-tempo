import { test, expect, type Page, type Route } from "@playwright/test";
import { Wallet, getBytes, toUtf8String } from "ethers";
import type { HostedAgent, HostedRun } from "../../../services/hosted-agents/src/types";
import { accountingFixture, accountingTime } from "../accounting-fixture";

const owner = "0x" + "1".repeat(40);
const actor = (id: string, accountOwner = owner): HostedAgent => ({ id, owner: accountOwner, name: id, wallet: "0x" + (id.endsWith("b") ? "3" : "2").repeat(40), status: "Ready", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", spentRaw: "0", reservedRaw: "0", allowCredit: true, createdAt: accountingTime, updatedAt: accountingTime });
const a = actor("accounting-agent-a"), b = actor("accounting-agent-b");
const fallback = (route: Route) => route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
const panel = (page: Page) => page.getByTestId("hosted-accounting");
async function mobilePane(page: Page, label: "agent.sys" | "mission.log") {
  const tab = page.getByRole("tab", { name: label, exact: true });
  if (await tab.isVisible()) await tab.click();
}
async function switchAgent(page: Page, agent: HostedAgent) {
  await mobilePane(page, "agent.sys");
  await page.getByRole("combobox", { name: "切换 Agent", exact: true }).click();
  await page.getByRole("option", { name: agent.name, exact: true }).click();
  await mobilePane(page, "mission.log");
}
async function refreshSnapshot(page: Page) {
  await page.getByRole("button", { name: "账户菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "刷新数据", exact: true }).click();
}

test("operating amounts preserve six decimal precision, distinguish capital and subsidies, and keep labelled stale results", async ({ page }) => {
  let reads = 0, fail = false; const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/hosted/agents") return route.fulfill({ json: { owner, agents: [a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/accounting`)) { reads++; return fail ? route.abort("connectionfailed") : route.fulfill({ json: accountingFixture(a.id) }); }
    return fallback(route);
  });
  await page.goto("/dashboard"); await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible(); expect(reads).toBe(0);
  await page.getByRole("tab", { name: "资金与借贷", exact: true }).click();
  await expect(panel(page)).toContainText("−0.020003 USDC"); await expect(panel(page)).toContainText("0.120001 USDC"); await expect(panel(page)).toContainText("0.000002 USDC");
  await panel(page).getByText("补贴、资本与 token", { exact: true }).click();
  await expect(panel(page)).toContainText("游戏 USDC 补贴0.3 USDC"); await expect(panel(page)).toContainText("充值入账1 USDC");
  await expect(panel(page)).toContainText("获赠 token10,000"); await expect(panel(page)).toContainText("推理使用 token（含付费及补贴）215"); await expect(panel(page)).toContainText("MON Gas 未纳入"); await expect(panel(page)).toContainText("已核对条目 1/1（100%）");
  expect(await panel(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  fail = true; await panel(page).getByRole("button", { name: "刷新经营账" }).click();
  await expect(panel(page)).toContainText("以下保留上次结果"); await expect(panel(page)).toContainText("−0.020003 USDC");
  expect(reads).toBe(2); expect(writes).toEqual([]); expect(errors).toEqual([]);
});

test("partial accounting keeps unresolved net unknown and a 401 removes the owner's data", async ({ page }) => {
  let expired = false;
  const value = accountingFixture(a.id); value.status = "partial"; value.totals.netOperatingRaw = null;
  value.coverage.incompleteCount = 1; value.coverage.uncoveredSpentRaw = "3"; value.coverage.reasons = ["ACCOUNTING_PAYMENT_UNRESOLVED", "ACCOUNTING_HISTORY_MISSING"]; value.entries[0].status = "incomplete";
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { owner, agents: [a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/accounting`)) return route.fulfill(expired ? { status: 401, json: { error: "HOSTED_AUTH_REQUIRED" } } : { json: value });
    return fallback(route);
  });
  await page.goto("/dashboard?panel=finance");
  await expect(panel(page)).toContainText("经营净额待核算"); await expect(panel(page)).toContainText("部分付款结果待确认"); await expect(panel(page)).toContainText("已核对条目 0/1（0%）");
  await expect(panel(page)).toContainText("累计支出中有 0.000003 USDC 缺少历史记录");
  expired = true; await panel(page).getByRole("button", { name: "刷新经营账" }).click();
  await expect(panel(page)).toHaveCount(0); await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
  await expect(page.getByTestId("hosted-center-surface")).not.toContainText("0.120001 USDC");
});

test("late reads cannot replace a different Agent and an identity mismatch keeps no new totals", async ({ page }) => {
  let release!: () => void, mismatch = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const other = accountingFixture(b.id); other.totals.taskRevenueRaw = "700001"; other.totals.netOperatingRaw = "580000";
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { owner, agents: [a, b], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/accounting`)) { await gate; return route.fulfill({ json: accountingFixture(a.id) }); }
    if (path.endsWith(`/${b.id}/accounting`)) return route.fulfill({ json: mismatch ? accountingFixture(a.id) : other });
    return fallback(route);
  });
  try {
    await page.goto("/dashboard?panel=finance"); await expect(panel(page)).toContainText("正在读取");
    await switchAgent(page, b); await expect(panel(page)).toContainText("0.700001 USDC");
    const oldResponse = page.waitForResponse(response => response.url().endsWith(`/${a.id}/accounting`)); release(); await oldResponse;
    await expect(panel(page)).not.toContainText("−0.020003 USDC");
    mismatch = true; await panel(page).getByRole("button", { name: "刷新经营账" }).click();
    await expect(panel(page)).toContainText("以下保留上次结果"); await expect(panel(page)).toContainText("0.700001 USDC");
  } finally { release(); }
});

test("a completed request during an accounting read causes one latest read after the original settles", async ({ page }) => {
  let release!: () => void, reads = 0, complete = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const run: HostedRun = { requestId: "latest-run", agentId: a.id, action: "goal", status: "Succeeded", createdAt: accountingTime, updatedAt: accountingTime, reservedRaw: "0", chargedRaw: "1", recoverable: false };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { owner, agents: [a], runs: complete ? [run] : [], models: [] } });
    if (path.endsWith(`/${a.id}/accounting`)) {
      const number = ++reads, value = accountingFixture(a.id); if (number === 1) await gate;
      if (number > 1) value.totals.netOperatingRaw = "-20004";
      return route.fulfill({ json: value });
    }
    return fallback(route);
  });
  try {
    await page.goto("/dashboard?panel=finance"); await expect.poll(() => reads).toBe(1);
    complete = true; await refreshSnapshot(page); release();
    await expect(panel(page)).toContainText("−0.020004 USDC"); expect(reads).toBe(2);
  } finally { release(); }
});

test("login waits for accounting transports after the view closes and isolates a new owner with the same Agent id", async ({ page }) => {
  const signer = new Wallet("0x" + "2".repeat(64)), nextAgent = actor(a.id, signer.address);
  const oldToken = "a".repeat(64), newToken = "b".repeat(64), cookieName = "agentfuel_hosted_session";
  const setCookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/api/hosted; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  await page.context().addCookies([{ name: cookieName, value: oldToken, domain: "127.0.0.1", path: "/api/hosted", httpOnly: true, sameSite: "Strict" }]);
  await page.exposeFunction("__accountingWallet", async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [signer.address];
    if (method === "eth_chainId") return "0x279f";
    if (method === "personal_sign") return signer.signMessage(toUtf8String(getBytes(String(params?.[0]))));
    throw new Error(`Unexpected wallet call ${method}`);
  });
  await page.addInitScript(() => {
    const scope = window as unknown as { __accountingWallet: (call: unknown) => Promise<unknown>; ethereum: unknown }, listeners = new Map<string, Set<() => void>>();
    scope.ethereum = { request: (call: unknown) => scope.__accountingWallet(call), on: (event: string, listener: () => void) => { const list = listeners.get(event) ?? new Set(); list.add(listener); listeners.set(event, list); }, removeListener: (event: string, listener: () => void) => listeners.get(event)?.delete(listener), __emit: (event: string) => listeners.get(event)?.forEach(listener => listener()) };
  });
  let release!: () => void, reads = 0, challenges = 0, logins = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), expiresAt = Date.now() + 300000;
  const challenge = { id: "accounting-challenge", expiresAt, message: `AgentFuel hosted agent login\nOrigin: http://127.0.0.1:3014\nWallet: ${signer.address}\nChain: 10143\nNonce: accounting-challenge\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature authenticates your platform account. It authorizes no blockchain transaction.` };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, cookie = route.request().headers().cookie ?? "";
    if (path === "/api/hosted/agents") return route.fulfill({ json: { owner: cookie.includes(newToken) ? signer.address : owner, agents: [cookie.includes(newToken) ? nextAgent : a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/accounting`)) { reads++; if (reads === 1) { await gate; return route.fulfill({ status: 401, json: { error: "HOSTED_AUTH_REQUIRED" }, headers: { "set-cookie": setCookie("", 0) } }); } const value = accountingFixture(a.id); value.totals.netOperatingRaw = "-1"; return route.fulfill({ json: value }); }
    if (path === "/api/hosted/auth/logout") return route.fulfill({ json: { authenticated: false }, headers: { "set-cookie": setCookie("", 0) } });
    if (path === "/api/hosted/auth/challenge") { challenges++; return route.fulfill({ json: challenge }); }
    if (path === "/api/hosted/auth/login") { logins++; return route.fulfill({ json: { authenticated: true, expiresAt }, headers: { "set-cookie": setCookie(newToken, 3600) } }); }
    return fallback(route);
  });
  try {
    await page.goto("/dashboard?panel=finance"); await expect.poll(() => reads).toBe(1);
    await page.getByRole("tab", { name: "任务", exact: true }).click(); await expect(panel(page)).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { ethereum: { __emit: (event: string) => void } }).ethereum.__emit("accountsChanged"));
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeDisabled();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(challenges).toBe(0); expect(logins).toBe(0);
    release(); await expect(page.getByRole("button", { name: "账户菜单", exact: true })).toBeEnabled();
    expect(logins).toBe(1); expect((await page.context().cookies()).find(cookie => cookie.name === cookieName)?.value).toBe(newToken);
    await page.getByRole("tab", { name: "资金与借贷", exact: true }).click();
    await expect(panel(page)).toContainText("−0.000001 USDC"); await expect(panel(page)).not.toContainText("−0.020003 USDC");
  } finally { release(); }
});
