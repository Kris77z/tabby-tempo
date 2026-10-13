import { expect, test } from "@playwright/test";
import type { HoldemSnapshot } from "../../lib/holdem-types";

test("configured report is explicit and read-only, public replay reaches terminal, refresh preserves evidence", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/arena/holdem");
  await expect(page.getByRole("heading", { name: "德州 Arena", exact: true })).toBeVisible();
  await expect(page.getByText("公开报告 · 文件快照", { exact: true })).toBeVisible();
  await expect(page.getByText(/本地 Anvil \/ mock-USDC.*页面未联机核验/)).toBeVisible();
  await expect(page.getByText("本地演示 · FIXTURE", { exact: true })).toHaveCount(0);
  expect(await page.getByRole("button", { name: /连接钱包|购买推理|付款|结算|开始比赛/ }).count()).toBe(0);
  const response = await page.request.get("/api/holdem?path=/etc/passwd"), snapshot: HoldemSnapshot = await response.json();
  expect(response.status()).toBe(200); expect(snapshot.source).toBe("report");
  const report = snapshot.report!;
  await expect(page.getByTestId("holdem-pot")).toContainText(String(report.game.steps[0].pot));
  await expect(page.getByTestId("holdem-stack-0")).toHaveText(report.game.steps[0].stacks[0].toLocaleString("en-US"));
  if (report.game.steps.length > 1) {
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(page.getByTestId("holdem-pot")).toContainText(String(report.game.steps[1].pot));
  }
  await page.getByRole("button", { name: "查看终局", exact: true }).click();
  await expect(page.getByTestId("holdem-stack-0")).toHaveText(report.game.result!.finalStacks[0].toLocaleString("en-US"));
  await expect(page.locator(".holdem-current")).toContainText(/获胜|平局/);
  await expect(page.getByRole("heading", { name: "奖励到账，再购买推理" })).toBeVisible();
  await expect(page.locator(".holdem-funding").getByText("fromCredit 0 · taskId 0", { exact: false }).first()).toBeVisible();
  await page.locator(".holdem-funding").getByText("已记录奖励交易", { exact: false }).first().click();
  await expect(page.locator(".holdem-funding .holdem-tx[open]").first()).toContainText(report.reward!.transfers[0].txHash);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: test.info().outputPath("holdem-terminal-report.png"), fullPage: true });
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.getByRole("button", { name: "刷新德州报告" })).toBeEnabled();
  await expect(page.locator(".holdem-current")).toContainText("第 1 步");
  await page.route("**/api/holdem", route => route.fulfill({ status: 503, json: { source: "report", report: null, loadedAt: new Date().toISOString(), error: { code: "HOLDEM_REPORT_UNAVAILABLE", message: "测试：公开报告不可用" } } }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.locator(".read-error[role=alert]")).toContainText("保留上次成功快照");
  await expect(page.locator(".holdem-match")).toHaveText(report.matchId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("holdem-public-report.png"), fullPage: true });
});

