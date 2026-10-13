import {test,expect,type Page} from '@playwright/test';
import {syntheticHosted,makeAgent,makeRun,wallet} from './hosted-harness';
import type {HostedCapabilities} from '../../../services/hosted-agents/src/types';
const token='0x20c0000000000000000000000000000000000000',hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
const capabilities:HostedCapabilities={goals:{maxPhases:3,models:[{id:'kimi-k2.6',pricePerCallRaw:'10000'}],chainLookup:{chainId:'42431',maxTargets:2}}};
async function mission(page:Page){if((page.viewportSize()?.width??1440)<900)await page.getByRole('tab',{name:'mission.log',exact:true}).click();}
test('Tempo chain evidence displays current network, fee and exact explorer/source links; download is bounded public data',async({page},info)=>{
 const research={version:1 as const,chainId:'42431',observedAt:'2026-10-13T01:00:00.000Z',digest:hash,records:[{kind:'address' as const,target:token,blockNumber:100,blockHash,dataJson:JSON.stringify({nativeBalanceIsPlaceholder:true,feeAsset:{symbol:'PathUSD',decimals:6}}),source:{url:`https://sourcify.dev/server/v2/contract/42431/${token}?fields=abi,sources,runtimeBytecode.onchainBytecode`,status:'unverified',codeMatched:false,truncated:false}},{kind:'transaction' as const,target:hash,blockNumber:100,blockHash,dataJson:JSON.stringify({fee:{status:'confirmed-receipt-transfer',symbol:'PathUSD',amountRaw:'210',amount:'0.00021'}})}]};
 const view={stage:'completed' as const,phases:[{name:'ABI',taskType:'abi-interact',goal:'Read supplied fixture',output:'Synthetic bounded report'}],calls:[],research,answer:'Synthetic bounded report',review:{passed:true,summary:'Controlled review only',checks:['Fixture']}};
 const run=makeRun({action:'goal',goal:'Read the current Tempo address',mission:view,result:{phase:'Completed',terminal:true,success:true,chargedRaw:'0',mission:view}});
 const harness=await syntheticHosted(page,{chainId:'42431',capabilities,agents:[makeAgent({binding:{chainId:'42431',agentId:'1999',wallet}})],runs:[run]});
 await page.goto('/dashboard');await mission(page);
 await page.getByRole('button',{name:/^历史/}).click();await page.getByTestId(`history-request-${run.requestId}`).click();
 await page.getByText(/查链来源与凭证 · 2 项 · Tempo Moderato Testnet/).click();
 await expect(page.getByRole('link',{name:token+' ↗',exact:true})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/address/${token}`);
 await expect(page.getByRole('link',{name:hash+' ↗',exact:true})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/tx/${hash}`);
 await expect(page.getByRole('link',{name:'Sourcify 来源 ↗'})).toHaveAttribute('href',research.records[0].source!.url);
 await page.getByText('读取结果',{exact:true}).nth(1).click();await expect(page.getByText('"amountRaw": "210"',{exact:false})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载查链与付款凭证 ↓'}).click();expect((await download).suggestedFilename()).toContain(run.requestId);
 expect(harness.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(harness.rpcCalls).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('synthetic-tempo-chain-evidence.png'),fullPage:true});
});
test('automatic chain lookup is advertised only when the actual service capability is configured',async({page})=>{
 await syntheticHosted(page,{capabilities:{goals:{maxPhases:3,models:capabilities.goals!.models}}});await page.goto('/dashboard');await mission(page);
 await page.getByTitle('模型、计费与能力范围').click();await expect(page.getByText('当前服务尚未启用自动查链，需提供资料。',{exact:false})).toBeVisible();
});
test('reduced-motion Magpie renders the real stage once and does not keep animating',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(()=>{const ctx=CanvasRenderingContext2D.prototype,clear=ctx.clearRect;(window as any).__magpieFrames=0;ctx.clearRect=function(...args){if(this.canvas.closest('[aria-label="Agent 任务状态"]'))(window as any).__magpieFrames++;return clear.apply(this,args);};});
 const run=makeRun({action:'goal',goal:'Synthetic progress',status:'Running',result:undefined,mission:{stage:'executing',phases:[{name:'Real persisted stage',taskType:'writer',goal:'Write'}],calls:[]}});
 await syntheticHosted(page,{capabilities,runs:[run],agents:[makeAgent({activeRequestId:run.requestId})]});await page.goto('/dashboard');await mission(page);
 const panel=page.getByRole('region',{name:'Agent 任务状态'});await expect(panel.getByRole('status')).toHaveText('Real persisted stage');
 await expect.poll(()=>page.evaluate(()=>(window as any).__magpieFrames)).toBeGreaterThan(0);
 await page.waitForTimeout(150);const count=await page.evaluate(()=>(window as any).__magpieFrames);await page.waitForTimeout(300);expect(await page.evaluate(()=>(window as any).__magpieFrames)).toBe(count);
 await expect(panel).toContainText('Real persisted stage · 进行中');await expect(panel).not.toContainText('任务完成');
});
