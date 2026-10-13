import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const failures = new WeakMap<Page, { errors: string[]; resources: string[]; external: string[]; writes: string[] }>();
test.beforeEach(async ({ page }) => {
  const evidence = { errors: [] as string[], resources: [] as string[], external: [] as string[], writes: [] as string[] };
  failures.set(page, evidence);
  page.on("pageerror", error => evidence.errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith("/api/")) evidence.resources.push(`${response.status()} ${response.url()}`); });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.protocol.startsWith("http") && url.origin !== new URL(test.info().project.use.baseURL!).origin) evidence.external.push(request.url());
    if (request.method() !== "GET" && url.pathname.startsWith("/api/")) evidence.writes.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { error: "HOSTED_NOT_CONFIGURED" }, headers: { "cache-control": "no-store" } }));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.protocol.startsWith("http") && url.origin !== new URL(test.info().project.use.baseURL!).origin ? route.abort("blockedbyclient") : route.fallback();
  });
});
test.afterEach(async ({ page }) => {
  expect(failures.get(page)).toEqual({ errors: [], resources: [], external: [], writes: [] });
});

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("Oberon landing loads local fonts/assets and stays readable across viewport sizes", async ({ page }, info) => {
  await page.goto("/?lang=zh");
  await expect(page.getByTestId("oberon-landing")).toBeVisible();
  const headline = page.getByRole("heading", { level: 1 });
  await expect(headline).toHaveText("让你的 Agent拥有信用，持续执行。");
  const creationLinks = page.getByRole("link", { name: "创建你的 AGENT", exact: true });
  await expect(creationLinks).toHaveCount(2);
  for (let index = 0; index < 2; index++) await expect(creationLinks.nth(index)).toHaveAttribute("href", "/onboarding");
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map(font => ({ family: font.family, status: font.status })); });
  expect(fonts.filter(font => font.status === "loaded").length).toBeGreaterThanOrEqual(2);
  await noOverflow(page);
  const headlineBox = await headline.boundingBox();
  expect(headlineBox).not.toBeNull();
  expect(headlineBox!.x + headlineBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const fontSize = await headline.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(headlineBox!.height).toBeLessThanOrEqual(fontSize * 3.1);
  const chipBox = (await page.getByTestId("landing-chip").boundingBox())!;
  expect(headlineBox!.x + headlineBox!.width <= chipBox.x || headlineBox!.y + headlineBox!.height <= chipBox.y || chipBox.y + chipBox.height <= headlineBox!.y).toBe(true);
  const headerAction = (await page.getByRole("link", { name: "进入工作台", exact: true }).first().boundingBox())!;
  expect(headerAction.x + headerAction.width).toBeLessThanOrEqual(page.viewportSize()!.width - 20);
  // All supported sections and their real destinations remain visible after scroll.
  for (const id of ["capabilities", "how-it-works", "reputation", "credit", "arena", "system", "faq"]) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await noOverflow(page);
    await expect(page.locator(`#${id}`).getByRole("heading").first()).toBeVisible();
  }
  await expect(page.getByText("目标网络为 Tempo Moderato Testnet，使用测试 PathUSD；迁移后独立验收进行中。", { exact: false })).toBeVisible();
  await page.locator("#start").scrollIntoViewIfNeeded();
  await expect(page.getByRole("navigation", { name: "页尾导航" }).getByRole("link", { name: "托管工作台", exact: false })).toHaveAttribute("href", "/dashboard");
  await page.evaluate(() => scrollTo(0, 0));
  await expect(headline).toBeVisible();
  const directory = resolve(process.env.LANDING_ACCEPTANCE_DIR ?? "acceptance/landing");
  await mkdir(directory, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: resolve(directory, `local-oberon-${info.project.name}.png`), animations: "disabled" });
  if (info.project.name !== "narrow") await page.screenshot({ path: resolve(directory, `local-oberon-full-${info.project.name}.png`), fullPage: true, animations: "disabled" });
});

