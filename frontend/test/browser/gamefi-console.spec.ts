import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { GameFiRun, GameFiSnapshot, GameFiCommand } from "../../lib/gamefi-types";
import type { CreditSnapshot, RewardBalance, RewardRedemption, RewardIdentity } from "../../lib/credit-types";

// Every start/recover/redeem API is intercepted before navigation. No test can launch a
// provider call or submit an award transaction through the configured development server.
const fixed: RewardIdentity = { agentId: "1999", wallet: `0x${"3".repeat(40)}` };
const requestId = "11111111-1111-4111-8111-111111111111";
const redemptionId = "22222222-2222-4222-8222-222222222222";
const time = "2026-10-05T00:00:00.000Z";
const run = (values: Partial<GameFiRun> = {}): GameFiRun => ({ requestId, rewardKind: "usdc", status: "Running", stage: "game", createdAt: time, updatedAt: time, recoverable: false, ...values });
const game = (value?: GameFiRun): GameFiSnapshot => ({ enabled: true, rewardKinds: ["usdc", "llm-credits"], ...(value ? { run: value, runs: [value] } : { runs: [] }) });
const balance = (values: Partial<RewardBalance> = {}): RewardBalance => ({ identity: fixed, model: "kimi-k2.6", grantedTokens: 10000, consumedTokens: 0, reservedTokens: 0, availableTokens: 10000, deficitTokens: 0, blocked: false, ...values });
const redemption = (id: string, values: Partial<RewardRedemption> = {}): RewardRedemption => ({ redemptionId: id, identity: fixed, model: "kimi-k2.6", requestDigest: "a".repeat(64), reservedTokens: 512, status: "OutcomeUnknown", createdAt: time, updatedAt: time, ...values });
const credits = (values: Partial<CreditSnapshot> = {}): CreditSnapshot => ({ enabled: true, identity: fixed, balance: balance(), ...values });
const consolePanel = (page: Page) => page.getByRole("region", { name: "真实比赛与推理额度" });
async function capture(page: Page, name: string, project: string) {
  const directory=resolve("acceptance/gamefi-console");await mkdir(directory,{recursive:true});
  await consolePanel(page).screenshot({path:`${directory}/${name}-${project}.png`,scale:"css",style:"nextjs-portal { display: none !important }"});
}
async function layout(page: Page) { expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true); }
const fatal: string[]=[];
test.beforeEach(async({page})=>{fatal.length=0;page.on("pageerror",error=>fatal.push(error.message));});
test.afterEach(()=>{expect(fatal).toEqual([]);});

// Per-test handlers deliberately have no route.continue/fetch for these paid API paths.
test("unconfigured services disable paid starts and redemption",async({page},info)=>{
  const posts: string[]=[];
  await page.addInitScript(({id})=>localStorage.setItem("agentfuel:gamefi:pending",JSON.stringify({action:"start",requestId:id,rewardKind:"usdc"})),{id:requestId});
  await page.route("**/api/arena/gamefi*",route=>{if(route.request().method()==="POST")posts.push("gamefi");return route.fulfill({json:{enabled:false,rewardKinds:[],runs:[]}});});
  await page.route("**/api/arena/credits*",route=>{if(route.request().method()==="POST")posts.push("credits");return route.fulfill({json:{enabled:false}});});
  await page.goto("/arena");
  await expect(page.getByRole("button",{name:"发起真实德州比赛",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"使用额度调用 Kimi",exact:true})).toBeDisabled();
  await expect(page.getByRole("button",{name:"重试原比赛请求",exact:true})).toBeDisabled();
  await expect(consolePanel(page)).toContainText("比赛服务尚未启用");
  await expect(consolePanel(page)).toContainText("当前账户额度尚未加载或未配置");
  await layout(page);await capture(page,"unconfigured",info.project.name);expect(posts).toEqual([]);
});

