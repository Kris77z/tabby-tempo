import { test, expect } from "@playwright/test";
test("fixture is explicit, three financial identities, evidence expands, mobile fits", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/advanced");
  await expect(page.getByText("本地演示 · FIXTURE")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Atlas\s*#1842/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "连接钱包" })).toBeDisabled();
  await expect(page.locator(".ledger-row").first().locator(".ledger-main")).not.toContainText("Tier");
  await page.getByRole("button", { name: /Helix.*Score 710/ }).click();
  await expect(page.locator(".score-number")).toContainText("710");
  await expect(page.getByText("Tier A", { exact: true })).toBeVisible();
  await expect(page.locator(".ledger-row").first().locator(".ledger-main")).toContainText("cash 0.04 + credit 0.08 USDC");
  await expect(page.locator(".ledger-row").first().locator(".ledger-main")).not.toContainText("Tier");
  await page.locator(".ledger-row").first().locator("summary").click();
  await expect(page.locator(".ledger-row").first().getByText("Transaction receipt", { exact: true })).toBeVisible();
  await expect(page.locator(".ledger-row").first().getByText("evidenceHash", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Delta.*Score 170/ }).click();
  await expect(page.getByText("identityChanged · 身份变更", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /演示面板/ }).click();
  await expect(page.getByText("本地演示模式：交易操作已关闭。")).toBeVisible();
  await page.getByRole("button", { name: "查看 fixture 拒绝样例" }).click();
  await expect(page.getByText("SpendRejected", { exact: true })).toBeVisible();
  await expect(page.getByText("目标 Provider 未加入白名单，资金无法转出。")).toBeVisible();
  await expect(page.getByText("本地 fixture 错误样例；未请求 RPC。")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("manual and automatic refresh share one in-flight request", async ({ page }) => {
  await page.clock.install();
  await page.goto("/advanced");
  const fixture = await (await page.request.get("/api/dashboard")).json();
  // Controlled test snapshot enables the real refresh interval; no network/chain is represented here.
  const snapshot = { ...fixture, mode: "chain", config: { ...fixture.config, network: "LOCAL REFRESH TEST" } };
  let requests = 0, release: (() => void) | undefined;
  await page.route("**/api/dashboard", async route => {
    requests++;
    if (requests === 2) await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ json: snapshot });
  });
  await page.getByRole("button", { name: "刷新链上数据" }).click();
  await expect(page.getByRole("button", { name: "刷新链上数据" })).toBeEnabled();
  await page.clock.runFor(20_000);
  await expect.poll(() => requests).toBe(2);
  await expect(page.getByRole("button", { name: "刷新链上数据" })).toBeDisabled();
  await page.clock.runFor(60_000);
  expect(requests).toBe(2);
  release!();
  await expect(page.getByRole("button", { name: "刷新链上数据" })).toBeEnabled();
  await page.clock.runFor(20_000);
  await expect.poll(() => requests).toBe(3);
  await expect(page.getByText(/读取中不重复请求/)).toBeVisible();
});
