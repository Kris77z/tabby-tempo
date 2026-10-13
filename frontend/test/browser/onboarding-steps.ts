import { expect, type Page } from "@playwright/test";
import type { AgentSettings } from "../../lib/hosted-client";

export async function configureTerminal(page: Page, settings: AgentSettings, started = false) {
  if (!started) await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill(settings.name);
  await page.getByLabel("名称", { exact: true }).press("Enter");
  await expect(page.getByRole("region", { name: "确认创建 Agent" })).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByLabel("单次推理预算（USDC）", { exact: true })).toHaveCount(0);
}
