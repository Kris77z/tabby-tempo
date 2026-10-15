import {test,expect,type Page} from '@playwright/test';
import {makeAgent,makeRun,syntheticHosted,unexpectedByPage,wallet} from './hosted-harness';
import type {HostedCapabilities} from '../../lib/hosted-client';
const capabilities:HostedCapabilities={autonomy:{maxTasks:2,durationMs:60000,plannerPriceRaw:'10000'},goals:{maxPhases:3,models:[{id:'kimi-k2.6',pricePerCallRaw:'10000'}]}};
async function pane(page:Page,name:string){if((page.viewportSize()?.width??1440)<900)await page.getByRole('tab',{name,exact:true}).click();}
test.afterEach(async({page})=>{expect(unexpectedByPage.get(page)??[]).toEqual([]);});
for(const reward of [false,true])test(`old paused autonomous ${reward?'explicit reward child':'cash journal'} retains its funding action without sending a command`,async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const run=makeRun({action:'autonomous',status:'Paused',reason:'INFERENCE_FUNDING_REQUIRED',recoverable:true,result:{phase:'Paused',terminal:false,success:false,chargedRaw:'0'},...(reward?{fundingNeed:'reward-tokens' as const}:{})});
 const h=await syntheticHosted(page,{chainId:'42431',capabilities,agents:[makeAgent({binding:{chainId:'42431',agentId:'73',wallet},activeRequestId:run.requestId})],runs:[run]});
 await page.goto('/dashboard');await pane(page,'mission.log');
 if(reward){await expect(page.getByRole('button',{name:'赢取额度 →',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'补充资金 →',exact:true})).toHaveCount(0);}
 else{await expect(page.getByRole('button',{name:'补充资金 →',exact:true})).toBeVisible();await page.getByRole('tab',{name:'资金与借贷',exact:true}).click();await expect(page.getByRole('textbox',{name:'入账金额（PathUSD）',exact:true})).toBeEnabled();}
 expect(h.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(h.rpcCalls).toEqual([]);expect(errors).toEqual([]);
});
test('external identity card shows bound provider and actual price without invented rating',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const external={id:'external-writer-cheap',name:'Synthetic External Writer',taskType:'writer',serviceId:'tabby/external/writer',modelId:'kimi-k2.6',provider:'0x'+'4'.repeat(40),priceRaw:'10000',identity:{chainId:'42431',registry:'0x'+'3'.repeat(40),agentId:'99',wallet:'0x'+'4'.repeat(40)},reputation:{score:null,samples:0,source:'registry' as const}};
 const h=await syntheticHosted(page,{chainId:'42431',capabilities:{...capabilities,goals:{...capabilities.goals!,external:{services:[external]}}},agents:[makeAgent({binding:{chainId:'42431',agentId:'73',wallet}})],runs:[]});
 await page.goto('/dashboard');await pane(page,'mesh.net');const card=page.getByRole('article',{name:external.name,exact:true});await expect(card).toContainText('0.01 PathUSD');await expect(card).toContainText('未评级');await card.getByRole('button',{name:`${external.name} 信息与凭证`,exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText(external.identity.registry);await expect(dialog).toContainText(external.provider);await expect(dialog).toContainText('99');await expect(dialog).toContainText('未评级');await expect(dialog).not.toContainText('Monad');
 expect(h.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(h.rpcCalls).toEqual([]);expect(errors).toEqual([]);await page.screenshot({path:info.outputPath('synthetic-external-identity.png'),fullPage:true});
});
