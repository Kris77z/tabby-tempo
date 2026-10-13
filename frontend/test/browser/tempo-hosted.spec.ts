import { test, expect, type Page } from "@playwright/test";
import { makeAgent, makeRun, syntheticHosted, unexpectedByPage, settings, uuid } from "./hosted-harness";
import { configureTerminal } from "./onboarding-steps";

test.afterEach(async ({ page }) => { expect(unexpectedByPage.get(page)).toEqual([]); });
const wallet = `0x${"2".repeat(40)}`, hash = (digit: string) => `0x${digit.repeat(64)}`;
const agent = makeAgent({ binding: { chainId: "42431", agentId: "1999", wallet } });

async function mobilePanel(page:Page,name:string){const tab=page.getByRole('tab',{name,exact:true});if(await tab.isVisible())await tab.click();}
async function account(page:Page,name:string){await page.getByRole('button',{name:'账户菜单',exact:true}).click();return page.getByRole('menuitem',{name,exact:true});}
test("Tempo login displays PathUSD and links wallet, acceptance, payment and settlement evidence", async ({ page }) => {
 const run=makeRun({result:{phase:'Succeeded',terminal:true,success:true,chargedRaw:'120000',chainId:'42431',fromCashRaw:'40000',fromCreditRaw:'80000',acceptTxHash:hash('a'),paymentTxHash:hash('b'),settlement:{txHash:hash('c'),block:{number:3,hash:hash('d'),timestamp:1791676850},passed:true,loanStatus:'2',repaidRaw:'92000',slashedRaw:'0',residualRaw:'58000'}}});
 const harness=await syntheticHosted(page,{authenticated:false,chainId:'42431',agents:[agent],runs:[run]});await page.goto('/dashboard');await page.getByRole('button',{name:'签名登录',exact:true}).click();
 await expect.poll(()=>harness.signed.length).toBe(1);expect(harness.signed[0].message).toContain('Chain: 42431');
 await mobilePanel(page,'agent.sys');await expect(page.getByRole('link',{name:'查看钱包 ↗'})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/address/${wallet}`);
 await page.getByTestId('hosted-panel-agent').getByRole('button',{name:'信息与凭证 ↗',exact:true}).click();const profile=page.getByRole('dialog');await expect(profile).toContainText('Tempo Moderato Testnet');await expect(profile.getByRole('link',{name:/^接单/})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/tx/${hash('a')}`);await profile.getByRole('button',{name:'关闭信息卡'}).click();
 await mobilePanel(page,'mission.log');await page.getByRole('button',{name:/^历史/}).click();await page.getByTestId(`history-request-${run.requestId}`).click();
 const summary=page.getByRole('region',{name:'任务结算摘要'});await expect(summary).toContainText('cash 支付 0.04 · 信用支付 0.08 PathUSD');await expect(summary).toContainText('实际还款 0.092 PathUSD');await expect(summary.getByRole('link',{name:/查看结算交易/})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/tx/${hash('c')}`);
 await page.getByText('请求详情与凭证',{exact:true}).click();await expect(page.getByRole('link',{name:/查看付款交易/})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/tx/${hash('b')}`);
 await page.getByRole('tab',{name:'资金与借贷',exact:true}).click();await expect(page.getByLabel('入账金额（PathUSD）',{exact:true}).filter({visible:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(harness.rpcCalls.every(c=>['eth_requestAccounts','eth_accounts','eth_chainId','personal_sign'].includes(c.method))).toBe(true);
});

test("a wallet on the wrong chain receives the Tempo switch message before any signature", async ({ page }) => {
  const harness = await syntheticHosted(page, { authenticated: false, chainId: "42431", walletChainId: "10143", agents: [agent] });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "签名登录", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "钱包网络不匹配" })).toContainText("Tempo Moderato Testnet（42431）");
  expect(harness.signed).toEqual([]);
  expect(harness.commands.filter(command => command.path.endsWith("/auth/login"))).toEqual([]);
});

test("first-time Tempo creation defers execution configuration then labels all budgets PathUSD",async({page})=>{
 const harness=await syntheticHosted(page,{authenticated:false,chainId:'42431',agents:[]});await page.goto('/onboarding');await page.getByRole('button',{name:'开始创建 ↵',exact:true}).click();await page.getByRole('button',{name:'签名登录',exact:true}).click();await configureTerminal(page,settings,true);await expect(page.getByRole('region',{name:'确认创建 Agent'})).toContainText('尚未授权');await page.getByRole('button',{name:'确认创建',exact:true}).click();await expect(page).toHaveURL(/\/dashboard$/);
 expect(harness.commands.filter(c=>c.path==='/api/hosted/agents'&&c.method==='POST').map(c=>c.body)).toEqual([{name:settings.name,requestId:expect.stringMatching(uuid)}]);
 await mobilePanel(page,'agent.sys');await page.getByTestId('hosted-panel-agent').getByRole('button',{name:'设置模型与预算 →',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('单次推理预算（PathUSD）',{exact:true})).toBeVisible();await expect(dialog.getByLabel('允许任务授信',{exact:true})).not.toBeChecked();
 await dialog.getByRole('combobox',{name:'模型',exact:true}).click();await page.getByRole('listbox',{name:'模型',exact:true}).getByRole('option',{name:'Kimi K2.6',exact:true}).click();await dialog.getByLabel('允许任务授信',{exact:true}).check();await dialog.getByRole('button',{name:'保存设置',exact:true}).click();await expect(dialog).toBeHidden();
 expect(harness.commands.filter(c=>c.method==='PATCH').at(-1)?.body).toEqual(settings);expect(harness.rpcCalls.every(c=>['eth_requestAccounts','eth_accounts','eth_chainId','personal_sign'].includes(c.method))).toBe(true);
});