test("Monad reward-deposit evidence does not imply paid inference, delivered and unknown records remain distinct", async ({ page }) => {
  await page.goto("/arena/holdem");
  const snapshot: HoldemSnapshot = await (await page.request.get("/api/holdem")).json(), report = snapshot.report!;
  const txHash = `0x${"a".repeat(64)}`, balance = { blockNumber: 1, cash: ["0", "0"] as [string, string], walletsToken: ["0", "0"] as [string, string], providerToken: "0", totalOutstanding: "0" };
  const staged: HoldemSnapshot = { ...snapshot, purchase: undefined, delivery: { phase: "RewardDeposited", chainId: "10143", matchId: report.matchId, decimals: 6, rewardRaw: "100000", allocations: ["100000", "0"], players: [{ seat: 0, agentId: "1842" }, { seat: 1, agentId: "1843" }], operations: [{ kind: "reward", seat: 0, amount: "100000", txHash, blockNumber: 2 }, { kind: "deposit", seat: 0, amount: "100000", txHash, blockNumber: 3 }], balances: { before: balance, afterAward: { ...balance, blockNumber: 2 }, afterDeposit: { ...balance, blockNumber: 3, cash: ["100000", "0"] } }, verification: { rewardConserved: true, newBorrowingRaw: "0", totalOutstandingUnchanged: true } } };
  await page.route("**/api/holdem", route => route.fulfill({ json: staged }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.locator(".holdem-monad").getByText("奖励已存入 cash", { exact: true })).toBeVisible();
  await expect(page.locator(".holdem-monad").getByText("推理消费待核验", { exact: true })).toBeVisible();
  await expect(page.locator(".holdem-monad").getByText("奖后推理已完成", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/holdem");
  const completed: HoldemSnapshot = { ...staged, purchase: { phase: "Complete", chainId: "10143", matchId: report.matchId, strategy: "real-model", model: "kimi-k2.6", priceRaw: "10000", physicalInferenceAttempts: 1, purchases: [{ seat: 0, agentId: "1842", awardRaw: "100000", cashBefore: "100000", cashAfter: "90000", state: "Delivered", taskCompleted: true, receipt: { txHash, blockNumber: 4, fromCash: "10000", fromCredit: "0", taskId: "0" }, usage: { total_tokens: 25 } }], verification: { zeroDebt: true, cashConserved: true, paymentReceiptsCanonical: true, fromCredit: "0", newBorrowingRaw: "0", totalPaidRaw: "10000" } } };
  await page.route("**/api/holdem", route => route.fulfill({ json: completed }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.locator(".holdem-monad").getByText("奖后推理已完成", { exact: true })).toBeVisible();
  await expect(page.locator(".holdem-monad").getByText(/真实 Kimi 上游.*Delivered/)).toBeVisible();
  await page.unroute("**/api/holdem");
  await page.route("**/api/holdem", route => route.fulfill({ json: { ...completed, purchase: { ...completed.purchase!, phase: "Stopped", purchases: completed.purchase!.purchases.map(item => ({ ...item, state: "Unknown", taskCompleted: false })) } } }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.locator(".holdem-monad").getByText("推理结果未知 · 已暂停", { exact: true })).toBeVisible();
  await expect(page.locator(".holdem-monad").getByText("奖后推理已完成", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("stopped model report shows attempts, no winner, no payout, and fixture fallback stays explicit", async ({ page }) => {
  await page.goto("/arena/holdem");
  const snapshot: HoldemSnapshot = await (await page.request.get("/api/holdem")).json(), report = snapshot.report!;
  // A stopped source cannot retain attachments bound to a completed source report.
  const stopped: HoldemSnapshot = { ...snapshot, delivery: undefined, purchase: undefined, deliveryError: undefined, purchaseError: undefined, report: { ...report, phase: "Stopped", verified: false, strategy: "controlled-model", game: { ...report.game, result: null, finalBoard: [], steps: report.game.steps.slice(0, 1) }, reward: null, inference: null, balances: { before: report.balances!.before }, strategyInference: { calls: 1, maxCalls: 20, vendorInvoiceVerified: false, attempts: [{ turn: 0, seat: 0, requestedModel: "kimi-k2.6", outcome: "OutcomeUnknown" }] }, evidence: { publicReplayVerified: false, chainEvidenceRecorded: false }, verification: {} } };
  await page.route("**/api/holdem", route => route.fulfill({ json: stopped }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.getByText("已停止 · 未结算", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("结果未知 · 已暂停", { exact: false })).toBeVisible();
  await expect(page.getByText("尚无终局", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看终局", exact: true })).toHaveCount(0);
  await expect(page.locator(".holdem-purchase")).toHaveCount(0);
  await page.unroute("**/api/holdem");
  await page.route("**/api/holdem", route => route.fulfill({ json: { ...snapshot, source: "fixture", delivery: undefined, purchase: undefined, deliveryError: undefined, purchaseError: undefined } }));
  await page.getByRole("button", { name: "刷新德州报告" }).click();
  await expect(page.getByText("本地演示 · FIXTURE", { exact: true })).toBeVisible();
  await expect(page.getByText("未配置公开报告；当前牌局、奖励与哈希均为示例。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
