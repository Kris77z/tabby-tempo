import { test, expect, type Page } from "@playwright/test";
import { Wallet, getBytes, toUtf8String, verifyMessage } from "ethers";
import type { HostedAgent, HostedFinance, HostedRun } from "../../../services/hosted-agents/src/types";

// Synthetic browser fixtures only: every API call is intercepted; no RPC, model or chain write.
const timestamp = "2026-10-11T00:00:00.000Z", owner = "0x" + "1".repeat(40);
const hash = (character: string) => "0x" + character.repeat(64);
const actor = (id: string, wallet: string, chainAgentId: string): HostedAgent => ({ id, name: id, owner, wallet,
  modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true,
  createdAt: timestamp, updatedAt: timestamp, status: "Ready", spentRaw: "0", reservedRaw: "0", binding: { chainId: "10143", agentId: chainAgentId, wallet } });
const a = actor("finance-agent-a", "0x" + "2".repeat(40), "9001"), b = actor("finance-agent-b", "0x" + "3".repeat(40), "9002");
function financial(agent: HostedAgent, after = false): Extract<HostedFinance, { status: "confirmed" }> {
  return { status: "confirmed", observedAt: timestamp, chainId: agent.binding!.chainId, agentId: agent.binding!.agentId, wallet: agent.wallet,
    block: { number: after ? 20 : 10, hash: hash(after ? "b" : "a"), timestamp: 1791676800 }, cashRaw: after ? "58000" : "40000", debtRaw: "0", scannedTaskCount: 12, ownedTaskCount: after ? 2 : 1,
    credit: { score: after ? "640" : "570", tier: after ? "B" : "C", tierCapRaw: after ? "500000" : "200000", feeBps: after ? "800" : "1500", eligible: true, rejection: null },
    policy: { maxCashPerTxRaw: "120000", maxDebtPerTxRaw: "120000", maxDebtPerDayRaw: "1000000", ownerFrozen: false },
    counts: { repayments: after ? "2" : "1", defaults: "0", mirrorRepayments: after ? "2" : "1", successes: after ? "2" : "1", mirrorDefaults: "0" } };
}
async function pane(page: Page, name: "资源" | "请求") {
  const tab = page.getByRole("tab", { name, exact: true }); if (await tab.isVisible()) await tab.click();
}
test("own completed credit task refreshes the flywheel and exposes separate canonical transaction evidence", async ({ page }, info) => {
  let agents = [a], runs: HostedRun[] = [], after = false, financeReads = 0;
  const unexpected: string[] = [], failures: string[] = []; page.on("pageerror", error => failures.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (path === "/api/hosted/agents" && method === "GET") return route.fulfill({ json: { agents, runs, models: [{ id: "controlled", label: "Controlled Model" }] } });
    if (path === `/api/hosted/agents/${a.id}/finance` && method === "GET") { financeReads++; return route.fulfill({ json: financial(a, after) }); }
    if (path === `/api/hosted/agents/${a.id}/runs` && method === "POST") {
      const body = route.request().postDataJSON(); expect(body.action).toBe("task");
      after = true; agents = [{ ...a, spentRaw: "120000", updatedAt: "2026-10-11T00:01:00.000Z" }];
      const result: HostedRun = { requestId: body.requestId, agentId: a.id, action: "task", status: "Succeeded", createdAt: timestamp, updatedAt: "2026-10-11T00:01:00.000Z", reservedRaw: "120000", chargedRaw: "120000", recoverable: false,
        result: { phase: "Succeeded", terminal: true, success: true, chargedRaw: "120000", chainId: "10143", taskId: "12", paymentId: hash("f"),
          acceptTxHash: hash("c"), paymentTxHash: hash("d"), txHash: hash("e"), fromCashRaw: "40000", fromCreditRaw: "80000", refundedRaw: "0", principalRaw: "0", feeRaw: "0", cashRaw: "58000",
          settlement: { txHash: hash("e"), block: { number: 19, hash: hash("9"), timestamp: 1791676850 }, passed: true, loanStatus: "2", repaidRaw: "92000", slashedRaw: "0", residualRaw: "58000" } } };
      runs = [result]; return route.fulfill({ status: 202, json: result });
    }
    unexpected.push(`${method} ${path}`); return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源");
  const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel.getByText("570", { exact: true })).toBeVisible(); await expect(panel).toContainText("CHAIN IDENTITY · #9001");
  await expect(panel).toContainText("已核验快照 · chain 10143 · 区块 #10"); expect(financeReads).toBe(1);
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect(panel.getByText("640", { exact: true })).toBeVisible();
  await expect(panel).toContainText("InferScore 570 → 640"); await expect(panel).toContainText("Tier C → B"); await expect(panel).toContainText("真实还款 1 → 2");
  await expect(panel).toContainText("本金上限 0.2 → 0.5 USDC"); expect(financeReads).toBe(2);
  await page.screenshot({ path: info.outputPath("financial-snapshot.png"), fullPage: true });
  await pane(page, "请求");
  const summary = page.getByRole("region", { name: "任务结算摘要" });
  await expect(summary).toContainText("cash 支付 0.04 · 信用支付 0.08 USDC"); await expect(summary).toContainText("实际还款 0.092 USDC"); await expect(summary).toContainText("已足额还款");
  await expect(summary.getByRole("link", { name: /查看结算交易/ })).toHaveAttribute("href", `https://testnet.monadexplorer.com/tx/${hash("e")}`);
  await page.getByText("查看请求与凭证", { exact: true }).click();
  await expect(page.getByRole("link", { name: /查看接单交易/ })).toHaveAttribute("href", `https://testnet.monadexplorer.com/tx/${hash("c")}`);
  await expect(page.getByRole("link", { name: /查看付款交易/ })).toHaveAttribute("href", `https://testnet.monadexplorer.com/tx/${hash("d")}`);
  expect(unexpected).toEqual([]); expect(failures).toEqual([]);
});

