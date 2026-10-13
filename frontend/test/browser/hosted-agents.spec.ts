import { test, expect, type Page, type Locator, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostedCapabilities } from "../../../services/hosted-agents/src/types";
import { owner, agentId, settings, uuid, makeAgent, makeRun, syntheticHosted, unexpectedByPage, type Command } from "./hosted-harness";
import { configureTerminal } from "./onboarding-steps";

// These are synthetic API browser contracts; real inference and chain evidence are separate.
const fatalByPage = new WeakMap<Page, string[]>();
const capabilities: HostedCapabilities = {
  goals: { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000" }, { id: "synthetic-model", pricePerCallRaw: "20000" }] },
  inference: { priceRaw: "120000", creditsRaw: "100000", models: [{ id: "kimi-k2.6", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" }] },
  autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000" },
};
test.beforeEach(async ({ page }) => { const fatal: string[] = []; fatalByPage.set(page, fatal); page.on("pageerror", error => fatal.push(error.message)); });
test.afterEach(async ({ page }) => { expect(fatalByPage.get(page)).toEqual([]); expect(unexpectedByPage.get(page)).toEqual([]); });
async function layout(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function showPanel(page: Page, name: "Agent" | "任务" | "资金") {
  if ((page.viewportSize()?.width ?? 1512) >= 900) return;
  const tab = page.getByRole("tab", { name: { Agent: "agent.sys", 任务: "mission.log", 资金: "mesh.net" }[name], exact: true }); await tab.click(); await expect(tab).toHaveAttribute("aria-selected", "true");
}
async function expectAgentVisible(page: Page, id: string) { await showPanel(page, "Agent"); await expect(page.getByTestId(`hosted-agent-${id}`)).toBeVisible(); await showPanel(page, "任务"); }
async function accountButton(page: Page,name:string){
 const trigger=page.getByRole('button',{name:'账户菜单',exact:true});if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
 return page.getByRole('menuitem',{name,exact:true});
}
async function choose(page: Page, label: string, option: string) {
  if (label === "当前 Agent") await showPanel(page, "Agent");
  await page.getByRole("combobox", { name: label, exact: true }).click();
  const pattern = new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:✓)?$`);
  await page.getByRole("listbox", { name: label, exact: true }).getByRole("option", { name: pattern }).click();
  if(label!=="操作类型"||!["游戏赚资金 / 额度","资金入账"].includes(option))await expect(page.getByRole("combobox", { name: label, exact: true })).toContainText(option);
  if (label === "当前 Agent") await showPanel(page, "任务");
}
async function chooseMode(page: Page, option: string) { await showPanel(page, "任务"); await choose(page, "操作类型", option); if(option==="游戏赚资金 / 额度")await page.getByRole("link",{name:/选择 Agent 参赛/}).click(); if(option==="资金入账")await page.getByRole("tab",{name:"任务",exact:true}).click(); }
async function executeOperation(page: Page) { await page.getByRole("button", { name: "执行操作", exact: true }).click(); }
async function revealRun(page: Page, id: string): Promise<Locator> {
  await showPanel(page, "任务"); const row = page.getByTestId(`hosted-run-${id}`);
  if (!await row.count()) { await page.getByRole("button", { name: /^历史/ }).click(); await page.getByTestId(`history-request-${id}`).click(); }
  await expect(row).toHaveCount(1);
  const ancestors = row.locator("xpath=ancestor::details");
  for (let index = 0; index < await ancestors.count(); index++) { const item = ancestors.nth(index); if (!await item.evaluate(node => (node as HTMLDetailsElement).open)) await item.locator(":scope > summary").click(); }
  await expect(row).toBeVisible(); return row;
}
async function captureSynthetic(page: Page, name: string, info: TestInfo) {
  const directory = resolve(info.project.testDir, "../../acceptance/upstream-sync-20261013"); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `synthetic-${name}-${info.project.name}.png`), fullPage: true, scale: "css", style: "nextjs-portal { display:none !important }" });
}
const writes = (commands: Command[], path: string, method = "POST") => commands.filter(command => command.path === path && command.method === method);
const runWrites = (commands: Command[], id = agentId) => writes(commands, `/api/hosted/agents/${id}/runs`);

test("Agora layout keeps Hunter, mesh roles, idle timeline, command composer and event footer", async ({ page }, info) => {
  const harness = await syntheticHosted(page, { capabilities }); await page.goto("/dashboard");
  await expectAgentVisible(page, agentId);
  await expect(page.getByRole("combobox", { name: "当前 Agent", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "操作类型", exact: true })).toContainText("ϟ 指挥模式");
  await expect(page.getByText("等待任务输入", { exact: false })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "任务目标" })).toBeVisible();
  await expect(page.locator("select")).toHaveCount(0);
  await expect(page.getByText(/高级与演示入口|API PAUSED|服务端记录/)).toHaveCount(0);
  const dock = page.getByTestId("hosted-action-dock"), viewport = page.viewportSize()!;
  await expect(dock).toBeVisible(); const bounds = (await dock.boundingBox())!; expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
  await expect(page.getByRole("button", { name: "暂停 Agent 动态", exact: true })).toBeVisible();
  const dots = page.getByTestId("hosted-terminal-dot"); await expect(dots).toHaveCount(3);
  const model = page.getByRole("combobox", { name: "操作类型", exact: true });
  await model.focus(); await model.press("ArrowDown"); await expect(page.getByRole("listbox", { name: "操作类型" })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(model).toBeFocused(); await expect(model).toHaveAttribute("aria-expanded", "false");
  for (const panel of ["Agent", "资金", "任务"] as const) { await showPanel(page, panel); await layout(page); }
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]); expect(harness.rpcCalls).toEqual([]);
  await captureSynthetic(page, "workspace", info);
});

for (const scenario of ["signed-out", "unavailable"] as const) test(`${scenario} renders an unavailable composer without admitting execution`, async ({ page }) => {
  const harness = await syntheticHosted(page, scenario === "signed-out" ? { authenticated: false, agents: [] } : { error: { status: 503, code: "HOSTED_NOT_CONFIGURED" } });
  await page.goto("/dashboard"); await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发送任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "当前 Agent", exact: true })).toHaveCount(0);
  if (scenario === "unavailable") await expect(page.getByRole("alert").filter({hasText:"托管服务尚未配置"})).toBeVisible();
  for (const panel of ["Agent", "资金", "任务"] as const) { await showPanel(page, panel); await layout(page); }
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]); expect(harness.rpcCalls).toEqual([]);
});

test("signed login creates a name-only Agent from the account menu before runtime settings", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, agents: [] }); await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click(); await (await accountButton(page, "创建 Agent")).click();
  await expect(page).toHaveURL(/\/onboarding$/); await configureTerminal(page, settings); await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expectAgentVisible(page, agentId);
  expect(writes(harness.commands, "/api/hosted/agents").map(command => command.body)).toEqual([{ name: settings.name, requestId: expect.stringMatching(uuid) }]);
  expect(harness.signed[0].message).toBe(harness.challenge.message);
  await expect(page.getByRole("button", { name: "发送任务", exact: true })).toBeDisabled();
});

test("settings use custom model/strategy dropdowns and all funded operation modes remain available", async ({ page }) => {
  const harness = await syntheticHosted(page, { capabilities }); await page.goto("/dashboard"); await expectAgentVisible(page, agentId); await showPanel(page, "Agent");
  await page.getByRole("button", { name: "运行设置", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill("已更新的合成 Agent"); await choose(page, "模型", "Synthetic Model"); await choose(page, "策略", "保守");
  await dialog.getByLabel("单次推理预算（USDC）", { exact: true }).fill("0.05"); await dialog.getByLabel("累计推理预算（USDC）", { exact: true }).fill("0.8");
  await dialog.getByLabel("允许任务授信", { exact: true }).uncheck(); await dialog.getByRole("button", { name: "保存设置", exact: true }).click(); await expect(dialog).toBeHidden();
  expect(writes(harness.commands, `/api/hosted/agents/${agentId}`, "PATCH")[0].body).toEqual({ name: "已更新的合成 Agent", modelId: "synthetic-model", strategy: "conservative", perRunBudgetRaw: "50000", totalBudgetRaw: "800000", allowCredit: false });
  await page.getByRole("button", { name: "暂停 Agent", exact: true }).click(); await page.getByRole("button", { name: "继续 Agent", exact: true }).click();
  for (const [label, action] of [["接取有报酬的任务", "task"], ["接单 · 按量推理", "metered-task"], ["Pi 自主接单", "autonomous"]]) {
    await chooseMode(page, label); await executeOperation(page); await expect.poll(() => runWrites(harness.commands).at(-1)?.body.action).toBe(action);
  }
  await chooseMode(page, "游戏赚资金 / 额度"); await choose(page, "比赛奖励", "LLM credits"); await executeOperation(page);
  await chooseMode(page, "资金入账"); await page.getByLabel("入账金额（USDC）").fill("0.04"); await executeOperation(page);
  await expect.poll(() => runWrites(harness.commands).length).toBe(5);
  expect(runWrites(harness.commands).at(-1)?.body).toEqual({ action: "deposit", amountRaw: "40000", requestId: expect.stringMatching(uuid) });
  await showPanel(page, "Agent"); await page.getByRole("button", { name: "运行设置", exact: true }).click(); await choose(page, "模型", "Kimi K2.6");
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click(); await expect(dialog).toBeHidden();
  await chooseMode(page, "用奖励额度接单"); await executeOperation(page); await expect.poll(() => runWrites(harness.commands).length).toBe(6);
  expect(runWrites(harness.commands).map(command => command.body.action)).toEqual(["task", "metered-task", "autonomous", "game", "deposit", "reward-task"]);
  expect(harness.rpcCalls).toEqual([]); await layout(page);
});

test("free-form goal supports multiline editing, Enter submit, artifact and independent review display", async ({ page }, info) => {
  const harness = await syntheticHosted(page, { capabilities }); await page.goto("/dashboard"); await expectAgentVisible(page, agentId);
  const input = page.getByRole("textbox", { name: "任务目标" }); await input.fill("帮我比较三种 Agent 商业模式"); await input.press("Shift+Enter"); await input.pressSequentially("Give a concrete recommendation.");
  const goal = await input.inputValue(); expect(goal).toContain("\n"); expect(runWrites(harness.commands)).toEqual([]);
  await input.press("Enter"); await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body).toEqual({ action: "goal", goal, requestId: expect.stringMatching(uuid) });
  await expect(input).toHaveValue(""); const transcript = page.getByRole("article", { name: "目标任务结果" });
  await expect(transcript).toContainText(goal); await expect(transcript).toContainText("Synthetic review"); await expect(transcript).toContainText("Synthetic test artifact");
  expect(harness.rpcCalls).toEqual([]); await layout(page); await captureSynthetic(page, "goal-result", info);
});

for (const operation of ["recover", "cancel"] as const) test(`paused goal ${operation} uses original identity and full text`, async ({ page }) => {
  const original = makeRun({ action: "goal", goal: "  原始目标\nExact text.  ", status: "Paused", recoverable: true, reason: "HOSTED_GOAL_CALL_UNCERTAIN", result: undefined, mission: { stage: "paused", phases: [], calls: [] } });
  const harness = await syntheticHosted(page, { capabilities, agents: [makeAgent({ activeRequestId: original.requestId })], runs: [original] });
  await page.goto("/dashboard"); await expectAgentVisible(page, agentId);
  await expect(page.getByRole("button", { name: "发送任务", exact: true })).toBeDisabled();
  if (operation === "recover") {
    await page.getByRole("button", { name: /^恢复原请求/ }).click(); await expect.poll(() => runWrites(harness.commands).length).toBe(1);
    expect(runWrites(harness.commands)[0].body).toEqual({ action: "goal", goal: original.goal, requestId: original.requestId });
  } else {
    await page.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect.poll(() => writes(harness.commands, `/api/hosted/agents/${agentId}/cancel`).length).toBe(1);
    expect(writes(harness.commands, `/api/hosted/agents/${agentId}/cancel`)[0].body).toEqual({ requestId: original.requestId }); expect(runWrites(harness.commands)).toEqual([]);
    await expect(page.getByRole("button", { name: "停止任务", exact: true })).toHaveCount(0);
  }
  expect(harness.rpcCalls).toEqual([]); await layout(page);
});

for (const scenario of [{ action: "goal", failure: "abort" }, { action: "game", failure: "abort" }, { action: "deposit", failure: "503" }] as const) {
  test(`${scenario.action} uncertain response persists full command and confirms same UUID after reload`, async ({ page }) => {
    const harness = await syntheticHosted(page, { capabilities, firstRunFailure: scenario.failure }); await page.goto("/dashboard"); await expectAgentVisible(page, agentId);
    if (scenario.action === "goal") { await page.getByLabel("任务目标").fill("Write a useful launch plan."); await page.getByRole("button", { name: "发送任务", exact: true }).click(); }
    else { await chooseMode(page, scenario.action === "game" ? "游戏赚资金 / 额度" : "资金入账"); if (scenario.action === "game") await choose(page, "比赛奖励", "LLM credits"); else await page.getByLabel("入账金额（USDC）").fill("0.073421"); await executeOperation(page); }
    const retry = page.getByRole("button", { name: "继续确认原请求", exact: true }); await expect(retry).toBeEnabled();
    const original = runWrites(harness.commands)[0].body, key = `agentfuel:hosted:pending:${owner.address.toLowerCase()}`;
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), key)).toEqual({ owner: owner.address, kind: "run", agentId, input: original });
    await page.reload(); await expect(retry).toBeEnabled(); expect(runWrites(harness.commands)).toHaveLength(1); await retry.click(); await expect(retry).toHaveCount(0);
    expect(runWrites(harness.commands).map(command => command.body)).toEqual([original, original]); expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
    expect(harness.rpcCalls).toEqual([]); await layout(page);
  });
}

test("agent dropdown isolates goal drafts and submissions by selected identity", async ({ page }) => {
  const second = makeAgent({ id: "second-agent", name: "第二个 Agent" }); const harness = await syntheticHosted(page, { capabilities, agents: [makeAgent(), second] });
  await page.goto("/dashboard"); await expectAgentVisible(page, agentId); await page.getByLabel("任务目标").fill("First agent draft");
  await choose(page, "当前 Agent", second.name); await expectAgentVisible(page, second.id); await expect(page.getByLabel("任务目标")).toHaveValue("");
  await page.getByLabel("任务目标").fill("Second agent task"); await page.getByRole("button", { name: "发送任务", exact: true }).click(); await expect.poll(() => runWrites(harness.commands, second.id).length).toBe(1);
  await choose(page, "当前 Agent", settings.name); await expect(page.getByLabel("任务目标")).toHaveValue("First agent draft"); await page.getByRole("button", { name: "发送任务", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body.goal).toBe("First agent draft"); expect(runWrites(harness.commands, second.id)[0].body.goal).toBe("Second agent task");
});

for (const invalidation of ["logout-401", "expired-session-401"] as const) test(`${invalidation} clears identity and execution data across reload`, async ({ page }) => {
  const previous = makeRun(); const harness = await syntheticHosted(page, { runs: [previous], ...(invalidation === "logout-401" ? { logoutStatus: 401 } : {}) });
  await page.goto("/dashboard"); await expectAgentVisible(page, agentId); await revealRun(page, previous.requestId);
  if (invalidation === "logout-401") await (await accountButton(page, "退出登录")).click(); else { harness.expireSession(); await (await accountButton(page,"刷新数据")).click(); }
  await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible(); await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
  await page.reload(); await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled(); await expect(page.getByTestId(`hosted-run-${previous.requestId}`)).toHaveCount(0);
  expect(runWrites(harness.commands)).toEqual([]); expect(harness.rpcCalls).toEqual([]);
});
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
      if (scenario.kind === "run") { await chooseMode(page, "接取有报酬的任务"); await executeOperation(page); }
      else if (scenario.kind === "pause") {
        await showPanel(page, "Agent");
        await page.getByRole("button", { name: "暂停 Agent", exact: true }).click();
      }
      else {
        await showPanel(page, "Agent");
        await page.getByRole("button", { name: "运行设置", exact: true }).click();
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
      await showPanel(page, "任务");
      await expect.poll(() => writes(harness.commands, "/api/hosted/auth/logout").length).toBe(1);
      await expect(page.getByRole("alert").filter({ hasText: "钱包账号或网络已变化" })).toBeVisible();
      await expect(page.getByTestId(`hosted-agent-${agentId}`)).toHaveCount(0);
      await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
      // The transport lock stays held until the old cookie-bearing request finishes.
      await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeDisabled();
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
      await expect(await accountButton(page, "退出登录")).toBeEnabled();
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
    await expect(await accountButton(page, "退出登录")).toBeEnabled();
    await expectAgentVisible(page, agentId);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toHaveLength(1);
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(1);
    expect(harness.signed).toHaveLength(1);
    const refreshed = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "GET");
    await (await accountButton(page,"刷新数据")).click();
    expect((await refreshed).status()).toBe(200);
    await expectAgentVisible(page, agentId);
    await expect(await accountButton(page, "退出登录")).toBeEnabled();
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toHaveCount(0);
    await layout(page);
  } finally { gate.release(); }
});

test("auth regression: accountsChanged from first wallet authorization is accepted as normal connection", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, agents: [], connectEvent: true });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(await accountButton(page, "退出登录")).toBeEnabled();
  await expect(await accountButton(page, "创建 Agent")).toBeEnabled();
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
    await expect(await accountButton(page, "退出登录")).toBeEnabled();
    await expectAgentVisible(page, agentId);
    await expect(page.getByRole("status").filter({ hasText: "钱包签名登录成功" })).toBeVisible();
    expect(writes(harness.commands, "/api/hosted/auth/login")).toHaveLength(2);
    expect(writes(harness.commands, "/api/hosted/auth/logout")).toHaveLength(1);
    expect(harness.signed).toHaveLength(2);
    const refreshed = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "GET");
    await (await accountButton(page,"刷新数据")).click();
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
    await expect(await accountButton(page, "创建 Agent")).toBeEnabled();
    await (await accountButton(page,"创建 Agent")).click();
    await configureTerminal(page, { ...settings, name: "延迟创建的合成 Agent" });
    await page.getByRole("button", { name: "确认创建", exact: true }).click();
    await gate.arrived;
    const original = held!.body;
    expect(original).toEqual({ name: "延迟创建的合成 Agent", requestId: expect.stringMatching(uuid) });
    const saved = { owner: owner.address, kind: "create", input: original };
    const readCount = harness.commands.filter(command => command.method === "GET").length;
    await emitWalletEvent(page, "accountsChanged");
    await expect.poll(() => writes(harness.commands, "/api/hosted/auth/logout").length).toBe(1);
    await expect(page.getByRole("region", { name: "确认创建 Agent" })).toHaveCount(0);
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
    await expect(page.getByTestId(`hosted-agent-${agentId}`)).toContainText("延迟创建的合成 Agent");
    await layout(page);
  } finally { gate.release(); }
});



for (const original of [
  makeRun({ action: "game", rewardKind: "llm-credits", status: "Paused", recoverable: true, reason: "SYNTHETIC_RECOVERABLE", result: undefined }),
  makeRun({ requestId: "22222222-2222-4222-8222-222222222222", action: "deposit", amountRaw: "40000", status: "Paused", recoverable: true, reason: "SYNTHETIC_RECOVERABLE", result: undefined }),
]) test(`${original.action} recovery retains saved amount/reward under original request ID`, async ({ page }) => {
  const harness = await syntheticHosted(page, { agents: [makeAgent({ activeRequestId: original.requestId })], runs: [original] });
  await page.goto("/dashboard"); const row = await revealRun(page, original.requestId); await row.getByRole("button", { name: "恢复原请求", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body).toEqual({ requestId: original.requestId, action: original.action, ...(original.rewardKind ? { rewardKind: original.rewardKind } : {}), ...(original.amountRaw ? { amountRaw: original.amountRaw } : {}) });
  expect(harness.rpcCalls).toEqual([]);
});

test("reward funding pause forces the token reward option and blocks new tasks", async ({ page }) => {
  const requestId = "22222222-2222-4222-8222-222222222222";
  const harness = await syntheticHosted(page, { capabilities, agents: [makeAgent({ activeRequestId: requestId })], runs: [makeRun({ requestId, action: "reward-task", status: "Paused", recoverable: true, reason: "INFERENCE_FUNDING_REQUIRED", result: undefined })] });
  await page.goto("/dashboard"); await chooseMode(page, "接取有报酬的任务"); await expect(page.getByRole("button", { name: "执行操作", exact: true })).toBeDisabled();
  await chooseMode(page, "游戏赚资金 / 额度"); await expect(page.getByRole("combobox", { name: "比赛奖励" })).toContainText("LLM credits"); await expect(page.getByRole("combobox", { name: "比赛奖励" })).toBeDisabled();
  await executeOperation(page); await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body).toEqual({ action: "game", rewardKind: "llm-credits", requestId: expect.stringMatching(uuid) });
});

for (const action of ["goal", "metered-task", "autonomous"] as const) test(`${action} cash pause permits deposit and original-request recovery only`, async ({ page }) => {
  const requestId = "22222222-2222-4222-8222-222222222222", goal = action === "goal" ? "Write the original plan" : undefined;
  const harness = await syntheticHosted(page, { capabilities, agents: [makeAgent({ activeRequestId: requestId })], runs: [makeRun({ requestId, action, ...(goal ? { goal } : {}), status: "Paused", recoverable: true, reason: "INFERENCE_FUNDING_REQUIRED", result: undefined })] });
  await page.goto("/dashboard"); await chooseMode(page, "接取有报酬的任务"); await expect(page.getByRole("button", { name: "执行操作", exact: true })).toBeDisabled();
  await chooseMode(page, "资金入账"); await page.getByLabel("入账金额（USDC）").fill("0.12"); await executeOperation(page); await expect.poll(() => runWrites(harness.commands).length).toBe(1);
  expect(runWrites(harness.commands)[0].body).toEqual({ action: "deposit", amountRaw: "120000", requestId: expect.stringMatching(uuid) });
  await chooseMode(page, "Pi 自主接单"); await expect(page.getByRole("button", { name: "执行操作", exact: true })).toBeDisabled();
  if (action === "goal") {await page.getByRole("button",{name:/^历史/}).click();await page.getByTestId(`history-request-${requestId}`).click();await page.getByRole("button", { name: /^恢复原请求/ }).click();}
  else await (await revealRun(page, requestId)).getByRole("button", { name: "恢复原请求", exact: true }).click();
  await expect.poll(() => runWrites(harness.commands).length).toBe(2);
  expect(runWrites(harness.commands)[1].body).toEqual({ action, requestId, ...(goal ? { goal } : {}) }); expect(harness.rpcCalls).toEqual([]);
});
