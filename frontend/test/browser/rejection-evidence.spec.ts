import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { rejectionFixture } from "../rejection-fixture";
import { stopAnvil } from "../../../services/underwriter/test/fixture.js";

test("real Next endpoint verifies an Anvil mined failure and the readonly browser decodes it", async ({ page }) => {
  test.setTimeout(120_000);
  const local = await rejectionFixture(); let frontend: ChildProcess | undefined;
  try {
    const reserve = createServer(); reserve.listen(0, "127.0.0.1"); await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    frontend = spawn(process.execPath, [fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url)), "start", "--hostname", "127.0.0.1", "--port", String(port)],
      { cwd: root, env: { ...process.env, FRONTEND_MODE: "chain", FRONTEND_RPC_TRANSPORT: "direct", FRONTEND_MANIFEST_PATH: local.manifestPath, FRONTEND_DEMO_STATE_PATH: local.statePath }, stdio: ["ignore", "pipe", "pipe"] });
    let logs = ""; for (const stream of [frontend.stdout, frontend.stderr]) stream?.on("data", chunk => { logs = (logs + String(chunk)).slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (frontend.exitCode !== null) throw new Error(`Own Next test server failed: ${logs}`);
      try { const response = await fetch(`${base}/api/rejection-evidence`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) { const value = await response.json(); expect(value.verified).toBe(true); expect(JSON.stringify(value)).not.toContain("PRIVATE_TEST_CANARY"); ready = true; break; } }
      catch { /* Wait only for our own local process. */ }
      await delay(100);
    }
    expect(ready, logs).toBe(true);
    await page.goto(base); await expect(page.getByText(local.config.network, { exact: true })).toBeVisible();
    await expect(page.getByText("本地演示 · FIXTURE", { exact: true })).toHaveCount(0);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /演示面板/ }).click();
    await page.getByRole("button", { name: "读取已执行的拒绝交易" }).click();
    await expect(page.getByText("SpendRejected · Agent #1", { exact: true })).toBeVisible();
    await expect(page.getByText("目标 Provider 未加入白名单，资金无法转出。", { exact: true })).toBeVisible();
    await expect(page.getByText(/status 0 · reverted · logs 0/)).toContainText("amount 0.12 USDC");
    await expect(page.getByRole("link", { name: "查看已执行的失败交易" })).toHaveAttribute("href", `${local.config.explorerUrl}/tx/${local.state.reverse.spendRejected.txHash}`);
    await page.getByText("实际 revert bytes", { exact: true }).click();
    await expect(page.getByText(local.state.reverse.spendRejected.revertData, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Agent 2.*Score/ }).click();
    await page.getByRole("button", { name: "读取已执行的拒绝交易" }).click();
    await expect(page.getByText("该拒绝交易属于 Agent #1，请切换至对应档案。", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "查看已执行的失败交易" })).toHaveCount(0);
    await page.getByRole("button", { name: /Agent 1.*Score/ }).click();
    local.state.reverse.spendRejected.txHash = local.successful.hash;
    local.state.reverse.spendRejected.blockNumber = local.successful.blockNumber; await local.save();
    await page.getByRole("button", { name: "读取已执行的拒绝交易" }).click();
    await expect(page.getByText("历史拒绝证据不可验证，请检查本次清单、记录与链上回执。", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "查看已执行的失败交易" })).toHaveCount(0);
    const rejected = await page.request.get(`${base}/api/rejection-evidence`); expect(rejected.status()).toBe(503);
    expect(await rejected.json()).toEqual({ verified: false, code: "REJECTION_EVIDENCE_UNVERIFIABLE", message: "历史拒绝证据不可验证，请检查本次清单、记录与链上回执。" });
  } finally { if (frontend) await stopAnvil(frontend); await local.close(); }
});
