import { test, expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentSettings, HostedAgent, HostedRun } from "../../../services/hosted-agents/src/types";

import { owner, agentId, wallet, settings, uuid, makeAgent, makeRun, syntheticHosted, unexpectedByPage, type Command } from "./hosted-harness";
import { configureTerminal } from "./onboarding-steps";

const fatalByPage = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const fatal: string[] = [];
  fatalByPage.set(page, fatal);
  page.on("pageerror", error => fatal.push(error.message));
});
test.afterEach(async ({ page }) => {
  expect(fatalByPage.get(page)).toEqual([]);
  expect(unexpectedByPage.get(page)).toEqual([]);
});


async function layout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}
async function showPanel(page: Page, name: "Agent" | "请求" | "资源") {
  if ((page.viewportSize()?.width ?? 1512) >= 900) return;
  const tab = page.getByRole("tab", { name, exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
async function expectAgentVisible(page: Page, id: string) {
  await showPanel(page, "Agent");
  await expect(page.getByTestId(`hosted-agent-${id}`)).toBeVisible();
  await showPanel(page, "请求");
}
async function captureSynthetic(page: Page, name: string, info: TestInfo) {
  const directory = resolve(info.project.testDir, "../../acceptance/hosted-agents");
  await mkdir(directory, { recursive: true });
  await showPanel(page, name === "agents" ? "Agent" : "请求");
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    window.scrollTo(0, 0);
    document.querySelectorAll<HTMLElement>('[data-testid^="hosted-panel-"], [data-testid^="hosted-panel-"] *, [data-testid="hosted-action-dock"]')
      .forEach(element => { element.scrollTop = 0; });
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await page.screenshot({ path: resolve(directory, `synthetic-terminal-${name}-${info.project.name}.png`), fullPage: true,
    scale: "css", style: "nextjs-portal { display: none !important }" });
  await showPanel(page, "请求");
}
const navigationName = (name: string) => new RegExp(`^(?://\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
async function navigate(page: Page, name: string) {
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: navigationName(name) }).click();
  await showPanel(page, "请求");
}
const writes = (commands: Command[], path: string, method = "POST") => commands.filter(command => command.path === path && command.method === method);
const runWrites = (commands: Command[], id = agentId) => writes(commands, `/api/hosted/agents/${id}/runs`);

test("Agora terminal structure uses viewport panels, source tokens and a persistent action dock", async ({ page }, info) => {
  const harness = await syntheticHosted(page);
  await page.goto("/dashboard");
  await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveValue(agentId);
  const shell = page.getByTestId("hosted-terminal-shell"), grid = page.getByTestId("hosted-terminal-grid");
  const header = page.getByTestId("hosted-terminal-header"), dock = page.getByTestId("hosted-action-dock");
  const panels = {
    Agent: page.getByTestId("hosted-panel-agent"),
    请求: page.getByTestId("hosted-panel-requests"),
    资源: page.getByTestId("hosted-panel-resources"),
  };
  await expect(header).toContainText(/agentfuel.*[~$]/i);
  await expect(header.getByRole("button", { name: "创建 Agent", exact: true })).toBeVisible();
  const dots = header.getByTestId("hosted-terminal-dot");
  await expect(dots).toHaveCount(3);
  const dotColors = await dots.evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
  expect(new Set(dotColors).size).toBe(3);
  const rgb = dotColors.map(color => color.match(/[\d.]+/g)!.slice(0, 3).map(Number));
  expect(rgb.some(([r, g, b]) => r > g * 1.25 && r > b * 1.25)).toBe(true);
  expect(rgb.some(([r, g, b]) => r > 150 && g > 100 && b < g * 0.7)).toBe(true);
  expect(rgb.some(([r, g, b]) => g > r * 1.25 && g > b * 1.25)).toBe(true);
  const sourceStyle = await shell.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      font: style.fontFamily,
      fontVariable: style.getPropertyValue("--font-geist-mono").trim(),
      background: style.backgroundColor,
      tokens: Object.fromEntries(["background", "foreground", "card", "primary", "accent", "border", "muted-foreground", "radius"]
        .map(name => [name, style.getPropertyValue(`--${name}`).replace(/\s+/g, "")])),
    };
  });
  const fontFamily = (value: string) => value.split(",")[0].replace(/["']/g, "").trim();
  expect(sourceStyle.fontVariable).not.toBe("");
  expect(fontFamily(sourceStyle.font)).toBe(fontFamily(sourceStyle.fontVariable));
  const loadedFaces = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].map(face => ({ family: face.family, status: face.status }));
  });
  expect(loadedFaces.some(face => fontFamily(face.family) === fontFamily(sourceStyle.fontVariable) && face.status === "loaded")).toBe(true);
  expect(sourceStyle.background).toBe("rgb(244, 244, 245)");
  expect(sourceStyle.tokens).toEqual({ background: "2405%96%", foreground: "2406%10%", card: "00%100%",
    primary: "26370%50%", accent: "26370%50%", border: "2406%85%", "muted-foreground": "2404%46%", radius: "0px" });
  for (const panel of [...Object.values(panels), dock]) {
    expect(await panel.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe("0px");
  }
  expect(await header.getByRole("button", { name: "创建 Agent", exact: true }).evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe("0px");
  expect(fontFamily(await page.getByLabel("当前 Agent", { exact: true }).evaluate(element => getComputedStyle(element).fontFamily))).toBe(fontFamily(sourceStyle.fontVariable));
  await expect(shell.locator('[class*="__hero"], [class*="__catalogGrid"]')).toHaveCount(0);
  const headingSizes = await shell.getByRole("heading").evaluateAll(elements => elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(headingSizes.every(size => size <= 24)).toBe(true);
  const viewport = page.viewportSize()!;
  async function persistentDock() {
    await expect(dock).toBeVisible();
    const bounds = (await dock.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
    for (const name of ["我的 Agent", "任务", "竞技场", "资金与额度", "设置"]) {
      const control = dock.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: navigationName(name) });
      await expect(control).toBeVisible();
      const button = (await control.boundingBox())!;
      expect(button.x).toBeGreaterThanOrEqual(0);
      expect(button.x + button.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(button.y + button.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  }
  if (info.project.name === "mobile") {
    await expect(page.getByRole("tab", { name: "请求", exact: true })).toHaveAttribute("aria-selected", "true");
    for (const name of ["Agent", "请求", "资源"] as const) {
      await showPanel(page, name);
      for (const [label, panel] of Object.entries(panels)) {
        if (label === name) await expect(panel).toBeVisible();
        else await expect(panel).toBeHidden();
      }
      await persistentDock();
      const current = (await panels[name].boundingBox())!, action = (await dock.boundingBox())!;
      expect(current.y + current.height).toBeLessThanOrEqual(action.y + 1);
      await layout(page);
    }
  } else {
    for (const panel of Object.values(panels)) await expect(panel).toBeVisible();
    const [left, center, right, container, action] = await Promise.all([
      panels.Agent.boundingBox(), panels.请求.boundingBox(), panels.资源.boundingBox(), grid.boundingBox(), dock.boundingBox(),
    ]);
    expect(Math.abs(container!.x - 16)).toBeLessThanOrEqual(1);
    expect(Math.abs(container!.x + container!.width - (viewport.width - 16))).toBeLessThanOrEqual(1);
    expect(left!.width / container!.width).toBeGreaterThan(0.22);
    expect(left!.width / container!.width).toBeLessThan(0.27);
    expect(center!.width / container!.width).toBeGreaterThan(0.46);
    expect(center!.width / container!.width).toBeLessThan(0.52);
    expect(right!.width / container!.width).toBeGreaterThan(0.22);
    expect(right!.width / container!.width).toBeLessThan(0.27);
    expect(left!.x + left!.width).toBeLessThanOrEqual(center!.x + 1);
    expect(center!.x + center!.width).toBeLessThanOrEqual(right!.x + 1);
    expect(Math.abs(left!.height - right!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(left!.y - center!.y)).toBeLessThanOrEqual(1);
    expect(action!.y).toBeGreaterThanOrEqual(center!.y + center!.height - 1);
    expect(container!.y + container!.height).toBeLessThanOrEqual(viewport.height + 1);
    await persistentDock();
  }
  await showPanel(page, "资源");
  await expect(panels.资源).toContainText("Kimi K2.6");
  await expect(panels.资源).toContainText("Synthetic Model");
  await expect(panels.资源.getByRole("meter", { name: "推理预算使用比例", exact: true })).toBeVisible();
  await layout(page);
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]);
  expect(harness.rpcCalls).toEqual([]);
});

test("401 shows sign-in and an empty account without submitting a hosted action", async ({ page }, info) => {
  const harness = await syntheticHosted(page, { authenticated: false, agents: [] });
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeDisabled();
  await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
  await captureSynthetic(page, "signed-out", info);
  for (const name of ["我的 Agent", "任务", "竞技场", "资金与额度", "设置"]) {
    await navigate(page, name);
    await layout(page);
  }
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]);
  expect(harness.rpcCalls).toEqual([]);
});

test("503 explains that hosted service is unconfigured and keeps execution unavailable", async ({ page }) => {
  const harness = await syntheticHosted(page, { error: { status: 503, code: "HOSTED_NOT_CONFIGURED" } });
  await page.goto("/dashboard");
  await expect(page.getByText(/托管服务.*未配置|托管服务.*尚未|服务尚未配置/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeDisabled();
  await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
  await navigate(page, "任务");
  await expect(page.getByRole("button", { name: "运行任务", exact: true })).toHaveCount(0);
  await navigate(page, "竞技场");
  await expect(page.getByRole("button", { name: "免费参赛", exact: true })).toHaveCount(0);
  await layout(page);
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]);
  expect(harness.rpcCalls).toEqual([]);
});

test("local signature authenticates the exact challenge and creates owner-controlled settings", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, agents: [] });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeEnabled();
  expect(writes(harness.commands, "/api/hosted/auth/challenge").map(command => command.body)).toEqual([{ wallet: owner.address }]);
  expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
  expect(harness.signed).toHaveLength(1);
  expect(harness.signed[0].message).toBe(harness.challenge.message);
  expect(harness.signed[0].wallet.toLowerCase()).toBe(owner.address.toLowerCase());
  await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await configureTerminal(page, settings);
  await expect(page.getByRole("button", { name: "确认创建", exact: true })).toBeEnabled();
  expect(writes(harness.commands, "/api/hosted/agents")).toEqual([]);
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expectAgentVisible(page, agentId);
  const creations = writes(harness.commands, "/api/hosted/agents");
  expect(creations).toHaveLength(1);
  expect(creations[0].body).toEqual({ requestId: expect.stringMatching(uuid), ...settings });
  expect(Object.keys(creations[0].body).sort()).toEqual(["allowCredit", "modelId", "name", "perRunBudgetRaw", "requestId", "strategy", "totalBudgetRaw"]);
  await layout(page);
});

test("settings, pause, task, game, credits and deposit use the public hosted API contract", async ({ page }, info) => {
  const harness = await syntheticHosted(page);
  await page.goto("/dashboard");
  await expectAgentVisible(page, agentId);
  await layout(page);
  await captureSynthetic(page, "agents", info);
  await showPanel(page, "Agent");
  await page.getByRole("button", { name: "编辑设置", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("已更新的合成 Agent");
  await dialog.getByLabel("模型", { exact: true }).selectOption("synthetic-model");
  await dialog.getByLabel("策略", { exact: true }).selectOption("conservative");
  await dialog.getByLabel("单次推理预算（USDC）", { exact: true }).fill("0.05");
  await dialog.getByLabel("累计推理预算（USDC）", { exact: true }).fill("0.8");
  await dialog.getByLabel("允许任务授信", { exact: true }).uncheck();
  await layout(page);
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(writes(harness.commands, `/api/hosted/agents/${agentId}`, "PATCH").map(command => command.body)).toEqual([{
    name: "已更新的合成 Agent", modelId: "synthetic-model", strategy: "conservative",
    perRunBudgetRaw: "50000", totalBudgetRaw: "800000", allowCredit: false,
  }]);
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续 Agent", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停 Agent", exact: true })).toBeEnabled();
  expect(writes(harness.commands, `/api/hosted/agents/${agentId}/pause`).map(command => command.body)).toEqual([{ paused: true }, { paused: false }]);
  await navigate(page, "任务");
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  await navigate(page, "竞技场");
  await page.getByLabel("比赛奖励", { exact: true }).selectOption("llm-credits");
  await page.getByRole("button", { name: "免费参赛", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(2);
  await navigate(page, "资金与额度");
  await expect(page.getByRole("button", { name: "用奖励额度运行任务", exact: true })).toBeDisabled();
  await navigate(page, "设置");
  await page.getByRole("button", { name: "修改当前配置", exact: true }).click();
  await dialog.getByLabel("模型", { exact: true }).selectOption("kimi-k2.6");
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(dialog).toBeHidden();
  await navigate(page, "资金与额度");
  await page.getByRole("button", { name: "用奖励额度运行任务", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(3);
  await page.getByLabel("入账金额（USDC）", { exact: true }).fill("0.04");
  await page.getByRole("button", { name: "确认入账", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(4);
  const bodies = runWrites(harness.commands).map(command => command.body);
  expect(bodies).toEqual([
    { action: "task", requestId: expect.stringMatching(uuid) },
    { action: "game", requestId: expect.stringMatching(uuid), rewardKind: "llm-credits" },
    { action: "reward-task", requestId: expect.stringMatching(uuid) },
    { action: "deposit", requestId: expect.stringMatching(uuid), amountRaw: "40000" },
  ]);
  expect(new Set(bodies.map(body => body.requestId)).size).toBe(4);
  expect(harness.rpcCalls).toEqual([]);
  await expect(page.getByTestId(`hosted-run-${bodies[3].requestId}`)).toContainText("已完成");
  await expect(page.getByRole("button", { name: "确认入账", exact: true })).toBeDisabled();
  await layout(page);
  await captureSynthetic(page, "funds", info);
});

for (const original of [
  makeRun({ action: "game", rewardKind: "llm-credits", status: "Failed", recoverable: true, reason: "SYNTHETIC_RECOVERABLE", result: undefined }),
  makeRun({ requestId: "22222222-2222-4222-8222-222222222222", action: "deposit", amountRaw: "40000", status: "Paused", recoverable: true, reason: "SYNTHETIC_RECOVERABLE", result: undefined }),
]) {
  test(`${original.action} recovery reuses the saved request ID and original amount or reward kind after reload`, async ({ page }) => {
    const harness = await syntheticHosted(page, { agents: [makeAgent({ status: "Paused" })], runs: [original] });
    await page.goto("/dashboard");
    await page.reload();
    await navigate(page, original.action === "game" ? "竞技场" : "资金与额度");
    const row = page.getByTestId(`hosted-run-${original.requestId}`);
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "恢复原请求", exact: true }).click();
    await expect.poll(() => runWrites(harness.commands).length).toBe(1);
    expect(runWrites(harness.commands)[0].body).toEqual({
      requestId: original.requestId, action: original.action,
      ...(original.rewardKind ? { rewardKind: original.rewardKind } : {}),
      ...(original.amountRaw ? { amountRaw: original.amountRaw } : {}),
    });
    expect(harness.rpcCalls).toEqual([]);
    await layout(page);
  });
}

for (const scenario of [
  { action: "game", failure: "abort", tab: "竞技场", button: "免费参赛" },
  { action: "deposit", failure: "503", tab: "资金与额度", button: "确认入账" },
] as const) {
  test(`${scenario.action} ${scenario.failure} response persists the full command and confirms the same UUID after reload`, async ({ page }) => {
    const harness = await syntheticHosted(page, { firstRunFailure: scenario.failure });
    // Counting the real UUID generator across reload proves recovery creates no new ID.
    await page.addInitScript(() => {
      const generate = crypto.randomUUID.bind(crypto);
      Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => {
        const key = "synthetic-hosted-uuid-count";
        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
        return generate();
      } });
    });
    await page.goto("/dashboard");
    await navigate(page, scenario.tab);
    if (scenario.action === "game") await page.getByLabel("比赛奖励", { exact: true }).selectOption("llm-credits");
    else await page.getByLabel("入账金额（USDC）", { exact: true }).fill("0.073421");
    await page.getByRole("button", { name: scenario.button, exact: true }).click();
    const retry = page.getByRole("button", { name: "继续确认原请求", exact: true });
    await expect(retry).toBeEnabled();
    await expect(page.getByRole("button", { name: scenario.button, exact: true })).toBeDisabled();
    expect(runWrites(harness.commands)).toHaveLength(1);
    const original = runWrites(harness.commands)[0].body;
    expect(original).toEqual({
      action: scenario.action, requestId: expect.stringMatching(uuid),
      ...(scenario.action === "game" ? { rewardKind: "llm-credits" } : { amountRaw: "73421" }),
    });
    const pendingKey = `agentfuel:hosted:pending:${owner.address.toLowerCase()}`;
    const expectedPending = { owner: owner.address, kind: "run", agentId, input: original };
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(expectedPending);
    await expect(page.getByTestId(`hosted-run-${original.requestId}`)).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("synthetic-hosted-uuid-count"))).toBe("1");
    await page.reload();
    await expect(retry).toBeEnabled();
    await navigate(page, scenario.tab);
    await expect(page.getByRole("button", { name: scenario.button, exact: true })).toBeDisabled();
    expect(runWrites(harness.commands)).toHaveLength(1);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(expectedPending);
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(page.getByTestId(`hosted-run-${original.requestId}`)).toContainText("已完成");
    expect(runWrites(harness.commands).map(command => command.body)).toEqual([original, original]);
    expect(new Set(runWrites(harness.commands).map(command => command.body.requestId)).size).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem("synthetic-hosted-uuid-count"))).toBe("1");
    expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
    expect(harness.commands.filter(command => command.method !== "GET")).toHaveLength(2);
    expect(harness.rpcCalls).toEqual([]);
    await layout(page);
  });
}

test("switching two Agents directs each task and visible result to the selected identity", async ({ page }) => {
  const secondId = "hosted-second-agent", secondWallet = `0x${"3".repeat(40)}`;
  const first = makeAgent(), second = makeAgent({ id: secondId, name: "第二个合成 Agent", wallet: secondWallet,
    modelId: "synthetic-model", strategy: "conservative", binding: { chainId: "31337", agentId: "2000", wallet: secondWallet } });
  const previous = makeRun({ requestId: "33333333-3333-4333-8333-333333333333", agentId: secondId,
    result: { phase: "Complete", terminal: true, success: true, chargedRaw: "25000", taskId: "second-agent-earlier-task" } });
  const harness = await syntheticHosted(page, { agents: [first, second], runs: [previous] });
  await page.goto("/dashboard");
  await expectAgentVisible(page, first.id);
  await expectAgentVisible(page, second.id);
  await navigate(page, "任务");
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands, first.id).length).toBe(1);
  const firstRequest = String(runWrites(harness.commands, first.id)[0].body.requestId);
  const firstRow = page.getByTestId(`hosted-run-${firstRequest}`);
  await expect(firstRow).toContainText("已完成");
  await firstRow.getByText("查看请求与凭证", { exact: true }).click();
  await expect(firstRow.getByText(`synthetic-task-${first.id}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toHaveCount(0);
  await page.getByLabel("当前 Agent", { exact: true }).selectOption(second.id);
  await showPanel(page, "Agent");
  await expect(page.getByTestId("hosted-panel-agent")).toContainText(second.name);
  await expect(page.getByTestId("hosted-panel-agent")).toContainText(second.wallet);
  await showPanel(page, "请求");
  await expect(firstRow).toHaveCount(0);
  await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toBeVisible();
  await page.getByRole("button", { name: "运行任务", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands, second.id).length).toBe(1);
  const secondRequest = String(runWrites(harness.commands, second.id)[0].body.requestId);
  expect(secondRequest).toMatch(uuid);
  expect(secondRequest).not.toBe(firstRequest);
  const secondRow = page.getByTestId(`hosted-run-${secondRequest}`);
  await expect(secondRow).toContainText("已完成");
  await secondRow.getByText("查看请求与凭证", { exact: true }).click();
  await expect(secondRow.getByText(`synthetic-task-${second.id}`, { exact: true })).toBeVisible();
  await expect(page.getByText(`synthetic-task-${first.id}`, { exact: true })).toHaveCount(0);
  expect(runWrites(harness.commands, first.id).map(command => command.body)).toEqual([{ requestId: firstRequest, action: "task" }]);
  expect(runWrites(harness.commands, second.id).map(command => command.body)).toEqual([{ requestId: secondRequest, action: "task" }]);
  await page.getByLabel("当前 Agent", { exact: true }).selectOption(first.id);
  await showPanel(page, "Agent");
  await expect(page.getByTestId("hosted-panel-agent")).toContainText(first.name);
  await showPanel(page, "请求");
  await expect(firstRow).toBeVisible();
  await expect(secondRow).toHaveCount(0);
  await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toHaveCount(0);
  expect(harness.rpcCalls).toEqual([]);
  await layout(page);
});

for (const invalidation of ["logout-401", "expired-session-401"] as const) {
  test(`${invalidation} clears Agent identity and execution data and stays signed out after reload`, async ({ page }) => {
    const previous = makeRun();
    const harness = await syntheticHosted(page, { runs: [previous], ...(invalidation === "logout-401" ? { logoutStatus: 401 } : {}) });
    await page.goto("/dashboard");
    await expectAgentVisible(page, agentId);
    await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toBeVisible();
    if (invalidation === "logout-401") {
      await page.getByRole("button", { name: "退出登录", exact: true }).click();
      await expect.poll(() => writes(harness.commands, "/api/hosted/auth/logout").length).toBe(1);
      expect(writes(harness.commands, "/api/hosted/auth/logout")[0].body).toEqual({});
    } else {
      harness.expireSession();
      await page.getByRole("button", { name: "刷新托管数据", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toHaveCount(0);
    await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: settings.name, exact: true })).toHaveCount(0);
    await expect(page.getByText(wallet, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
    await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toHaveCount(0);
    await navigate(page, "任务");
    await expect(page.getByRole("button", { name: "运行任务", exact: true })).toHaveCount(0);
    expect(runWrites(harness.commands)).toEqual([]);
    expect(harness.rpcCalls).toEqual([]);
    await layout(page);
  });
}

function responseGate() {
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  return { arrived, blocked, entered, release };
}
async function emitWalletEvent(page: Page, event: "accountsChanged" | "chainChanged") {
  await page.evaluate(event => {
    const injected = (window as unknown as {
      ethereum: { __emit: (event: string, payload: unknown) => void };
    }).ethereum;
    // A disconnected account can reconnect when eth_requestAccounts is next requested.
    // Returning to the configured chain also invalidates the previous login epoch.
    injected.__emit(event, event === "accountsChanged" ? [] : "0x7a69");
  }, event);
}
async function settleUi(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

for (const scenario of [
  { kind: "run", event: "accountsChanged", success: "请求已确认接收", failure: undefined },
  { kind: "patch", event: "chainChanged", success: "Agent 设置已保存", failure: undefined },
  { kind: "pause", event: "accountsChanged", success: "Agent 已暂停，新操作已停止", failure: undefined },
  { kind: "run", event: "chainChanged", success: "请求已确认接收", failure: "503" },
] as const) {
  test(`session race: delayed ${scenario.kind} ${scenario.failure ?? "success"} after ${scenario.event} stays signed out and cannot publish its old response`, async ({ page }) => {
    const path = `/api/hosted/agents/${agentId}${scenario.kind === "run" ? "/runs" : scenario.kind === "pause" ? "/pause" : ""}`;
    const method = scenario.kind === "patch" ? "PATCH" : "POST";
    const gate = responseGate();
    let held: Command | undefined;
    const harness = await syntheticHosted(page, { ...(scenario.failure ? { firstRunFailure: scenario.failure } : {}), beforeWrite: async command => {
      if (!held && command.path === path && command.method === method) {
        held = command; gate.entered(); await gate.blocked;
      }
    } });
    const pendingKey = `agentfuel:hosted:pending:${owner.address.toLowerCase()}`;
    try {
      await page.goto("/dashboard");
      await expectAgentVisible(page, agentId);
      if (scenario.kind === "run") await page.getByRole("button", { name: "运行任务", exact: true }).click();
      else if (scenario.kind === "pause") {
        await showPanel(page, "Agent");
        await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
      }
      else {
        await showPanel(page, "Agent");
        await page.getByRole("button", { name: "编辑设置", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByLabel("名称", { exact: true }).fill("延迟返回的旧设置");
        await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
      }
      await gate.arrived;
      const original = held!.body;
      const readCount = harness.commands.filter(command => command.method === "GET").length;
      const saved = scenario.kind === "run" ? { owner: owner.address, kind: "run", agentId, input: original } : null;
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(saved);
      await emitWalletEvent(page, scenario.event);
      await showPanel(page, "请求");
      await expect.poll(() => writes(harness.commands, "/api/hosted/auth/logout").length).toBe(1);
      await expect(page.getByRole("alert").filter({ hasText: "钱包账号或网络已变化" })).toBeVisible();
      await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
      await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
      // The transport lock stays held until the old cookie-bearing request finishes.
      await expect(page.getByRole("button", { name: "等待钱包…", exact: true })).toBeDisabled();
      expect(writes(harness.commands, "/api/hosted/auth/login")).toEqual([]);
      const response = page.waitForResponse(value => value.url().endsWith(path) && value.request().method() === method);
      gate.release();
      await (await response).finished();
      await settleUi(page);
      await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
      await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
      await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: scenario.success })).toHaveCount(0);
      if (scenario.failure) {
        await expect(page.getByRole("alert").filter({ hasText: "钱包账号或网络已变化" })).toBeVisible();
        await expect(page.getByRole("alert").filter({ hasText: "托管服务暂时不可用" })).toHaveCount(0);
      }
      await expect(page.getByRole("heading", { name: "延迟返回的旧设置", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "继续 Agent", exact: true })).toHaveCount(0);
      if (scenario.kind === "run") await expect(page.getByTestId(`hosted-run-${original.requestId}`)).toHaveCount(0);
      expect(harness.commands.filter(command => command.method === "GET")).toHaveLength(readCount);
      expect(writes(harness.commands, path, method)).toHaveLength(1);
      expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(saved);
      // Fresh authentication reconciles the server state explicitly; the old response
      // itself must neither publish a success nor erase its owner's recovery hint.
      await page.getByRole("button", { name: "签名登录", exact: true }).click();
      await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
      await expectAgentVisible(page, agentId);
      if (scenario.kind === "run") {
        const retry = page.getByRole("button", { name: "继续确认原请求", exact: true });
        await expect(retry).toBeEnabled();
        expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(saved);
        await retry.click();
        await expect(retry).toHaveCount(0);
        expect(runWrites(harness.commands).map(command => command.body)).toEqual([original, original]);
        expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
      }
      await layout(page);
    } finally { gate.release(); }
  });
}

test("session race: a fresh sign-in waits for delayed wallet-change logout and keeps its new session", async ({ page }) => {
  const gate = responseGate();
  let delayed = false;
  const harness = await syntheticHosted(page, { beforeWrite: async command => {
    if (!delayed && command.path === "/api/hosted/auth/logout") {
      delayed = true; gate.entered(); await gate.blocked;
    }
  } });
  try {
    await page.goto("/dashboard");
    await expectAgentVisible(page, agentId);
    await emitWalletEvent(page, "chainChanged");
    await gate.arrived;
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await settleUi(page);
    expect(writes(harness.commands, "/api/hosted/auth/challenge")).toEqual([]);
    expect(writes(harness.commands, "/api/hosted/auth/login")).toEqual([]);
    expect(harness.signed).toEqual([]);
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    const logoutResponse = page.waitForResponse(value => value.url().endsWith("/api/hosted/auth/logout"));
    gate.release();
    await (await logoutResponse).finished();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    await expectAgentVisible(page, agentId);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toHaveLength(1);
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
    expect(harness.signed).toHaveLength(1);
    const refreshed = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "GET");
    await page.getByRole("button", { name: "刷新托管数据", exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await expectAgentVisible(page, agentId);
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toHaveCount(0);
    await layout(page);
  } finally { gate.release(); }
});

test("auth regression: accountsChanged from first wallet authorization is accepted as normal connection", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, agents: [], connectEvent: true });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "钱包签名登录成功" })).toBeVisible();
  expect(writes(harness.commands, "/api/hosted/auth/challenge")).toHaveLength(1);
  expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
  expect(writes(harness.commands, "/api/hosted/auth/logout")).toEqual([]);
  expect(harness.signed).toHaveLength(1);
  expect(await page.evaluate(() => (window as unknown as {
    ethereum: { __events: { event: string; payload: unknown }[] };
  }).ethereum.__events)).toEqual([{ event: "accountsChanged", payload: [owner.address] }]);
  await layout(page);
});

