import { test, expect } from "@playwright/test";
import { makeAgent, makeRun, syntheticHosted, unexpectedByPage, settings, uuid } from "./hosted-harness";
import { configureTerminal } from "./onboarding-steps";

test.afterEach(async ({ page }) => { expect(unexpectedByPage.get(page)).toEqual([]); });
const wallet = `0x${"2".repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const agent = makeAgent({ binding: { chainId: "42431", agentId: "1999", wallet } });

test("Tempo login displays PathUSD and links wallet, acceptance, payment and settlement evidence", async ({ page }) => {
  const run = makeRun({ result: { phase: "Succeeded", terminal: true, success: true, chargedRaw: "120000", chainId: "42431",
    fromCashRaw: "40000", fromCreditRaw: "80000", acceptTxHash: hash("a"), paymentTxHash: hash("b"),
    settlement: { txHash: hash("c"), block: { number: 3, hash: hash("d"), timestamp: 1791676850 },
      passed: true, loanStatus: "2", repaidRaw: "92000", slashedRaw: "0", residualRaw: "58000" } } });
  const harness = await syntheticHosted(page, { authenticated: false, chainId: "42431", agents: [agent], runs: [run] });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
  expect(harness.signed).toHaveLength(1);
  expect(harness.signed[0].message).toContain("Chain: 42431");
  expect(harness.rpcCalls.every(call => ["eth_requestAccounts", "eth_accounts", "eth_chainId", "personal_sign"].includes(call.method))).toBe(true);
  const agentTab = page.getByRole("tab", { name: "Agent", exact: true }); if (await agentTab.isVisible()) await agentTab.click();
  await expect(page.getByRole("link", { name: "查看钱包 ↗" })).toHaveAttribute("href", `https://explore.testnet.tempo.xyz/address/${wallet}`);
  await page.getByText("链上身份详情", { exact: true }).click();
  await expect(page.getByText("Tempo Moderato Testnet", { exact: true })).toBeVisible();
  await expect(page.getByTestId("hosted-panel-agent")).toContainText("0.12 PathUSD");
  const requestTab = page.getByRole("tab", { name: "请求", exact: true }); if (await requestTab.isVisible()) await requestTab.click();
  const summary = page.getByRole("region", { name: "任务结算摘要" });
  await expect(summary).toContainText("cash 支付 0.04 · 信用支付 0.08 PathUSD");
  await expect(summary).toContainText("实际还款 0.092 PathUSD");
  await expect(summary.getByRole("link", { name: /查看结算交易/ })).toHaveAttribute("href", `https://explore.testnet.tempo.xyz/tx/${hash("c")}`);
  await page.getByText("查看请求与凭证", { exact: true }).click();
  await expect(page.getByRole("link", { name: /查看接单交易/ })).toHaveAttribute("href", `https://explore.testnet.tempo.xyz/tx/${hash("a")}`);
  await expect(page.getByRole("link", { name: /查看付款交易/ })).toHaveAttribute("href", `https://explore.testnet.tempo.xyz/tx/${hash("b")}`);
  await page.getByRole("button", { name: /资金与额度$/ }).click();
  await expect(page.getByLabel("入账金额（PathUSD）", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("a wallet on the wrong chain receives the Tempo switch message before any signature", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, chainId: "42431", walletChainId: "10143", agents: [agent] });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "钱包网络不匹配" })).toContainText("Tempo Moderato Testnet（42431）");
  expect(harness.signed).toEqual([]);
  expect(harness.commands.filter(command => command.path.endsWith("/auth/login"))).toEqual([]);
});

test("first-time Tempo creation labels PathUSD and preserves the six configured parameters", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, chainId: "42431", agents: [] });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await configureTerminal(page, settings, true);
  await expect(page.getByRole("region", { name: "确认 Agent 配置" })).toContainText("0.12 PathUSD");
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("contentinfo")).toContainText("chain 42431 · #1999");
  expect(harness.commands.filter(command => command.path === "/api/hosted/agents" && command.method === "POST").map(command => command.body))
    .toEqual([{ ...settings, requestId: expect.stringMatching(uuid) }]);
  expect(harness.rpcCalls.every(call => ["eth_requestAccounts", "eth_accounts", "eth_chainId", "personal_sign"].includes(call.method))).toBe(true);
});
