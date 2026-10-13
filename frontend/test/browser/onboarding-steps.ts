import { expect, type Page } from "@playwright/test";
import { inputUsdc, type AgentSettings } from "../../lib/hosted-client";

export async function configureTerminal(page: Page, settings: AgentSettings, started = false) {
  if (!started) await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill(settings.name);
  await page.getByLabel("名称", { exact: true }).press("Enter");
  await page.getByRole("listbox", { name: "模型", exact: true }).locator(`[data-value="${settings.modelId}"]`).click();
  await page.getByRole("listbox", { name: "策略", exact: true }).locator(`[data-value="${settings.strategy}"]`).click();
  await page.getByLabel(/^单次推理预算（/).fill(inputUsdc(settings.perRunBudgetRaw));
  await page.getByLabel(/^单次推理预算（/).press("Enter");
  await page.getByLabel(/^累计推理预算（/).fill(inputUsdc(settings.totalBudgetRaw));
  await page.getByLabel(/^累计推理预算（/).press("Enter");
  await page.getByRole("listbox", { name: "允许任务授信", exact: true }).locator(`[data-value="${settings.allowCredit ? "yes" : "no"}"]`).click();
  await expect(page.getByRole("region", { name: "确认 Agent 配置" })).toBeVisible();
}