test("auth regression: wallet change during delayed login queues logout and fresh login waits for cleanup", async ({ page }) => {
  const loginGate = responseGate(), cleanupGate = responseGate();
  let delayedLogin = false, delayedLogout = false;
  const harness = await syntheticHosted(page, { authenticated: false, beforeWrite: async command => {
    if (!delayedLogin && command.path === "/api/hosted/auth/login") {
      delayedLogin = true; loginGate.entered(); await loginGate.blocked;
    } else if (!delayedLogout && command.path === "/api/hosted/auth/logout") {
      delayedLogout = true; cleanupGate.entered(); await cleanupGate.blocked;
    }
  } });
  try {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await loginGate.arrived;
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
    expect(harness.signed).toHaveLength(1);
    await emitWalletEvent(page, "chainChanged");
    await settleUi(page);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toEqual([]);
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "钱包签名登录成功" })).toHaveCount(0);
    const oldLoginResponse = page.waitForResponse(value => value.url().endsWith("/api/hosted/auth/login"));
    loginGate.release();
    await (await oldLoginResponse).finished();
    await cleanupGate.arrived;
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "钱包签名登录成功" })).toHaveCount(0);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toHaveLength(1);
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await settleUi(page);
    expect(writes(harness.commands, "/api/hosted/auth/challenge")).toHaveLength(1);
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
    expect(harness.signed).toHaveLength(1);
    const cleanupResponse = page.waitForResponse(value => value.url().endsWith("/api/hosted/auth/logout"));
    cleanupGate.release();
    await (await cleanupResponse).finished();
    await expect(page.getByRole("button", { name: "退出登录", exact: true })).toBeEnabled();
    await expectAgentVisible(page, agentId);
    await expect(page.getByRole("status").filter({ hasText: "钱包签名登录成功" })).toBeVisible();
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(2);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toHaveLength(1);
    expect(harness.signed).toHaveLength(2);
    const refreshed = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "GET");
    await page.getByRole("button", { name: "刷新托管数据", exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await expectAgentVisible(page, agentId);
    await layout(page);
  } finally { loginGate.release(); cleanupGate.release(); }
});

