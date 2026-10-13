import { test, expect, type Page } from "@playwright/test";

interface MotionFrame {
  time: number; first: number; last: number; outer: number; inner: number;
  topOpacity: number; topY: number; rightOpacity: number; rightX: number;
  bottomOpacity: number; bottomY: number; lines: number[]; filesX: number; waveX: number; waveOpacity: number;
}
declare global { interface Window { __landingFrames: MotionFrame[]; } }

const origin = new URL(process.env.LANDING_MOTION_BASE_URL || "http://127.0.0.1:3026").origin;
const outsideOrigin = (url: URL) => url.protocol.startsWith("http") && url.origin !== origin;

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const issues: string[] = []; errors.set(page, issues);
  page.on("pageerror", error => issues.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() !== "GET" && url.pathname.startsWith("/api/")) issues.push(`Unexpected write ${request.method()} ${url.pathname}`);
    if (url.protocol.startsWith("http") && url.origin !== origin) issues.push(`External resource ${url.origin}`);
  });
  page.on("response", response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith("/api/")) issues.push(`Missing resource ${response.status()} ${response.url()}`); });
  await page.route("**/api/**", route => route.fulfill({ status: 503, json: { error: "HOSTED_NOT_CONFIGURED" } }));
  await page.route(outsideOrigin, route => route.abort("blockedbyclient"));
  await page.addInitScript(() => {
    window.__landingFrames = [];
    let started: number | undefined;
    const matrix = (element: Element, pseudo?: string) => new DOMMatrixReadOnly(getComputedStyle(element, pseudo).transform);
    const frame = (timestamp: number) => {
      const chars = document.querySelectorAll("[data-entry-character]");
      const chip = document.querySelector('[data-testid="landing-chip"]');
      const top = document.querySelector('[data-entry-node="top"]');
      const right = document.querySelector('[data-entry-node="right"]');
      const bottom = document.querySelector('[data-entry-node="bottom"]');
      const files = document.querySelector("[data-entry-files]");
      const wave = document.querySelector('[aria-hidden="true"][class*="heroWave"]');
      if (chars.length && chip && top && right && bottom && files && wave) {
        started ??= timestamp;
        window.__landingFrames.push({
          time: timestamp - started,
          first: Number(getComputedStyle(chars[0]).opacity), last: Number(getComputedStyle(chars[chars.length - 1]).opacity),
          outer: matrix(chip, "::before").a, inner: matrix(chip.firstElementChild!).a,
          topOpacity: Number(getComputedStyle(top).opacity), topY: matrix(top).f,
          rightOpacity: Number(getComputedStyle(right).opacity), rightX: matrix(right).e,
          bottomOpacity: Number(getComputedStyle(bottom).opacity), bottomY: matrix(bottom).f,
          lines: [...document.querySelectorAll('[class*="circuitLine"],[class*="circuitVertical"]')].map(line => Number(getComputedStyle(line).opacity)),
          filesX: matrix(files).e, waveX: Number.parseFloat(getComputedStyle(wave).backgroundPositionX), waveOpacity: Number(getComputedStyle(wave).opacity),
        });
      }
      if (started === undefined || timestamp - started < 3300) requestAnimationFrame(frame);
    }; requestAnimationFrame(frame);
  });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

function complete(frame: MotionFrame) {
  expect(frame.first).toBe(1); expect(frame.last).toBe(1);
  expect(frame.outer).toBeCloseTo(1, 3); expect(frame.inner).toBeCloseTo(1, 3); expect(frame.filesX).toBeCloseTo(0, 2);
  expect(frame.topOpacity).toBe(1); expect(frame.bottomOpacity).toBe(1);
  expect(frame.topY).toBeCloseTo(0, 2); expect(frame.bottomY).toBeCloseTo(0, 2);
  expect(frame.lines).toEqual([1, 1]);
}
function sequence(frames: MotionFrame[], desktop: boolean) {
  // Actual first-paint samples catch a final-title flash before hydration.
  expect(frames[0].first).toBeLessThan(.02); expect(frames[0].last).toBeLessThan(.02);
  expect(frames.some(frame => frame.first > .99 && frame.last < .02)).toBe(true);
  const collapsed = frames.findIndex(frame => frame.outer < .3 && frame.inner < .3 && frame.topOpacity === 0 && frame.bottomOpacity === 0 && frame.lines.every(opacity => opacity === 0));
  expect(collapsed).toBeGreaterThan(0);
  const outerUnfolds = frames.findIndex((frame, i) => i > collapsed && frame.outer > .6 && frame.inner < .3);
  expect(outerUnfolds).toBeGreaterThan(collapsed);
  const topEmerges = frames.findIndex((frame, i) => i > outerUnfolds && frame.topOpacity === 1 && frame.topY > 100);
  const topFlies = frames.findIndex((frame, i) => i > topEmerges && frame.topOpacity === 1 && frame.topY > 10 && frame.topY < 100);
  const bottomEmerges = frames.findIndex((frame, i) => i > topFlies && frame.bottomOpacity === 1 && frame.bottomY < -100);
  expect(topEmerges).toBeGreaterThan(outerUnfolds); expect(topFlies).toBeGreaterThan(topEmerges); expect(bottomEmerges).toBeGreaterThan(topFlies);
  if (desktop) {
    expect(frames.some(frame => frame.rightOpacity === 1 && frame.rightX < -100)).toBe(true);
    expect(frames.some(frame => frame.rightOpacity === 1 && frame.rightX > -100 && frame.rightX < -10)).toBe(true);
    expect(frames.at(-1)!.rightOpacity).toBe(1); expect(frames.at(-1)!.rightX).toBeCloseTo(0, 2);
  }
  // A busy browser can skip the short first file step; any rendered negative offset
  // followed by the settled zero still proves clipped entry rather than a static final frame.
  expect(frames.some(frame => frame.filesX < -1)).toBe(true);
  expect(frames.every(frame => frame.waveOpacity > 0)).toBe(true);
  const from = frames.find(frame => frame.time >= 1500)!; const to = frames.find(frame => frame.time >= 2000)!;
  const speed = (from.waveX - to.waveX) / ((to.time - from.time) / 1000);
  expect(speed).toBeGreaterThan(27); expect(speed).toBeLessThan(33);
  complete(frames.at(-1)!);
}