test("unavailable reads show unknown values, preserve a labelled prior snapshot and clear it on session expiry", async ({ page }) => {
  let mode: "unavailable" | "confirmed" | "expired" = "unavailable";
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a], runs: [], models: [] } });
    if (path === `/api/hosted/agents/${a.id}/finance`) {
      if (mode === "expired") return route.fulfill({ status: 401, json: { error: "HOSTED_AUTH_REQUIRED" } });
      return route.fulfill({ json: mode === "confirmed" ? financial(a) : { status: "unavailable", observedAt: timestamp, reason: "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE" } });
    }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源"); const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("cash、债务和评分尚不可用"); await expect(panel.getByText("未偿债务（含 fee）", { exact: true })).toHaveCount(0); await expect(panel.getByText("InferScore", { exact: true })).toHaveCount(0);
  mode = "confirmed"; await panel.getByRole("button", { name: "刷新金融快照" }).click(); await expect(panel.getByText("570", { exact: true })).toBeVisible();
  mode = "unavailable"; await panel.getByRole("button", { name: "刷新金融快照" }).click(); await expect(panel).toContainText("以下保留上次已核验快照"); await expect(panel).toContainText("上次快照"); await expect(panel.getByText("570", { exact: true })).toBeVisible();
  mode = "expired"; await panel.getByRole("button", { name: "刷新金融快照" }).click(); await expect(panel).toHaveCount(0); await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
});

test("a slow response from the previous hosted identity cannot replace the selected Agent", async ({ page }) => {
  let release!: () => void, readsA = 0; const gate = new Promise<void>(resolve => { release = resolve; });
  const other = { ...financial(b), cashRaw: "999000", credit: { ...financial(b).credit, score: "710", tier: "A" as const, tierCapRaw: "2000000" } };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a, b], runs: [], models: [] } });
    if (path === `/api/hosted/agents/${a.id}/finance`) { readsA++; await gate; return route.fulfill({ json: financial(a) }); }
    if (path === `/api/hosted/agents/${b.id}/finance`) return route.fulfill({ json: other });
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await expect.poll(() => readsA).toBe(1);
  await page.getByRole("combobox", { name: "当前 Agent" }).selectOption(b.id); await pane(page, "资源");
  const panel = page.getByTestId("hosted-financial-snapshot"); await expect(panel.getByText("710", { exact: true })).toBeVisible(); await expect(panel).toContainText("CHAIN IDENTITY · #9002");
  const response = page.waitForResponse(value => value.url().endsWith(`/${a.id}/finance`)); release(); await response;
  await expect(panel.getByText("710", { exact: true })).toBeVisible(); await expect(panel.getByText("570", { exact: true })).toHaveCount(0); await expect(panel).toContainText("0.999 USDC");
});