test("session race: delayed create cannot restore selected Agent and keeps full owner settings for explicit recovery", async ({ page }) => {
  const gate = responseGate();
  let held: Command | undefined;
  const harness = await syntheticHosted(page, { authenticated: false, agents: [], beforeWrite: async command => {
    if (!held && command.path === "/api/hosted/agents" && command.method === "POST") {
      held = command; gate.entered(); await gate.blocked;
    }
  } });
  const pendingKey = `agentfuel:hosted:pending:${owner.address.toLowerCase()}`;
  try {
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    await expect(page.getByRole("button", { name: "创建 Agent", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "创建 Agent", exact: true }).click();
    await configureTerminal(page, { ...settings, name: "延迟创建的合成 Agent" });
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await gate.arrived;
    const original = held!.body;
    expect(original).toEqual({ ...settings, name: "延迟创建的合成 Agent", requestId: expect.stringMatching(uuid) });
    const saved = { owner: owner.address, kind: "create", input: original };
    const readCount = harness.commands.filter(command => command.method === "GET").length;
    await emitWalletEvent(page, "accountsChanged");
    await expect.poll(() => writes(harness.commands, "/api/hosted/auth/logout").length).toBe(1);
    await expect(page.getByRole("region", { name: "确认 Agent 配置" })).toHaveCount(0);
    const response = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "POST");
    gate.release();
    await (await response).finished();
    await settleUi(page);
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
    await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Agent 已创建" })).toHaveCount(0);
    expect(harness.commands.filter(command => command.method === "GET")).toHaveLength(readCount);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), pendingKey)).toEqual(saved);
    await page.getByRole("button", { name: "签名登录", exact: true }).click();
    const retry = page.getByRole("button", { name: "继续确认原请求", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(writes(harness.commands, "/api/hosted/agents").map(command => command.body)).toEqual([original, original]);
    expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(1);
    await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveValue(agentId);
    await layout(page);
  } finally { gate.release(); }
});


