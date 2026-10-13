import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { HoldemSnapshot } from "../../lib/holdem-types";
import { amount } from "../../lib/format";
const captureDir = resolve("acceptance/arena-gamefi");
const fatalMessages: string[] = [];
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); }
async function screenshot(page: Page, name: string, project: string) { await mkdir(captureDir, { recursive: true }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${captureDir}/${name}-${project}.png`, fullPage: true, style: "nextjs-portal { display: none !important }" }); }
async function start(page: Page, game: string) {
  await page.goto(`/arena?game=${game}&mode=challenge`);
  await page.getByRole("button", { name: "开始练习", exact: true }).click();
  await expect(page.getByRole("button", { name: "准备开局", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "准备开局", exact: true }).click();
  await expect(page.getByText("正在对局", { exact: true })).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  // Practice and historical evidence tests never dispatch a paid GameFi action.
  await page.route("**/api/arena/gamefi**", route => route.fulfill({ json: { enabled: false, rewardKinds: [], runs: [] } }));
  await page.route("**/api/arena/credits**", route => route.fulfill({ json: { enabled: false } }));
  fatalMessages.length = 0; page.on("pageerror", error => fatalMessages.push(error.message)); });
test.afterEach(async () => { expect(fatalMessages).toEqual([]); });

test("GameFi lobby keeps all four practice games and local covers", async ({ page }, testInfo) => {
  const failures: string[] = []; const external: string[] = [];
  page.on("requestfailed", request => failures.push(request.url()));
  page.on("request", request => { if (!request.url().startsWith("http://127.0.0.1") && !request.url().startsWith("data:")) external.push(request.url()); });
  await page.goto("/arena");
  await expect(page.getByRole("heading", { name: "游戏大厅", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /^进入/ })).toHaveCount(8);
  for (const game of ["扑克", "五子棋", "国际象棋", "小丑牌"]) await expect(page.getByRole("link", { name: `进入策略练习${game}对局`, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "德州奖励档案", exact: false })).toHaveAttribute("href", "/arena/holdem");
  const images = await page.locator(".af-game-card img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
  expect(images).toBe(true); await noOverflow(page); await screenshot(page, "lobby", testInfo.project.name);
  expect(failures).toEqual([]); expect(external).toEqual([]);
});

test("poker legal action ends one real hand, refresh keeps seat and history", async ({ page }, testInfo) => {
  await page.goto("/arena?game=poker&mode=challenge");
  await expect(page.getByLabel("最多手数")).toHaveValue("10");
  await page.getByLabel("最多手数").selectOption("1");
  await page.getByRole("button", { name: "开始练习", exact: true }).click();
  await page.getByRole("button", { name: "准备开局", exact: true }).click();
  await expect(page.getByRole("button", { name: "弃牌", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "弃牌", exact: true }).click();
  await expect(page.getByRole("heading", { name: "每手结果" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "练习对局已结算" })).toBeVisible();
  const url = page.url(); await page.reload(); await expect(page.getByRole("heading", { name: "每手结果" })).toBeVisible(); expect(page.url()).toBe(url);
  await expect(page.getByLabel("最多手数")).toHaveValue("1");
  await page.getByText("Agent 接入 · 复制提示词", { exact: true }).click();
  await expect(page.getByLabel("Agent 接入提示词")).toHaveValue(/Authorization: Bearer/);
  await page.getByText("Agent 接入 · 复制提示词", { exact: true }).click();
  await noOverflow(page); await screenshot(page, "poker-finished", testInfo.project.name);
  await page.getByRole("tab", { name: "历史对局", exact: true }).click(); await expect(page.locator(".af-history")).toContainText("扑克");
});

test("gomoku manual placement, bot reply and turn logs", async ({ page }, testInfo) => {
  await start(page, "gomoku");
  await page.getByRole("button", { name: "H8, 空位", exact: true }).click();
  await expect(page.getByRole("button", { name: "H8, 黑子", exact: true })).toBeVisible();
  await expect(page.locator(".af-gomoku-stone:not([hidden])")).toHaveCount(2);
  await page.getByRole("tab", { name: "你的 Agent", exact: true }).click();
  await expect(page.locator(".af-log-list")).toContainText("place");
  await noOverflow(page); await screenshot(page, "gomoku-playing", testInfo.project.name);
  await page.getByRole("button", { name: "认输", exact: true }).click(); await expect(page.getByRole("status").filter({hasText:"练习对局已结算"})).toBeVisible();
});

test("chess selects source and legal destination with bot response", async ({ page }, testInfo) => {
  await start(page, "chess");
  await page.getByRole("button", { name: "e2 白兵", exact: true }).click();
  await expect(page.getByRole("button", { name: "e4 空位 可移动", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "e4 空位 可移动", exact: true }).click();
  await expect(page.getByRole("button", { name: "e4 白兵", exact: true })).toBeVisible();
  await expect(page.locator(".af-board-note")).toContainText("已行 2 步");
  await noOverflow(page); await screenshot(page, "chess-playing", testInfo.project.name);
  await page.getByRole("button", { name: "认输", exact: true }).click();
});

test("balatro has real eight-card hand, selects cards and scores", async ({ page }, testInfo) => {
  await start(page, "balatro");
  await expect(page.getByRole("checkbox")).toHaveCount(8);
  await page.getByRole("checkbox").nth(0).click(); await page.getByRole("checkbox").nth(1).click();
  await expect(page.getByRole("checkbox", {checked:true})).toHaveCount(2);
  await page.getByRole("button", {name:"弃牌",exact:true}).click();
  await expect(page.locator(".af-balatro-stats")).toContainText("剩余弃牌2");
  await page.getByRole("checkbox").nth(0).click(); await page.getByRole("checkbox").nth(1).click(); await page.getByRole("checkbox").nth(2).click();
  await page.getByRole("button", {name:"出牌",exact:true}).click(); await expect(page.locator(".af-score")).toBeVisible();
  await expect(page.locator(".af-balatro-stats")).toContainText("剩余出牌3");
  await noOverflow(page); await screenshot(page,"balatro-playing",testInfo.project.name);
  await page.getByRole("button",{name:"认输",exact:true}).click(); await expect(page.locator(".af-outcome")).toContainText("挑战失败");
});

test("two browser seats use invite code, ready and cancel preserve no winner", async ({ page, browser }, testInfo) => {
  await page.goto("/arena?game=gomoku&mode=practice");
  await page.getByRole("button",{name:"创建邀请练习",exact:true}).click();
  const inviteLabel=await page.getByRole("button",{name:/复制邀请链接/}).innerText(); const inviteCode=inviteLabel.split("·").at(-1)!.trim();
  const guestContext=await browser.newContext({viewport:testInfo.project.use.viewport});const guest=await guestContext.newPage();
  await guest.goto(new URL(`/arena?game=gomoku&mode=practice&inviteCode=${inviteCode}`, page.url()).href);
  await guest.getByLabel("Agent 名称",{exact:true}).fill("好友 Agent");
  await guest.getByRole("button",{name:"加入对局",exact:true}).click();
  await expect(guest.getByRole("button",{name:"准备开局",exact:true})).toBeVisible();
  await guest.getByRole("button",{name:"准备开局",exact:true}).click();
  await expect(guest.getByText("你已准备好，等待对方。",{exact:true})).toBeVisible();
  // Background tabs pause practice polling; observe each client after activating it.
  await page.bringToFront();
  await expect(page.locator(".af-seat").filter({hasText:"好友 Agent"})).toContainText("已准备");
  await page.getByRole("button",{name:"取消对局",exact:true}).click();
  await expect(page.locator(".af-outcome")).toContainText("对局在开局前取消，不计胜负");
  await guest.bringToFront();
  await expect(guest.locator(".af-outcome")).toContainText("对局在开局前取消，不计胜负");
  await guestContext.close();
});

test("unknown create response retries the exact request instead of opening twice", async ({ page }) => {
  let commandId="";let createdId="";let first=true;let matched=0;
  await page.route("**/api/arena/play",async route=>{
    if(route.request().method() !== "POST")return route.continue();
    const command=route.request().postDataJSON();if(command.op !== "create")return route.continue();
    if(!commandId)commandId=command.requestId;else expect(command.requestId).toBe(commandId);
    matched++;
    if(first){first=false;const accepted=await route.fetch();createdId=(await accepted.json()).match.id;await route.abort("failed");}else await route.continue();
  });
  await page.goto("/arena?game=gomoku&mode=challenge");await page.getByRole("button",{name:"开始练习",exact:true}).click();
  await expect(page.getByRole("button",{name:"重试同一请求",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"开始练习",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"重试同一请求",exact:true}).click();
  await expect(page.getByRole("button",{name:"准备开局",exact:true})).toBeVisible();expect(matched).toBe(2);expect(new URL(page.url()).searchParams.get("matchId")).toBe(createdId);
  await page.getByRole("button",{name:"取消对局",exact:true}).click();
});


test("GameFi embeds the real report, Monad award, payment and cash without paid actions", async ({ page }, testInfo) => {
  await page.goto("/arena");
  await page.getByText("查看已有比赛的完整回放与资金证据", { exact: true }).click();
  const snapshot: HoldemSnapshot = await (await page.request.get("/api/holdem")).json();
  expect(snapshot.source).toBe("report"); expect(snapshot.report?.strategy).toBe("real-model");
  const report=snapshot.report!,delivery=snapshot.delivery!,purchase=snapshot.purchase!;
  expect(delivery.matchId).toBe(report.matchId);expect(purchase.matchId).toBe(report.matchId);
  await expect(page.getByRole("heading",{name:"真实模型德州 · 最新对局",exact:true})).toBeVisible();
  await expect(page.locator(".af-gamefi-match-id")).toContainText(report.matchId);
  const facts=page.locator(".af-gamefi-facts");
  await expect(facts).toContainText(`${amount(delivery.rewardRaw,delivery.decimals)} TEST USDC`);
  await expect(facts).toContainText(`${amount(purchase.verification.totalPaidRaw!,6)} TEST USDC`);
  await expect(facts).toContainText(`${amount(purchase.after!.cash[0],6)} TEST USDC / ${amount(purchase.after!.cash[1],6)} TEST USDC`);
  await expect(page.locator(".af-gamefi-status").getByText("按实际用量消费",{exact:true})).toBeVisible();
  await expect(page.locator(".holdem-monad")).toContainText("Monad Agent #1999");
  await expect(page.locator(".holdem-monad")).toContainText("奖后推理已完成");
  await expect(page.locator(".holdem-funding")).toHaveCount(0);
  await expect(page.getByRole("button",{name:/连接钱包|领奖|购买推理|付款|结算|开始比赛/})).toHaveCount(0);
  await page.getByRole("button",{name:"查看终局",exact:true}).click();
  await expect(page.getByTestId("holdem-stack-1")).toHaveText(report.game.result!.finalStacks[1].toLocaleString("en-US"));
  await page.locator(".holdem-monad").getByText("已记录付款交易",{exact:false}).click();
  await expect(page.locator(".holdem-monad .holdem-tx[open]")).toContainText(purchase.purchases[0].receipt!.txHash);
  await noOverflow(page);await screenshot(page,"gamefi-terminal",testInfo.project.name);
  await page.getByRole("button",{name:"刷新德州报告",exact:true}).click();
  await expect(page.getByRole("button",{name:"刷新德州报告",exact:true})).toBeEnabled();
  await expect(page.locator(".holdem-current")).toContainText("第 1 步");
  await page.goto("/arena/holdem");
  await expect(page.getByRole("heading",{name:"德州 Arena",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"奖励到账，再购买推理",exact:true})).toBeVisible();
});

test("GameFi refresh errors preserve snapshot, fixture has no reward balance, unknown purchase is paused", async ({ page }) => {
  await page.goto("/arena");
  await page.getByText("查看已有比赛的完整回放与资金证据", { exact: true }).click();
  const snapshot: HoldemSnapshot=await (await page.request.get("/api/holdem")).json();
  await page.route("**/api/holdem",route=>route.fulfill({status:503,json:{source:"report",report:null,loadedAt:new Date().toISOString(),error:{code:"HOLDEM_REPORT_UNAVAILABLE",message:"测试：公开报告不可用"}}}));
  await page.getByRole("button",{name:"刷新德州报告",exact:true}).click();
  await expect(page.locator(".read-error[role=alert]")).toContainText("保留上次成功快照");
  await expect(page.locator(".af-gamefi-match-id")).toContainText(snapshot.report!.matchId);
  await page.unroute("**/api/holdem");
  await page.route("**/api/holdem",route=>route.fulfill({json:{...snapshot,source:"fixture",delivery:undefined,purchase:undefined}}));
  await page.getByRole("button",{name:"刷新德州报告",exact:true}).click();
  await expect(page.locator(".af-gamefi-report")).toContainText("示例不作为 GameFi 数据");
  await expect(page.locator(".af-gamefi-facts")).toHaveCount(0);await expect(page.locator(".holdem-monad")).toHaveCount(0);
  await expect(page.locator(".holdem-card")).toHaveCount(0);
  await page.unroute("**/api/holdem");
  await page.route("**/api/holdem",route=>route.fulfill({json:{...snapshot,purchase:{...snapshot.purchase!,phase:"Stopped",after:undefined,purchases:snapshot.purchase!.purchases.map(item=>({...item,state:"Unknown",cashAfter:undefined,taskCompleted:false}))}}}));
  await page.getByRole("button",{name:"刷新德州报告",exact:true}).click();
  await expect(page.locator(".holdem-monad")).toContainText("推理结果未知 · 已暂停");
  await expect(page.locator(".holdem-monad").getByText("奖后推理已完成",{exact:true})).toHaveCount(0);
  await expect(page.locator(".af-gamefi-facts")).toContainText("已暂停");
  await expect(page.locator(".af-gamefi-facts")).toContainText("奖励入金 cash · 报告时");
  await noOverflow(page);
});