test("lost start response survives reload, retries original UUID and polls to complete",async({page},info)=>{
  const commands: GameFiCommand[]=[];let current:GameFiRun|undefined;let reads=0;
  await page.route("**/api/arena/gamefi*",async route=>{
    if(route.request().method()==="POST"){
      const command=route.request().postDataJSON() as GameFiCommand;commands.push(command);
      if(!current)current=run({requestId:command.requestId});
      else expect(command.requestId).toBe(current.requestId);
      if(commands.length===1)return route.abort("failed");
      return route.fulfill({json:game(current)});
    }
    const id=new URL(route.request().url()).searchParams.get("requestId");
    if(id&&current){expect(id).toBe(current.requestId);reads++;if(commands.length===2&&reads>=3)current=run({requestId:id,status:"Complete",stage:"purchase",purchase:{phase:"Complete",physicalInferenceAttempts:1,purchases:[{seat:1,state:"Delivered"}]}});}
    return route.fulfill({json:game(current)});
  });
  await page.route("**/api/arena/credits*",route=>route.fulfill({json:credits()}));
  await page.goto("/arena");await page.getByRole("button",{name:"发起真实德州比赛",exact:true}).click();
  await expect(page.getByRole("button",{name:"重试原比赛请求",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"发起真实德州比赛",exact:true})).toBeDisabled();
  const original=commands[0];expect(original.action).toBe("start");expect(original.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();await expect(page.getByRole("button",{name:"重试原比赛请求",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"重试原比赛请求",exact:true}).click();
  await expect(page.locator(".af-run-detail h3")).toHaveText("已完成 · 奖励购买推理",{timeout:12000});
  expect(commands).toEqual([original,original]);
  await expect(page.getByRole("button",{name:"重试原比赛请求",exact:true})).toHaveCount(0);
  await expect(page.locator(".af-run-detail code")).toHaveText(original.requestId);
  await layout(page);await capture(page,"completed",info.project.name);
});

test("saved paused run queries and recovers the same ID without starting another game",async({page},info)=>{
  const commands:GameFiCommand[]=[];const queries:string[]=[];let recovering=false;
  await page.addInitScript(({id})=>localStorage.setItem("agentfuel:gamefi:run",id),{id:requestId});
  await page.route("**/api/arena/gamefi*",route=>{
    if(route.request().method()==="POST"){commands.push(route.request().postDataJSON() as GameFiCommand);recovering=true;}
    else queries.push(new URL(route.request().url()).searchParams.get("requestId")||"");
    return route.fulfill({json:game(run({status:recovering?"Complete":"Paused",stage:"award",recoverable:!recovering,reason:recovering?undefined:"GAMEFI_AWARD_RECOVERY_REQUIRED"}))});
  });
  await page.route("**/api/arena/credits*",route=>route.fulfill({json:credits()}));
  await page.goto("/arena");await expect(page.locator(".af-run-detail h3")).toHaveText("已暂停 · USDC 奖励入账");
  await page.getByRole("button",{name:"按原记录继续核查",exact:true}).click();
  await expect(page.locator(".af-run-detail h3")).toHaveText("已完成 · USDC 奖励入账");
  expect(commands).toEqual([{action:"recover",requestId}]);expect(queries.every(id=>id===requestId)).toBe(true);
  await layout(page);await capture(page,"recovered",info.project.name);
});

test("fixed identity balance is displayed, successful usage settles the reservation",async({page},info)=>{
  let current=credits({balance:balance({consumedTokens:100,reservedTokens:300,availableTokens:9600})});const posts:Record<string,unknown>[]=[];
  await page.route("**/api/arena/gamefi*",route=>route.fulfill({json:game()}));
  await page.route("**/api/arena/credits*",route=>{
    if(route.request().method()==="POST"){
      const command=route.request().postDataJSON();posts.push(command);
      current=credits({balance:balance({consumedTokens:125,reservedTokens:0,availableTokens:9875}),redemption:redemption(command.redemptionId,{status:"Completed",chargedTokens:25,usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25},content:"受控测试回答：先设置预算，再按实际用量结算。"})});
    }
    return route.fulfill({json:current});
  });
  await page.goto("/arena");await expect(page.locator(".af-credit-console")).toContainText("当前 Agent #1999 · kimi-k2.6");
  await expect(page.locator(".af-credit-console .af-arena-stats")).toContainText("9600");await expect(page.locator(".af-credit-console .af-arena-stats")).toContainText("300");
  await page.getByLabel("获奖额度推理问题").fill("请解释预算。");await page.getByRole("button",{name:"使用额度调用 Kimi",exact:true}).click();
  await expect(page.locator(".af-credit-console [role=status]")).toContainText("Completed · 已扣 25 token");
  await expect(page.locator(".af-credit-console .af-arena-stats")).toContainText("9875");
  expect(posts).toHaveLength(1);expect(Object.keys(posts[0]).sort()).toEqual(["action","maxCompletionTokens","prompt","redemptionId"]);expect(posts[0].maxCompletionTokens).toBe(128);expect(posts[0].prompt).toBe("请解释预算。");
  await expect(page.getByRole("button",{name:"使用额度调用 Kimi",exact:true})).toBeEnabled();
  await layout(page);await capture(page,"credits-completed",info.project.name);
});

test("second redemption with lost response cannot reuse the previous completed status",async({page})=>{
  const posts:Record<string,unknown>[]=[];const queries:string[]=[];let current=credits();
  await page.route("**/api/arena/gamefi*",route=>route.fulfill({json:game()}));
  await page.route("**/api/arena/credits*",route=>{
    if(route.request().method()==="POST"){
      const command=route.request().postDataJSON();posts.push(command);
      if(posts.length===1){current=credits({redemption:redemption(command.redemptionId,{status:"Completed",chargedTokens:25,content:"第一次受控测试已完成。"})});return route.fulfill({json:current});}
      current=credits({balance:balance({reservedTokens:512,availableTokens:9488}),redemption:redemption(command.redemptionId)});return route.abort("failed");
    }
    const id=new URL(route.request().url()).searchParams.get("redemptionId");if(id)queries.push(id);
    return route.fulfill({json:current});
  });
  await page.goto("/arena");const button=page.getByRole("button",{name:"使用额度调用 Kimi",exact:true});await button.click();
  await expect(page.locator(".af-credit-console [role=status]")).toContainText("Completed");await expect(button).toBeEnabled();
  await button.click();await expect(consolePanel(page).getByRole("alert")).toContainText("不要重复提交");
  expect(posts).toHaveLength(2);expect(posts[0].redemptionId).not.toBe(posts[1].redemptionId);await expect(button).toBeDisabled();
  await expect(page.locator(".af-credit-console [role=status]")).toHaveCount(0);
  await page.getByRole("button",{name:"查询原兑换记录",exact:true}).click();
  await expect(page.locator(".af-credit-console [role=status]")).toContainText("OutcomeUnknown");
  await expect(button).toBeDisabled();expect(queries).toEqual([posts[1].redemptionId]);expect(posts).toHaveLength(2);
});

test("unknown redemption restores its original ID and reserved balance after reload",async({page},info)=>{
  const queries:string[]=[];const posts:string[]=[];
  await page.addInitScript(({id})=>localStorage.setItem("agentfuel:gamefi:redemption",id),{id:redemptionId});
  await page.route("**/api/arena/gamefi*",route=>route.fulfill({json:game()}));
  await page.route("**/api/arena/credits*",route=>{
    if(route.request().method()==="POST")posts.push(route.request().postData()||"");
    const id=new URL(route.request().url()).searchParams.get("redemptionId");if(id)queries.push(id);
    return route.fulfill({json:credits({balance:balance({reservedTokens:512,availableTokens:9488}),redemption:redemption(redemptionId,{error:"REWARD_UNVERIFIABLE_UPSTREAM_USAGE"})})});
  });
  await page.goto("/arena");await expect(page.locator(".af-credit-console [role=status]")).toContainText("OutcomeUnknown");
  await expect(page.getByRole("button",{name:"使用额度调用 Kimi",exact:true})).toBeDisabled();
  await expect(page.locator(".af-credit-console .af-arena-stats")).toContainText("512");
  await page.getByRole("button",{name:"查询原兑换记录",exact:true}).click();expect(queries).toEqual([redemptionId,redemptionId]);expect(posts).toEqual([]);
  await layout(page);await capture(page,"credits-unknown",info.project.name);
});

test("insufficient or blocked credits and empty prompt cannot submit a provider request",async({page})=>{
  const posts:string[]=[];let current=credits({balance:balance({availableTokens:100})});
  await page.route("**/api/arena/gamefi*",route=>route.fulfill({json:{enabled:true,rewardKinds:["usdc"],runs:[]}}));
  await page.route("**/api/arena/credits*",route=>{if(route.request().method()==="POST")posts.push("redeem");return route.fulfill({json:current});});
  await page.goto("/arena");const redeem=page.getByRole("button",{name:"使用额度调用 Kimi",exact:true});await expect(redeem).toBeDisabled();
  await page.getByLabel("本场奖励").selectOption("llm-credits");await expect(page.getByRole("button",{name:"发起真实德州比赛",exact:true})).toBeDisabled();
  current=credits({balance:balance({blocked:true})});await page.getByRole("button",{name:"刷新比赛与额度",exact:true}).click();await expect(redeem).toBeDisabled();
  current=credits();await page.getByRole("button",{name:"刷新比赛与额度",exact:true}).click();await page.getByLabel("获奖额度推理问题").fill("   ");await expect(redeem).toBeDisabled();expect(posts).toEqual([]);
});


test("active saved list is discovered and polled without a new start",async({page},info)=>{
  const queries:string[]=[];const posts:string[]=[];let current=run({rewardKind:"llm-credits"});
  const previous=run({requestId:"33333333-3333-4333-8333-333333333333",status:"Complete",stage:"purchase"});
  await page.route("**/api/arena/gamefi*",route=>{
    if(route.request().method()==="POST")posts.push(route.request().postData()||"");
    const id=new URL(route.request().url()).searchParams.get("requestId");
    if(!id)return route.fulfill({json:{enabled:true,rewardKinds:["usdc","llm-credits"],runs:[current,previous]}});
    queries.push(id);if(id===previous.requestId)return route.fulfill({json:{...game(previous),runs:[current,previous]}});
    current=run({rewardKind:"llm-credits",status:"Complete",stage:"credits",credits:{grantId:"grant-test",matchId:"match-test",replayDigest:"a".repeat(64),model:"kimi-k2.6",allocations:[0,4096],winners:[1],createdAt:time}});
    return route.fulfill({json:{...game(current),runs:[current,previous]}});
  });
  await page.route("**/api/arena/credits*",route=>route.fulfill({json:credits()}));
  await page.goto("/arena");await expect(page.locator(".af-run-detail h3")).toHaveText("执行中 · 模型对局");
  await expect(page.getByRole("button",{name:"发起真实德州比赛",exact:true})).toBeDisabled();
  await expect(page.locator(".af-run-detail h3")).toHaveText("已完成 · 推理额度发放",{timeout:12000});
  await expect(page.locator(".af-run-detail")).toContainText("0 / 4096");expect(queries).toEqual([requestId]);expect(posts).toEqual([]);
  await layout(page);await capture(page,"credits-awarded",info.project.name);
  await consolePanel(page).getByText("已保存的真实比赛",{exact:true}).click();
  await consolePanel(page).getByRole("button",{name:/已完成 · USDC ·/}).click();
  await expect(page.locator(".af-run-detail code")).toHaveText(previous.requestId);expect(queries).toEqual([requestId,previous.requestId]);expect(posts).toEqual([]);
});