test("reward task funding pause admits only token refueling", async ({ page }) => {
  const requestId = "22222222-2222-4222-8222-222222222222";
  const harness = await syntheticHosted(page, { agents: [makeAgent({ activeRequestId: requestId })], runs: [makeRun({
    requestId, action: "reward-task", status: "Paused", recoverable: true, reason: "INFERENCE_FUNDING_REQUIRED",
    result: { phase: "Paused", terminal: false, success: false, chargedRaw: "0", creditsUsed: 0 },
  })] });
  await page.goto("/dashboard"); await navigate(page, "任务");
  await expect(page.getByRole("button", { name: "运行任务", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "用奖励额度运行", exact: true })).toBeDisabled();
  await navigate(page, "竞技场");
  await expect(page.getByLabel("比赛奖励", { exact: true })).toHaveValue("llm-credits");
  await expect(page.getByLabel("比赛奖励", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "免费参赛", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(harness.commands.filter(command => command.path.endsWith("/runs")).at(-1)?.body).toEqual({ action: "game", rewardKind: "llm-credits", requestId: expect.stringMatching(uuid) });
  await layout(page);
});


test("metered gateway rates and bounded autonomous actions use configured host capabilities", async ({ page }) => {
  const harness = await syntheticHosted(page, { capabilities: {
    inference: { priceRaw: "120000", creditsRaw: "100000", models: [
      { id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { id: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" } ] },
    autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000" },
  } });
  await page.goto("/dashboard"); await navigate(page, "任务");
  await expect(page.getByText(/cheap 输入 1 \/ 输出 2/)).toBeVisible();
  await expect(page.getByText(/连续运行最多 2 单、3 分钟/)).toBeVisible();
  await mkdir(resolve("acceptance/core-runtime"), { recursive: true });
  await page.screenshot({ path: resolve(`acceptance/core-runtime/metered-${test.info().project.name}.png`), fullPage: true });
  await page.getByRole("button", { name: "按量推理 / 信用补额", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body.action).toBe("metered-task");
  await page.getByRole("button", { name: "Pi 连续运行", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(2);
  expect(runWrites(harness.commands)[1].body.action).toBe("autonomous");
  await layout(page);
});

for (const action of ["metered-task", "autonomous"] as const) test(`${action} cash funding pause permits deposit and resumes the original request without opening new tasks`, async ({ page }) => {
  const requestId = "22222222-2222-4222-8222-222222222222";
  const harness = await syntheticHosted(page, { agents: [makeAgent({ activeRequestId: requestId })], runs: [makeRun({ requestId, action, status: "Paused", recoverable: true,
    reason: "INFERENCE_FUNDING_REQUIRED", result: { phase: "Paused", terminal: false, success: false, chargedRaw: "0" } })], capabilities: {
    inference: { priceRaw: "120000", creditsRaw: "100000", models: [
      { id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { id: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" } ] },
    autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000" },
  } });
  await page.goto("/dashboard");
  const assertNewTasksBlocked = async () => {
    await navigate(page, "任务");
    for (const name of ["运行任务", "按量推理 / 信用补额", "Pi 连续运行", "用奖励额度运行"])
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  };
  await assertNewTasksBlocked();
  await navigate(page, "资金与额度");
  await page.getByLabel("入账金额（USDC）").fill("0.12");
  await expect(page.getByRole("button", { name: "用奖励额度运行任务", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "确认入账", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  const deposit = runWrites(harness.commands)[0].body;
  expect(deposit).toEqual({ action: "deposit", amountRaw: "120000", requestId: expect.stringMatching(uuid) });
  expect(deposit.requestId).not.toBe(requestId);
  // The admitted deposit leaves the paused parent active; only that original ID may resume.
  await assertNewTasksBlocked();
  await page.getByTestId(`hosted-run-${requestId}`).getByRole("button", { name: "恢复原请求", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(2);
  expect(runWrites(harness.commands)[1].body).toEqual({ action, requestId });
  expect(harness.rpcCalls).toEqual([]);
  await layout(page);
});
