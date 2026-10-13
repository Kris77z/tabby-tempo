import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PlayError, PlayStore } from "@agentfuel/arena/freeplay-store";
import { fixtureDashboard } from "../../lib/fixture";
import type { HoldemSnapshot } from "../../lib/holdem-types";
import type { PlayCommand } from "../../lib/play-types";

// Explicit synthetic acceptance. Browser APIs are fully intercepted; the only
// commands execute a fresh, test-local free-game engine, never an HTTP executor.
const snapshot: HoldemSnapshot = {
  source: "fixture", loadedAt: "2026-10-10T00:00:00.000Z",
  report: {
    matchId: "synthetic-terminal-replay", verified: true, phase: "Complete",
    network: "local-anvil", chainId: "31337", strategy: "scripted",
    game: {
      entryFee: "0", strategyInferenceCalls: 0, chips: { initialPerSeat: 1000, smallBlind: 5, bigBlind: 10 },
      steps: [
        { seat: 0, street: "preflop", action: { type: "call" }, board: [], stacks: [995, 990], pot: 15 },
        { seat: 1, street: "preflop", action: { type: "check" }, board: [], stacks: [990, 990], pot: 20 },
        { seat: 0, street: "river", action: { type: "check" }, board: ["4h", "7h", "8c", "3c", "7d"], stacks: [990, 990], pot: 20 },
      ],
      finalBoard: ["4h", "7h", "8c", "3c", "7d"],
      result: { reason: "showdown", winners: [0], contestedPot: 20, payouts: [20, 0], refunds: [0, 0], finalStacks: [1010, 990] },
    },
    reward: null, inference: null,
    evidence: { publicReplayVerified: true, chainEvidenceRecorded: false }, verification: {},
  },
};
type Read = { method: string; path: string };
const harnessByPage = new WeakMap<Page, Awaited<ReturnType<typeof isolatedFixture>>>();

async function isolatedFixture(page: Page) {
  const store = new PlayStore(() => Date.parse(snapshot.loadedAt));
  const errors: string[] = [], unexpected: string[] = [], walletCalls: string[] = [];
  const commands: PlayCommand[] = [], reads: Read[] = [];
  let holdemUnavailable = false;
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== "http://127.0.0.1:3015") unexpected.push(request.url());
  });
  await page.exposeFunction("__terminalWalletBlocked", (method: string) => { walletCalls.push(method); throw new Error("Synthetic acceptance blocks all wallet RPC."); });
  await page.addInitScript(() => {
    const scope = window as unknown as { __terminalWalletBlocked: (method: string) => Promise<never> };
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      request: ({ method }: { method: string }) => scope.__terminalWalletBlocked(method),
      on: () => {}, removeListener: () => {},
    } });
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    reads.push({ method, path: url.pathname });
    expect(url.origin).toBe("http://127.0.0.1:3015");
    const fulfill = (json: unknown, status = 200) => route.fulfill({ status, json, headers: { "cache-control": "no-store" } });
    if (url.pathname === "/api/arena/play") {
      const token = request.headers().authorization?.replace(/^Bearer /, "");
      try {
        if (method === "GET") return fulfill(url.searchParams.has("matchId") ? store.get(url.searchParams.get("matchId")!, token) : store.list());
        if (method === "POST") {
          const command = request.postDataJSON() as PlayCommand;
          expect(command.op).toMatch(/^(create|ready|action|resign|cancel)$/);
          commands.push(command);
          return fulfill(store.command(command, token));
        }
      } catch (error) {
        if (!(error instanceof PlayError)) throw error;
        return fulfill({ error: error.code, message: error.code, version: error.version }, error.status);
      }
    }
    if (method === "GET" && url.pathname === "/api/arena/gamefi") return fulfill({ enabled: false, rewardKinds: [], runs: [] });
    if (method === "GET" && url.pathname === "/api/arena/credits") return fulfill({ enabled: false });
    if (method === "GET" && url.pathname === "/api/dashboard") return fulfill(fixtureDashboard());
    if (method === "GET" && url.pathname === "/api/holdem") return fulfill(holdemUnavailable
      ? { source: "fixture", report: null, loadedAt: snapshot.loadedAt, error: { code: "HOLDEM_REPORT_UNAVAILABLE", message: "Synthetic report temporarily unavailable" } }
      : snapshot, holdemUnavailable ? 503 : 200);
    if (method === "GET" && url.pathname === "/api/hosted/agents") return fulfill({ error: "HOSTED_AUTH_REQUIRED" }, 401);
    unexpected.push(`${method} ${url.pathname}`);
    return fulfill({ error: "SYNTHETIC_API_BLOCKED" }, 503);
  });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:3015(?:\/|$))/, route => route.abort("blockedbyclient"));
  return { store, errors, unexpected, walletCalls, commands, reads, failHoldemRefresh: () => { holdemUnavailable = true; } };
}
test.beforeEach(async ({ page }) => { harnessByPage.set(page, await isolatedFixture(page)); });
test.afterEach(async ({ page }) => {
  const harness = harnessByPage.get(page)!;
  expect(harness.errors).toEqual([]);
  expect(harness.unexpected).toEqual([]);
  expect(harness.walletCalls).toEqual([]);
  expect(harness.reads.filter(read => read.method !== "GET").every(read => read.path === "/api/arena/play" && read.method === "POST")).toBe(true);
});

