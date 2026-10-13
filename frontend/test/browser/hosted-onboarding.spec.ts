import { test, expect, type Page } from "@playwright/test";
import { Wallet } from "ethers";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { agentId, owner, settings, uuid, makeAgent, syntheticHosted, unexpectedByPage, type Command } from "./hosted-harness";
import { configureTerminal } from "./onboarding-steps";

async function agentPane(page:Page){const tab=page.getByRole('tab',{name:'agent.sys',exact:true});if(await tab.isVisible())await tab.click();}
async function choose(page:Page,label:string,name:string){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).getByRole('option',{name,exact:true}).click();}
test.afterEach(async ({ page }) => { expect(unexpectedByPage.get(page)).toEqual([]); });

test("onboarding: source terminal signs in, creates by name before configuring execution and selects the new Agent in dashboard", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const harness = await syntheticHosted(page, { authenticated: false, agents: [makeAgent({ id: "older-agent", name: "已有 Agent" })], createAtEnd: true });
  await page.goto("/");
  expect(harness.commands).toEqual([]);
  await page.getByRole("link", { name: "CREATE YOUR AGENT", exact: true }).first().click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId("onboarding-terminal-header").locator('[data-testid="terminal-page-dot"]')).toHaveCount(3);
  const shell = page.getByTestId("onboarding-terminal-shell");
  expect(await shell.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(22, 10, 2)");
  const font = await shell.evaluate(element => { const css = getComputedStyle(element); return { family: css.fontFamily.split(",")[0], variable: css.getPropertyValue("--font-geist-mono") }; });
  expect(font.family.replace(/['"]/g, "").trim()).toBe(font.variable.replace(/['"]/g, "").trim());
  await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
  const banner = await page.getByTestId("onboarding-transcript").innerText();
  expect(banner.split("\n").filter(line => /^[╔║╚]/.test(line)).map(line => line.length)).toEqual([34, 34, 34, 34]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await configureTerminal(page, { ...settings, modelId: "synthetic-model", strategy: "conservative" }, true);
  const review = page.getByRole("region", { name: "确认创建 Agent" });
  await expect(review).toContainText(settings.name); await expect(review).toContainText("尚未授权");
  expect(harness.commands.filter(command => command.path === "/api/hosted/agents" && command.method === "POST")).toEqual([]);
  await page.screenshot({ path: info.outputPath("source-terminal-review.png"), fullPage: true });
  const directory = resolve("frontend/acceptance/upstream-sync-20261013"); await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `synthetic-terminal-review-${info.project.name}.png`), fullPage: true, style: "nextjs-portal { display:none !important; }" });
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await agentPane(page);await expect(page.getByTestId(`hosted-agent-${agentId}`)).toBeVisible();
  expect(harness.commands.filter(command => command.path === "/api/hosted/agents" && command.method === "POST").map(command => command.body))
    .toEqual([{ name: settings.name, requestId: expect.stringMatching(uuid) }]);
  await expect(page.getByTestId("hosted-panel-agent").getByRole("button",{name:"设置模型与预算 →",exact:true})).toBeVisible();
  await page.getByRole("button", { name: "设置模型与预算 →", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", {name:"模型",exact:true})).toContainText("选择运行模型");
  await expect(dialog.getByLabel("允许任务授信", { exact: true })).not.toBeChecked();
  await choose(page,"模型","Synthetic Model");
  await choose(page,"策略","保守");
  await dialog.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(harness.commands.filter(command => command.method === "PATCH").map(command => command.body)).toEqual([
    { name: settings.name, modelId: "synthetic-model", strategy: "conservative", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: false },
  ]);
  expect(harness.signed.map(signature => signature.message)).toEqual([harness.challenge.message]);
  expect(harness.rpcCalls.every(call => ["eth_requestAccounts", "eth_accounts", "eth_chainId", "personal_sign"].includes(call.method))).toBe(true);
  expect(errors).toEqual([]);
});

test("onboarding: an uncertain create reloads and confirms the original UUID and name", async ({ page }) => {
  const harness = await syntheticHosted(page, { firstCreateFailure: "503", agents: [makeAgent({ id: "older-agent" })] });
  const pendingKey = `agentfuel:hosted:pending:${owner.address.toLowerCase()}`;
  await page.goto("/onboarding");
  await configureTerminal(page, { ...settings, name: "原请求 Agent", allowCredit: false });
  await page.getByRole("button", { name: "确认创建", exact: true }).click();
  await expect(page.getByRole("button", { name: "继续确认原请求", exact: true })).toBeEnabled();
  const original = harness.commands.find(command => command.path === "/api/hosted/agents" && command.method === "POST")!.body;
  await page.reload();
  const review = page.getByRole("region", { name: "确认创建 Agent" });
  await expect(review).toContainText("原请求 Agent"); await expect(review).toContainText(String(original.requestId)); await expect(review).toContainText("尚未授权");
  await expect(page.getByRole("button", { name: "确认创建", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "继续确认原请求", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await agentPane(page);await expect(page.getByTestId(`hosted-agent-${agentId}`)).toBeVisible();
  expect(harness.commands.filter(command => command.path === "/api/hosted/agents" && command.method === "POST").map(command => command.body)).toEqual([original, original]);
  expect(await page.evaluate(key => localStorage.getItem(key), pendingKey)).toBeNull();
});

test("onboarding: an unconfigured service never offers a model, fake registration or create request", async ({ page }) => {
  const harness = await syntheticHosted(page, { error: { status: 503, code: "HOSTED_NOT_CONFIGURED" } });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "开始创建 ↵", exact: true }).click();
  await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert").filter({ hasText: "托管服务尚未配置" })).toBeVisible();
  await expect(page.getByLabel("模型", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "确认创建", exact: true })).toHaveCount(0);
  expect(harness.commands.filter(command => command.method !== "GET")).toEqual([]); expect(harness.rpcCalls).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("onboarding: leaving an in-flight create keeps the destination and stops hosted reads", async ({ page }) => {
  let release!: () => void, arrived!: () => void, held: Command | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; }), accepted = new Promise<void>(resolve => { arrived = resolve; });
  const harness = await syntheticHosted(page, { agents: [makeAgent({ id: "older-agent" })], beforeWrite: async command => {
    if (command.path === "/api/hosted/agents" && command.method === "POST") { held = command; arrived(); await gate; }
  } });
  try {
    await page.goto("/onboarding"); await configureTerminal(page, settings);
    await page.getByRole("button", { name: "确认创建", exact: true }).click(); await accepted;
    await page.getByRole("link", { name: "返回 Tabby 产品首页", exact: true }).click();
    await expect(page).toHaveURL(String(test.info().project.use.baseURL)+"/");
    const reads = harness.commands.filter(command => command.method === "GET").length;
    const response = page.waitForResponse(value => value.url().endsWith("/api/hosted/agents") && value.request().method() === "POST");
    release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page).toHaveURL(String(test.info().project.use.baseURL)+"/"); expect(held).toBeDefined();
    expect(harness.commands.filter(command => command.method === "GET")).toHaveLength(reads);
    // The same provider continues to notice wallet changes outside the hosted routes.
    await page.evaluate(() => (window as unknown as { ethereum: { __emit(event: string, payload: unknown): void } }).ethereum.__emit("accountsChanged", []));
    await expect.poll(() => harness.commands.filter(command => command.path === "/api/hosted/auth/logout").length).toBe(1);
    await page.getByRole("link", { name: "WORKSPACE", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeEnabled();
    await expect(page.getByLabel("当前 Agent", { exact: true })).toHaveCount(0);
  } finally { release(); }
});

test("onboarding: changing to another owner clears transcript, review and all draft fields before signing in", async ({ page }) => {
  const harness = await syntheticHosted(page), other = new Wallet("0x" + "4".repeat(64));
  await page.goto("/onboarding"); await configureTerminal(page, { ...settings, name: "A 的私有配置名称" });
  await expect(page.getByRole("region", { name: "确认创建 Agent" })).toContainText("A 的私有配置名称");
  harness.useOwner(other);
  await page.evaluate(address => (window as unknown as { ethereum: { __emit(event: string, payload: unknown): void } }).ethereum.__emit("accountsChanged", [address]), other.address);
  await expect(page.getByRole("region", { name: "确认创建 Agent" })).toHaveCount(0);
  await expect(page.getByTestId("onboarding-transcript")).not.toContainText(owner.address);
  await expect(page.getByTestId("onboarding-transcript")).not.toContainText("A 的私有配置名称");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("");
  await expect(page.getByTestId("onboarding-transcript")).toContainText(other.address);
  await expect(page.getByRole("button", { name: "确认创建", exact: true })).toHaveCount(0);
  expect(harness.commands.filter(command => command.path === "/api/hosted/agents" && command.method === "POST")).toEqual([]);
});