test("first visit and refresh render intermediate text, chip and file states before settling", async ({ page }, info) => {
  for (const reload of [false, true]) {
    if (reload) await page.reload({ waitUntil: "commit" }); else await page.goto("/", { waitUntil: "commit" });
    await page.waitForFunction(() => (window.__landingFrames?.at(-1)?.time ?? 0) >= 3050);
    const frames = await page.evaluate(() => window.__landingFrames);
    await info.attach(reload ? "refresh-rendered-motion" : "first-visit-rendered-motion", { body: JSON.stringify(frames, null, 2), contentType: "application/json" });
    sequence(frames, info.project.name === "desktop");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const metrics = await page.getByRole("heading", { level: 1 }).evaluate(element => ({ height: element.getBoundingClientRect().height, size: Number.parseFloat(getComputedStyle(element).fontSize) }));
  expect(metrics.height).toBeLessThanOrEqual(metrics.size * 3.1);
  // Entry is one-shot and independent of scroll reveal.
  await page.locator("#capabilities").scrollIntoViewIfNeeded(); await page.evaluate(() => scrollTo(0, 0));
  const state = await page.evaluate(() => ({ opacity: getComputedStyle(document.querySelector("[data-entry-character]")!).opacity, chip: new DOMMatrixReadOnly(getComputedStyle(document.querySelector('[data-testid="landing-chip"]')!, "::before").transform).a }));
  expect(state).toEqual({ opacity: "1", chip: 1 });
});

test("reduced motion immediately renders the final composition on first visit and refresh", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const reload of [false, true]) {
    if (reload) await page.reload(); else await page.goto("/");
    await page.waitForFunction(() => window.__landingFrames.length >= 10);
    const frames = await page.evaluate(() => window.__landingFrames);
    frames.forEach(complete);
    expect(new Set(frames.map(frame => frame.waveX)).size).toBe(1);
    expect(await page.evaluate(() => document.querySelector('[data-testid="oberon-landing"]')!.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  }
});

test("chapter text resolves and module motion stops offscreen and under reduced motion", async ({ page }) => {
  await page.goto("/");
  const diagram = page.locator("#system [data-landing-active]");
  const title = page.locator("#system [data-section-text]");
  await title.scrollIntoViewIfNeeded();
  await expect.poll(() => title.locator("[data-section-character]").last().evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
  await diagram.scrollIntoViewIfNeeded();
  const motion = await diagram.evaluate(async element => {
    const frames: string[] = [];
    const started = performance.now();
    await new Promise<void>(resolve => {
      function sample() {
        const particle = element.querySelector("svg>g>g")!;
        frames.push(getComputedStyle(particle).transform);
        if (performance.now() - started < 650) requestAnimationFrame(sample); else resolve();
      }
      requestAnimationFrame(sample);
    });
    return new Set(frames).size;
  });
  expect(motion).toBeGreaterThan(3);
  await page.locator("#faq").scrollIntoViewIfNeeded();
  await expect.poll(() => diagram.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await diagram.scrollIntoViewIfNeeded();
  expect(await diagram.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running").length)).toBe(0);
  expect(await title.locator("[data-section-character]").last().evaluate(element => Number(getComputedStyle(element).opacity))).toBe(1);
});

test("without JavaScript the composition and primary action remain readable", async ({ browser }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport }); const page = await context.newPage();
  await page.route(outsideOrigin, route => route.abort("blockedbyclient"));
  await page.goto(`${origin}/`);
  await expect(page.getByRole("heading", { name: "Give your Agent the credit to keep working.", exact: true })).toBeVisible();
  const state = await page.evaluate(() => ({
    characters: [...document.querySelectorAll("[data-entry-character]")].map(element => getComputedStyle(element).opacity),
    outer: new DOMMatrixReadOnly(getComputedStyle(document.querySelector('[data-testid="landing-chip"]')!, "::before").transform).a,
    files: new DOMMatrixReadOnly(getComputedStyle(document.querySelector("[data-entry-files]")!).transform).e,
    animations: document.querySelector('[data-testid="oberon-landing"]')!.getAnimations({ subtree: true }).length,
    noOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
  }));
  expect(state.characters.every(opacity => opacity === "1")).toBe(true);
  expect(state).toMatchObject({ outer: 1, files: 0, animations: 0, noOverflow: true });
  await expect(page.getByRole("link", { name: "CREATE YOUR AGENT", exact: true }).first()).toBeVisible();
  await expect(page.locator("#landing-main p")).toHaveText("Let reputation and task rewards fund inference.Create a hosted Agent. Work autonomously.Earn income. Build reputation.");
  await context.close();
});