const firstFamily = (value: string) => value.split(",")[0].replace(/["']/g, "").trim();
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function terminalStructure(page: Page, panel: Locator) {
  const shell = page.getByTestId("terminal-page-shell"), header = page.getByTestId("terminal-page-header");
  const navigation = page.getByRole("navigation", { name: "页面导航", exact: true });
  await expect(shell).toBeVisible(); await expect(header).toBeVisible();
  await expect(header.getByTestId("terminal-page-dot")).toHaveCount(3);
  const source = await shell.evaluate(element => {
    const style = getComputedStyle(element);
    return { font: style.fontFamily, mono: style.getPropertyValue("--font-geist-mono").trim(), background: style.backgroundColor,
      tokens: Object.fromEntries(["background", "foreground", "primary", "accent", "border", "radius"].map(name => [name, style.getPropertyValue(`--${name}`).replace(/\s+/g, "")])) };
  });
  expect(source.background).toBe("rgb(244, 244, 245)");
  expect(source.tokens).toEqual({ background: "2405%96%", foreground: "2406%10%", primary: "26370%50%", accent: "26370%50%", border: "2406%85%", radius: "0px" });
  expect(source.mono).not.toBe(""); expect(firstFamily(source.font)).toBe(firstFamily(source.mono));
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map(face => ({ family: face.family, status: face.status })); });
  expect(fonts.some(face => firstFamily(face.family) === firstFamily(source.mono) && face.status === "loaded")).toBe(true);
  await expect(panel).toBeVisible();
  expect(await panel.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe("0px");
  const sizes = await shell.getByRole("heading").evaluateAll(elements => elements.map(element => Number.parseFloat(getComputedStyle(element).fontSize)));
  expect(sizes.every(size => size <= 24)).toBe(true);
  for (const path of ["/", "/dashboard", "/arena", "/advanced"]) {
    await expect(navigation.locator(`a[href="${path}"]`)).toBeVisible();
  }
  await expect(navigation.locator('a[href="/arena/holdem"]')).toHaveCount(0);
  await noOverflow(page);
}
async function capture(page: Page, name: string, info: TestInfo) {
  const directory = resolve(info.project.testDir, "../../acceptance/terminal-pages");
  await mkdir(directory, { recursive: true });
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.querySelectorAll<HTMLElement>('[data-testid="terminal-page-shell"], [data-testid="terminal-page-shell"] *')
      .forEach(element => { element.scrollTop = 0; });
    window.scrollTo(0, 0);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await page.screenshot({ path: resolve(directory, `synthetic-${name}-${info.project.name}.png`), fullPage: true,
    scale: "css", style: "nextjs-portal { display: none !important }" });
}
async function start(page: Page, game: string) {
  await page.goto(`/arena?game=${game}&mode=challenge`);
  await page.getByRole("button", { name: "开始练习", exact: true }).click();
  await page.getByRole("button", { name: "准备开局", exact: true }).click();
  await expect(page.getByText("正在对局", { exact: true })).toBeVisible();
}

test("terminal lobby keeps safe practice entries and navigation through the shared pages", async ({ page }, info) => {
  const harness = harnessByPage.get(page)!;
  await page.goto("/arena");
  await expect(page.getByRole("heading", { name: "游戏大厅", exact: true })).toBeVisible();
  for (const game of ["扑克", "五子棋", "国际象棋", "小丑牌"]) await expect(page.getByRole("link", { name: `进入策略练习${game}对局`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "发起真实德州比赛", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "使用额度调用 Kimi", exact: true })).toBeDisabled();
  await terminalStructure(page, page.locator(".af-game-card").first());
  const loadedCovers = await page.locator(".af-game-card img").evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
  expect(loadedCovers).toBe(true);
  await capture(page, "arena-lobby", info);
  await page.getByRole("navigation", { name: "页面导航", exact: true }).locator('a[href="/advanced"]').click();
  await expect(page).toHaveURL(/\/advanced$/);
  await expect(page.getByRole("heading", { name: /Atlas\s*#1842/ })).toBeVisible();
  await expect(page.getByText("本地演示 · FIXTURE", { exact: true })).toBeVisible();
  await page.getByText("历史演示与证据", { exact: true }).click();
  await page.getByRole("link", { name: "德州历史回放与奖励凭证 →", exact: true }).click();
  await expect(page).toHaveURL(/\/arena\/holdem$/);
  await expect(page.getByRole("heading", { name: "德州 Arena", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "页面导航", exact: true }).locator('a[href="/dashboard"]').click();
  // This is the suite's first visit to the relocated route; Next dev compiles it on demand.
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
  expect(harness.commands).toEqual([]);
});

test("terminal poker practice folds one hand and preserves the fixture seat on refresh", async ({ page }, info) => {
  await page.goto("/arena?game=poker&mode=challenge");
  await page.getByLabel("最多手数").selectOption("1");
  await page.getByRole("button", { name: "开始练习", exact: true }).click();
  await page.getByRole("button", { name: "准备开局", exact: true }).click();
  await page.getByRole("button", { name: "弃牌", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "练习对局已结算" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "每手结果", exact: true })).toBeVisible();
  const url = page.url(); await page.reload(); expect(page.url()).toBe(url);
  await expect(page.getByRole("heading", { name: "每手结果", exact: true })).toBeVisible();
  await page.getByText("Agent 接入 · 复制提示词", { exact: true }).click();
  await expect(page.getByLabel("Agent 接入提示词")).toHaveValue(/Authorization: Bearer/);
  await page.getByText("Agent 接入 · 复制提示词", { exact: true }).click();
  await terminalStructure(page, page.locator(".af-game-panel"));
  await capture(page, "arena-poker", info);
  expect(harnessByPage.get(page)!.commands.map(command => command.op)).toEqual(["create", "ready", "action"]);
});

test("terminal gomoku practice places a stone and keeps the reply inside the mobile board", async ({ page }, info) => {
  await start(page, "gomoku");
  await page.getByRole("button", { name: "H8, 空位", exact: true }).click();
  await expect(page.getByRole("button", { name: "H8, 黑子", exact: true })).toBeVisible();
  await expect(page.locator(".af-gomoku-stone:not([hidden])")).toHaveCount(2);
  await page.getByRole("tab", { name: "你的 Agent", exact: true }).click();
  await expect(page.locator(".af-log-list")).toContainText("place");
  await terminalStructure(page, page.locator(".af-game-panel"));
  const board = (await page.locator(".af-gomoku-board").boundingBox())!;
  expect(board.x).toBeGreaterThanOrEqual(0); expect(board.x + board.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await capture(page, "arena-gomoku", info);
  const command = harnessByPage.get(page)!.commands.at(-1)!;
  expect(command.op === "action" && command.action).toEqual({ type: "place", row: 7, col: 7 });
});

test("terminal chess practice exposes legal squares and applies e2 to e4 with a bot reply", async ({ page }, info) => {
  await start(page, "chess");
  await page.getByRole("button", { name: "e2 白兵", exact: true }).click();
  await expect(page.getByRole("button", { name: "e4 空位 可移动", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "e4 空位 可移动", exact: true }).click();
  await expect(page.getByRole("button", { name: "e4 白兵", exact: true })).toBeVisible();
  await expect(page.locator(".af-board-note")).toContainText("已行 2 步");
  await terminalStructure(page, page.locator(".af-game-panel"));
  const board = (await page.locator(".af-chess-board").boundingBox())!;
  expect(board.x).toBeGreaterThanOrEqual(0); expect(board.x + board.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await capture(page, "arena-chess", info);
  const command = harnessByPage.get(page)!.commands.at(-1)!;
  expect(command.op === "action" && command.action).toEqual({ type: "move", from: "e2", to: "e4" });
});

test("terminal balatro practice selects cards, discards and scores without a paid action", async ({ page }, info) => {
  await start(page, "balatro");
  await expect(page.getByRole("checkbox")).toHaveCount(8);
  await page.getByRole("checkbox").nth(0).click(); await page.getByRole("checkbox").nth(1).click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await page.getByRole("button", { name: "弃牌", exact: true }).click();
  await expect(page.locator(".af-balatro-stats")).toContainText("剩余弃牌2");
  await page.getByRole("checkbox").nth(0).click(); await page.getByRole("checkbox").nth(1).click(); await page.getByRole("checkbox").nth(2).click();
  await page.getByRole("button", { name: "出牌", exact: true }).click();
  await expect(page.locator(".af-score")).toBeVisible();
  await expect(page.locator(".af-balatro-stats")).toContainText("剩余出牌3");
  await terminalStructure(page, page.locator(".af-game-panel"));
  await capture(page, "arena-balatro", info);
  const actions = harnessByPage.get(page)!.commands.filter(command => command.op === "action").map(command => command.action);
  expect(actions).toEqual([{ type: "discard", cards: expect.arrayContaining([expect.any(String), expect.any(String)]) },
    { type: "play", cards: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)]) }]);
});

test("terminal holdem fixture replay remains read-only and a failed refresh preserves its last evidence", async ({ page }, info) => {
  const harness = harnessByPage.get(page)!;
  await page.goto("/arena/holdem");
  await page.getByRole("button", { name: "刷新德州报告", exact: true }).click();
  await expect(page.locator(".holdem-match")).toHaveText(snapshot.report!.matchId);
  await expect(page.getByText("本地演示 · FIXTURE", { exact: true })).toBeVisible();
  await expect(page.getByTestId("holdem-pot")).toContainText("15");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByTestId("holdem-pot")).toContainText("20");
  await page.getByRole("button", { name: "查看终局", exact: true }).click();
  await expect(page.getByTestId("holdem-stack-0")).toHaveText("1,010");
  await expect(page.locator(".holdem-current")).toContainText("座位 1 获胜");
  await expect(page.getByRole("button", { name: /连接钱包|购买推理|付款|结算|开始比赛/ })).toHaveCount(0);
  await terminalStructure(page, page.locator(".holdem-replay"));
  await capture(page, "holdem-replay", info);
  harness.failHoldemRefresh();
  await page.getByRole("button", { name: "刷新德州报告", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Synthetic report temporarily unavailable" })).toContainText("保留上次成功快照");
  await expect(page.locator(".holdem-match")).toHaveText(snapshot.report!.matchId);
  await expect(page.getByTestId("holdem-stack-0")).toHaveText("1,010");
  expect(harness.commands).toEqual([]);
  await noOverflow(page);
});

test("terminal advanced fixture switches financial identity and expands evidence while broadcasts stay disabled", async ({ page }, info) => {
  const harness = harnessByPage.get(page)!;
  await page.goto("/advanced");
  await expect(page.getByRole("button", { name: "连接钱包", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: /Atlas\s*#1842/ })).toBeVisible();
  await page.getByRole("button", { name: /Helix.*Score 710/ }).click();
  await expect(page.locator(".score-number")).toContainText("710");
  const evidence = page.locator(".ledger-row").first();
  await expect(evidence.locator(".ledger-main")).toContainText("cash 0.04 + credit 0.08 USDC");
  await evidence.locator("summary").click();
  await expect(evidence.getByText("Transaction receipt", { exact: true })).toBeVisible();
  await expect(evidence.getByText("evidenceHash", { exact: true })).toBeVisible();
  await terminalStructure(page, page.locator(".ledger-row").first());
  await capture(page, "advanced-profile", info);
  await page.getByRole("button", { name: /Delta.*Score 170/ }).click();
  await expect(page.getByText("identityChanged · 身份变更", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button", { name: /演示面板/ }).click();
  await page.getByRole("button", { name: "查看 fixture 拒绝样例", exact: true }).click();
  await expect(page.getByText("SpendRejected", { exact: true })).toBeVisible();
  await expect(page.getByText("本地 fixture 错误样例；未请求 RPC。", { exact: true })).toBeVisible();
  expect(harness.commands).toEqual([]);
  await noOverflow(page);
});