test("a suspended finance transport reconnects once without any business operation", async ({ page }) => {
  let reads = 0; const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/finance`)) {
      reads++;
      if (reads === 1) return route.abort("connectionaborted");
      return route.fulfill({ json: financial(a) });
    }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源");
  const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("已核验快照"); await expect(panel.getByText("570", { exact: true })).toBeVisible();
  expect(reads).toBe(2); expect(writes).toEqual([]);
});

test("an HTTP 200 finance timeout reconnects once and stops if the second read also times out", async ({ page }) => {
  let reads = 0, alwaysTimeout = false; const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/finance`)) {
      reads++;
      return route.fulfill({ status: 200, json: reads === 1 || alwaysTimeout
        ? { status: "unavailable", observedAt: timestamp, reason: "HOSTED_FINANCE_TIMEOUT" } : financial(a) });
    }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源"); const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("已核验快照 · chain 10143 · 区块 #10"); expect(reads).toBe(2);
  await expect(panel.getByText("570", { exact: true })).toBeVisible();
  alwaysTimeout = true;
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
  await panel.getByRole("button", { name: "刷新金融快照" }).click();
  await expect(panel).toContainText("链上读取超时"); await page.waitForTimeout(900); expect(reads).toBe(3);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect.poll(() => reads).toBe(4); await expect(panel.getByRole("button", { name: "刷新金融快照" })).toBeEnabled();
  await page.evaluate(() => { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(900); expect(reads).toBe(4);
  await expect(panel).toContainText("链上读取超时"); await expect(panel).toContainText("以下保留上次已核验快照");
  await expect(panel.getByText("570", { exact: true })).toBeVisible(); expect(writes).toEqual([]);
});

test("an HTTP 200 timeout cannot retry for an old Agent or a permanent binding failure", async ({ page }) => {
  let readsA = 0, readsB = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a, b], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/finance`)) { readsA++; return route.fulfill({ status: 200, json: { status: "unavailable", observedAt: timestamp, reason: "HOSTED_FINANCE_TIMEOUT" } }); }
    if (path.endsWith(`/${b.id}/finance`)) { readsB++; return route.fulfill({ status: 200, json: { status: "unavailable", observedAt: timestamp, reason: "HOSTED_FINANCE_BINDING_MISMATCH" } }); }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源"); const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("链上读取超时");
  await page.getByRole("combobox", { name: "当前 Agent" }).selectOption(b.id);
  await expect(panel).toContainText("链上身份或协议配置尚未核验");
  await page.waitForTimeout(900); expect(readsA).toBe(1); expect(readsB).toBe(1);
  await expect(panel).not.toContainText("已核验快照");
  await expect(panel.getByText("未偿债务（含 fee）", { exact: true })).toHaveCount(0);
});

test("offline and background finance recovery waits for resume and remains bounded after a second failure", async ({ page }) => {
  let reads = 0, mode: "confirmed" | "failed" = "confirmed"; const writes: string[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method !== "GET") writes.push(`${method} ${path}`);
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/finance`)) { reads++; return mode === "failed" ? route.abort("internetdisconnected") : route.fulfill({ json: financial(a, reads > 1) }); }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源"); const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("已核验快照"); expect(reads).toBe(1);
  mode = "failed"; await page.context().setOffline(true);
  await panel.getByRole("button", { name: "刷新金融快照" }).click();
  await expect(panel).toContainText("以下保留上次已核验快照"); await expect(panel.getByText("570", { exact: true })).toBeVisible();
  const offlineReads = reads;
  // Wait beyond the reconnect delay: offline status must not consume the retry.
  await page.waitForTimeout(900); expect(reads).toBe(offlineReads);
  mode = "confirmed"; await page.context().setOffline(false);
  await expect(panel).toContainText("已核验快照 · chain 10143 · 区块 #20"); await expect(panel.getByText("640", { exact: true })).toBeVisible();
  expect(reads).toBe(offlineReads + 1);
  // A background page likewise keeps its retry until it becomes visible again.
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }));
  mode = "failed"; const beforeBackground = reads;
  await panel.getByRole("button", { name: "刷新金融快照" }).click();
  await expect(panel).toContainText("以下保留上次已核验快照");
  await page.waitForTimeout(900); expect(reads).toBe(beforeBackground + 1);
  mode = "confirmed";
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(panel).not.toContainText("以下保留上次已核验快照");
  await expect(panel.getByRole("button", { name: "刷新金融快照" })).toBeEnabled(); expect(reads).toBe(beforeBackground + 2);
  mode = "failed"; const beforeFailure = reads;
  await panel.getByRole("button", { name: "刷新金融快照" }).click();
  await expect.poll(() => reads).toBe(beforeFailure + 2);
  await expect(panel.getByRole("button", { name: "刷新金融快照" })).toBeEnabled();
  await page.evaluate(() => { for (let index = 0; index < 4; index++) { window.dispatchEvent(new Event("online")); document.dispatchEvent(new Event("visibilitychange")); } });
  await page.waitForTimeout(900); expect(reads).toBe(beforeFailure + 2);
  await expect(panel).toContainText("以下保留上次已核验快照"); expect(writes).toEqual([]);
});

