import {test,expect} from '@playwright/test';
import {syntheticHosted,makeAgent,makeRun,agentId,unexpectedByPage} from './hosted-harness';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const capabilities={goals:{maxPhases:3 as const,models:[{id:'kimi-k2.6',pricePerCallRaw:'10000'}]}};
test.afterEach(async({page})=>{expect(unexpectedByPage.get(page)).toEqual([]);});
test('Tempo workspace presents original history, expired authorization and disables new games',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const harness=await syntheticHosted(page,{chainId:'42431',capabilities,agents:[makeAgent({binding:{chainId:'42431',agentId:'73',wallet:'0x'+'2'.repeat(40)}})],runs:[makeRun({chargedRaw:'120000',result:{phase:'Complete',terminal:true,success:true,chargedRaw:'120000',rewardRaw:'100000',chainId:'42431'}})],sponsorship:{used:7,limit:3,remaining:0,globalLimit:100,testAuthorization:{id:'11111111-1111-4111-8111-111111111111',maxTotalGames:9,expiresAt:'2026-10-13T07:28:04.166Z',active:false,additionalUsed:4,actorRewards:[{hostedAgentId:agentId,rewardKind:'usdc'}]}}});
 await page.goto('/dashboard?operation=game');
 if(info.project.name==='mobile')await page.getByRole('tab',{name:'mission.log',exact:true}).click();
 await expect(page.getByText('测试追加授权已到期。',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'执行操作',exact:true})).toBeDisabled();
 await expect(page.getByRole('combobox',{name:'比赛奖励',exact:true})).toContainText('PathUSD');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 const directory=resolve('frontend/acceptance/upstream-sync-20261013');await mkdir(directory,{recursive:true});await page.screenshot({path:resolve(directory,`synthetic-tempo-expired-${info.project.name}.png`),fullPage:true});
 expect(harness.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(harness.rpcCalls).toEqual([]);expect(errors).toEqual([]);
});
test('unconfigured goal cannot dispatch and Tempo model settings use PathUSD',async({page},info)=>{
 const harness=await syntheticHosted(page,{chainId:'42431',agents:[makeAgent({binding:{chainId:'42431',agentId:'73',wallet:'0x'+'2'.repeat(40)}})]});await page.goto('/dashboard');
 if(info.project.name==='mobile')await page.getByRole('tab',{name:'mission.log',exact:true}).click();
 await page.getByRole('textbox',{name:'任务目标'}).fill('Inspect supplied ABI');await expect(page.getByRole('button',{name:'发送任务',exact:true})).toBeDisabled();
 await expect(page.getByText('目标执行服务暂未就绪。')).toBeVisible();
 if(info.project.name==='mobile')await page.getByRole('tab',{name:'agent.sys',exact:true}).click();
 await page.getByRole('button',{name:'运行设置',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('单次推理预算（PathUSD）',{exact:true})).toBeVisible();
 expect(harness.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(harness.rpcCalls).toEqual([]);
});

test('notifications preserve confirmed status without intercepting the next task action',async({page})=>{
 const harness=await syntheticHosted(page);await page.goto('/dashboard?operation=task');
 const button=page.getByRole('button',{name:'执行操作',exact:true});await button.click();
 await expect.poll(()=>harness.commands.filter(c=>c.method==='POST'&&c.path.endsWith('/runs')).length).toBe(1);
 await expect(page.getByRole('status').filter({hasText:'请求已确认接收'})).toBeVisible();
 await button.click({timeout:2500});
 await expect.poll(()=>harness.commands.filter(c=>c.method==='POST'&&c.path.endsWith('/runs')).length).toBe(2);
 expect(harness.rpcCalls).toEqual([]);
});