test("Oberon scenarios switch content and destinations with keyboard without creating operations", async ({ page }) => {
  await page.goto("/?lang=zh");
  const story = page.getByRole("region", { name: "Agent 运行场景" });
  await story.scrollIntoViewIfNeeded();
  await expect(story.getByRole("button", { name: "上一个场景" })).toBeDisabled();
  await expect(story.getByRole("link", { name: "查看协议与结算证据" })).toHaveAttribute("href", "/advanced");
  await expect(story.locator("canvas")).toHaveAttribute("data-ready", "true");
  const next = story.getByRole("button", { name: "下一个场景" });
  await next.focus(); await page.keyboard.press("Enter");
  await expect(story.getByRole("heading", { level: 3 })).toContainText("赢得奖励");
  await expect(story.getByRole("link", { name: "用托管 AGENT 参赛" })).toHaveAttribute("href", "/dashboard");
  await next.focus(); await page.keyboard.press("Enter");
  await expect(story.getByRole("heading", { level: 3 })).toContainText("留下信誉");
  await expect(next).toBeDisabled();
  await story.getByRole("button", { name: "上一个场景" }).click();
  await expect(story.getByRole("heading", { level: 3 })).toContainText("赢得奖励");
  await noOverflow(page);
});

test("landing menu anchors, Escape and FAQ work without transactions", async ({ page }) => {
  await page.goto("/?lang=zh");
  await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "首页导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "首页导航" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "打开导航菜单", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
  await page.getByRole("navigation", { name: "首页导航" }).getByRole("link", { name: "运行方式", exact: false }).click();
  await expect(page).toHaveURL(/\/\?lang=zh#how-it-works$/);
  await expect(page.getByRole("navigation", { name: "首页导航" })).toHaveCount(0);
  await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
  await page.getByRole("navigation", { name: "首页导航" }).getByRole("link", { name: "常见问题", exact: false }).click();
  const question = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "免费德州会使用信用借款吗？" }) });
  await question.locator("summary").click();
  await expect(question).toHaveAttribute("open", "");
  await expect(question.getByText("不会。游戏免费、不借贷。", { exact: false })).toBeVisible();
  await question.locator("summary").click();
  await expect(question).not.toHaveAttribute("open", "");
  await noOverflow(page);
});

test("primary CTA opens onboarding and workbench keeps its own route", async ({ page }) => {
  await page.goto("/?lang=zh");
  await page.getByRole("link", { name: "创建你的 AGENT", exact: true }).first().click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId("onboarding-terminal-shell")).toBeVisible();
  await page.getByRole("link", { name: "进入工作台 →", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByTestId("hosted-terminal-shell")).toBeVisible();
  await expect(page.getByRole("button", { name: "签名登录", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回 AgentFuel 产品首页", exact: true }).click();
  await expect(page).toHaveURL(`${test.info().project.use.baseURL}/`);
  await expect(page.getByTestId("oberon-landing")).toBeVisible();
  await noOverflow(page);
});

test("landing defaults to English and language links preserve the chapter on refresh", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("oberon-landing")).toHaveAttribute("lang", "en");
  await expect(page).toHaveTitle("Tabby · Credit to keep your Agent working");
  await expect(page.getByRole("link", { name: "CREATE YOUR AGENT", exact: true })).toHaveCount(2);
  const visibleChinese = await page.locator("body").innerText();
  expect(visibleChinese.match(/[\u4e00-\u9fff]+/g)).toEqual(["中文"]);
  await page.getByRole("button", { name: "Open navigation menu", exact: true }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "In action", exact: false }).click();
  const story = page.getByRole("region", { name: "Agent use cases" });
  await expect(story.locator("img")).toHaveAttribute("src", "/landing/agent-execution.png");
  await story.getByRole("button", { name: "Next scenario", exact: true }).click();
  await expect(story.locator("img")).toHaveAttribute("src", "/landing/agent-rewards.png");
  await story.getByRole("button", { name: "Next scenario", exact: true }).click();
  await expect(story.locator("img")).toHaveAttribute("src", "/landing/agent-reputation.png");
  await expect(story.getByRole("link", { name: "VIEW REPUTATION & LEDGER", exact: true })).toHaveAttribute("href", "/dashboard");
  await noOverflow(page);
  await page.getByRole("navigation", { name: "Language", exact: true }).getByRole("link", { name: "中文", exact: true }).click();
  await expect(page).toHaveURL(/\?lang=zh#credit$/);
  await page.reload();
  await expect(page.getByTestId("oberon-landing")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("region", { name: "Agent 运行场景" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent 的运行场景。" })).toBeVisible();
  await noOverflow(page);
  await page.getByRole("navigation", { name: "语言", exact: true }).getByRole("link", { name: "EN", exact: true }).click();
  await expect(page).toHaveURL(/\?lang=en#credit$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("region", { name: "Agent use cases" })).toBeVisible();
  await page.goto("/?lang=unsupported");
  await expect(page.getByTestId("oberon-landing")).toHaveAttribute("lang", "en");
  await noOverflow(page);
});