test("a failed identity cannot retry after Agent selection changes, and chain unavailability is not retried", async ({ page }) => {
  let readsA = 0, readsB = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/hosted/agents") return route.fulfill({ json: { agents: [a, b], runs: [], models: [] } });
    if (path.endsWith(`/${a.id}/finance`)) { readsA++; return route.abort("connectionaborted"); }
    if (path.endsWith(`/${b.id}/finance`)) { readsB++; return route.fulfill({ json: { status: "unavailable", observedAt: timestamp, reason: "HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE" } }); }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  await page.goto("/dashboard"); await pane(page, "资源"); const panel = page.getByTestId("hosted-financial-snapshot");
  await expect(panel).toContainText("cash、债务和评分尚不可用");
  await page.getByRole("combobox", { name: "当前 Agent" }).selectOption(b.id);
  await expect(panel).toContainText("Underwriter 暂时不可用");
  await page.waitForTimeout(900); expect(readsA).toBe(1); expect(readsB).toBe(1);
  await expect(panel.getByText("未偿债务（含 fee）", { exact: true })).toHaveCount(0);
});

for (const destination of ["dashboard", "onboarding"]) test(`fresh login on ${destination} waits for an earlier finance 401 so its Set-Cookie cannot clear the new session`, async ({ page }) => {
  const signer = new Wallet("0x" + "1".repeat(64)), agent = { ...a, owner: signer.address };
  const cookieName = "agentfuel_hosted_session", oldToken = "a".repeat(64), newToken = "b".repeat(64);
  await page.context().addCookies([{ name: cookieName, value: oldToken, domain: "127.0.0.1", path: "/api/hosted", httpOnly: true, sameSite: "Strict" }]);
  await page.exposeFunction("__financialWallet", async (call: { method: string; params?: unknown[] }) => {
    if (["eth_accounts", "eth_requestAccounts"].includes(call.method)) return [signer.address];
    if (call.method === "eth_chainId") return "0x279f";
    if (call.method === "personal_sign") return signer.signMessage(toUtf8String(getBytes(String(call.params?.[0]))));
    throw new Error(`Unexpected wallet call ${call.method}`);
  });
  await page.addInitScript(() => {
    const scope = window as unknown as { __financialWallet: (call: unknown) => Promise<unknown>; ethereum: unknown };
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    scope.ethereum = { request: (call: unknown) => scope.__financialWallet(call),
      on: (event: string, listener: (...args: unknown[]) => void) => { const list = listeners.get(event) ?? new Set(); list.add(listener); listeners.set(event, list); },
      removeListener: (event: string, listener: (...args: unknown[]) => void) => listeners.get(event)?.delete(listener),
      __emit: (event: string, payload: unknown) => listeners.get(event)?.forEach(listener => listener(payload)) };
  });
  let release!: () => void, financeReads = 0, challengeCalls = 0, loginCalls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), expiry = Date.now() + 300000;
  const challenge = { id: "financial-auth-challenge", expiresAt: expiry,
    message: `AgentFuel hosted agent login\nOrigin: http://127.0.0.1:3014\nWallet: ${signer.address}\nChain: 10143\nNonce: financial-auth-challenge\nExpires: ${new Date(expiry).toISOString()}\nThis signature authenticates your platform account. It authorizes no blockchain transaction.` };
  const setCookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/api/hosted; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname, cookie = route.request().headers().cookie ?? "";
    if (path === "/api/hosted/agents") return route.fulfill(cookie.includes(oldToken) || cookie.includes(newToken)
      ? { json: { agents: [agent], runs: [], models: [{ id: "controlled", label: "Controlled Model" }] } } : { status: 401, json: { error: "HOSTED_AUTH_REQUIRED" }, headers: { "set-cookie": setCookie("", 0) } });
    if (path === `/api/hosted/agents/${a.id}/finance`) {
      financeReads++;
      if (financeReads === 1) { await gate; return route.fulfill({ status: 401, json: { error: "HOSTED_AUTH_REQUIRED" }, headers: { "set-cookie": setCookie("", 0) } }); }
      return route.fulfill({ json: financial(agent) });
    }
    if (path === "/api/hosted/auth/logout") return route.fulfill({ json: { authenticated: false }, headers: { "set-cookie": setCookie("", 0) } });
    if (path === "/api/hosted/auth/challenge") { challengeCalls++; return route.fulfill({ json: challenge }); }
    if (path === "/api/hosted/auth/login") {
      loginCalls++; expect(verifyMessage(challenge.message, route.request().postDataJSON().signature)).toBe(signer.address);
      return route.fulfill({ json: { authenticated: true, expiresAt: expiry }, headers: { "set-cookie": setCookie(newToken, 3600) } });
    }
    return route.fulfill({ status: 503, json: { error: "HOSTED_UNAVAILABLE" } });
  });
  try {
    await page.goto("/dashboard"); await expect.poll(() => financeReads).toBe(1);
    if (destination === "onboarding") {
      await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
      await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
      await expect(page.getByLabel("名称", { exact: true })).toBeVisible();
      await page.getByLabel("名称", { exact: true }).fill("旧身份未确认配置");
    }
    await page.evaluate(() => (window as unknown as { ethereum: { __emit: (event: string, payload: unknown) => void } }).ethereum.__emit("chainChanged", "0x279f"));
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "等待钱包…", exact: true })).toBeDisabled();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(challengeCalls).toBe(0); expect(loginCalls).toBe(0);
    const oldResponse = page.waitForResponse(response => response.url().endsWith(`/${a.id}/finance`) && response.status() === 401);
    release(); await (await oldResponse).finished();
    if (destination === "onboarding") {
      await expect(page.getByLabel("名称", { exact: true })).toHaveValue("");
      await expect(page.getByTestId("onboarding-transcript")).not.toContainText("旧身份未确认配置");
      await page.getByRole("link", { name: "进入工作台 →", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
    }
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    expect(loginCalls).toBe(1); expect(challengeCalls).toBe(1);
    expect((await page.context().cookies()).find(cookie => cookie.name === cookieName)?.value).toBe(newToken);
    const refresh = page.waitForResponse(response => response.url().endsWith("/api/hosted/agents") && response.status() === 200);
    await page.getByRole("button", { name: "刷新托管数据", exact: true }).click(); await refresh;
    await pane(page, "资源"); await expect(page.getByTestId("hosted-financial-snapshot").getByText("570", { exact: true })).toBeVisible();
    expect((await page.context().cookies()).find(cookie => cookie.name === cookieName)?.value).toBe(newToken);
  } finally { release(); }
});
