import {test,expect,type Page} from '@playwright/test';
import {makeRun,makeAgent,syntheticHosted,unexpectedByPage,wallet} from './hosted-harness';
import type {HostedActivity,HostedRun} from '../../lib/hosted-client';
const hex='0x'+'a'.repeat(64),at='2026-10-14T03:00:00.000Z';
const capabilities={goals:{maxPhases:3,models:[{id:'kimi-k2.6',pricePerCallRaw:'10000'}],specialists:[{id:'writer',serviceId:'tabby/writer',name:'Writing Specialist',output:'text'}]}} as const;
async function mission(page:Page){if((page.viewportSize()?.width??1440)<900)await page.getByRole('tab',{name:'mission.log',exact:true}).click();}
async function sceneFixture(page:Page,run:HostedRun){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const harness=await syntheticHosted(page,{chainId:'42431',capabilities:{goals:{...capabilities.goals,models:[...capabilities.goals.models],specialists:[...capabilities.goals.specialists]}},agents:[makeAgent({binding:{chainId:'42431',agentId:'73',wallet},activeRequestId:['Running','Paused','Queued'].includes(run.status)?run.requestId:undefined})],runs:[run]});
 await page.goto('/dashboard');await mission(page);
 if(!['Running','Paused','Queued'].includes(run.status)){await page.getByRole('button',{name:/^历史/}).click();await page.getByTestId(`history-request-${run.requestId}`).click();}
 return {...harness,errors};
}
test.afterEach(async({page})=>{const unexpected=unexpectedByPage.get(page);if(unexpected)expect(unexpected).toEqual([]);});
test('public specialist selection drives the real scene while keeping workflow progress and model costs separate',async({page},info)=>{
 const activity:HostedActivity={scene:'specialists',state:'selected',phaseId:'phase-0',seq:1,at,subject:{id:'writer',name:'Writing Specialist',kind:'specialist'},evidence:{candidateIds:['writer'],chainId:'42431'}};
 const run=makeRun({action:'goal',goal:'Synthetic controlled writer goal',status:'Running',result:undefined,activities:[activity],mission:{stage:'executing',phases:[{name:'Write a note',taskType:'writer',goal:'Use supplied data'}],calls:[]}});
 const h=await sceneFixture(page,run),panel=page.getByRole('region',{name:'Agent 任务状态'});await expect(panel).toHaveAttribute('data-scene','specialists');await expect(panel).toHaveAttribute('data-state','selected');await expect(panel.getByRole('status')).toHaveText('已选中内置专家');await expect(panel).toHaveAttribute('data-moving','true');
 await expect(page.getByRole('article',{name:'目标任务结果'})).toContainText(run.goal!);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect(h.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(h.rpcCalls).toEqual([]);expect(h.errors).toEqual([]);
 await page.screenshot({path:info.outputPath('synthetic-specialist-scene.png'),fullPage:true});
});
for(const status of ['Paused','Failed'] as const)test(`${status} Unknown overrides stale completed activity and freezes the cat without inventing delivery`,async({page})=>{
 const run=makeRun({action:'goal',goal:'Synthetic unknown response',status,reason:'HOSTED_GOAL_CALL_UNCERTAIN',result:{phase:'Paused',terminal:false,success:false,chargedRaw:'10000'},activities:[{scene:'delivery',state:'completed',seq:1,at}],mission:{stage:'paused',phases:[],calls:[],answer:'Confirmed partial content'}});
 const h=await sceneFixture(page,run),panel=page.getByRole('region',{name:'Agent 任务状态'});await expect(panel).toHaveAttribute('data-state','reconciling');await expect(panel).toHaveAttribute('data-moving','false');await expect(panel.getByRole('status')).toContainText('结果待确认');
 const chat=page.getByRole('article',{name:'目标任务结果'});await expect(chat).toContainText('Confirmed partial content');await expect(chat).not.toContainText('已完成');expect(h.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(h.rpcCalls).toEqual([]);expect(h.errors).toEqual([]);
});
test('historical conversation is static, reveals original public receipts on demand and copies the complete response',async({page},info)=>{
 const view={stage:'completed' as const,phases:[{name:'Write',taskType:'writer',goal:'Use A and B',output:'Synthetic response with A and B.'}],answer:'Synthetic response with A and B.',review:{passed:true,summary:'Controlled review includes A and B.',checks:['Synthetic only']},calls:[{stage:'phase-0',model:'kimi-k2.6',chargedRaw:'10000',promptTokens:21,completionTokens:12,txHash:hex,paymentId:hex}]};
 const run=makeRun({action:'goal',goal:'Synthetic history goal',mission:view,activities:[{scene:'model',state:'completed',seq:1,at,evidence:{chainId:'42431',txHash:hex,chargedRaw:'10000'}}],result:{phase:'Completed',terminal:true,success:true,chargedRaw:'10000',mission:view}});
 const h=await sceneFixture(page,run),panel=page.getByRole('region',{name:'Agent 任务状态'});await expect(panel).toHaveAttribute('data-history','true');await expect(panel).toHaveAttribute('data-moving','false');
 const chat=page.getByRole('article',{name:'目标任务结果'}),toggle=chat.getByRole('button',{name:/已完成/});await expect(toggle).toHaveAttribute('aria-expanded','false');await expect(chat.locator('[data-revealing]')).toHaveAttribute('data-revealing','false');await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','true');
 await chat.getByText('费用与凭证 · 1 次调用',{exact:true}).click();await expect(chat).toContainText('0.01 PathUSD');await expect(chat.getByRole('link',{name:/^付款凭证 · .* ↗$/})).toHaveAttribute('href',`https://explore.testnet.tempo.xyz/tx/${hex}`);
 await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{(window as any).__copied=text;}}});});await chat.getByRole('button',{name:'复制回复'}).click();await expect(chat.getByRole('button',{name:'已复制'})).toBeVisible();expect(await page.evaluate(()=>(window as any).__copied)).toBe(view.answer);
 expect(h.commands.filter(c=>c.method!=='GET')).toEqual([]);expect(h.rpcCalls).toEqual([]);expect(h.errors).toEqual([]);await page.screenshot({path:info.outputPath('synthetic-history-conversation.png'),fullPage:true});
});
test('reduced motion blocks all cat frame advancement even for a live selected fact',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});
 const run=makeRun({action:'goal',status:'Running',result:undefined,goal:'Synthetic motion preference',activities:[{scene:'specialists',state:'selected',seq:1,at,subject:{id:'writer',name:'Writing Specialist',kind:'specialist'}}]});await sceneFixture(page,run);
 const panel=page.getByRole('region',{name:'Agent 任务状态'});await expect(panel).toHaveAttribute('data-moving','false');const canvas=panel.locator('canvas');const x=await canvas.getAttribute('data-cat-x');await page.waitForTimeout(250);expect(await canvas.getAttribute('data-cat-x')).toBe(x);await expect(canvas).toHaveAttribute('data-cat-walking','false');
});
test('bilingual landing architecture remains readable at desktop and narrow mobile widths with no external resources',async({page,baseURL},info)=>{
 const origin=new URL(baseURL!).origin;
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).origin!==origin)requests.push(r.url());});await page.route('**/api/**',r=>r.fulfill({status:503,json:{error:'SYNTHETIC_NOT_CONFIGURED'}}));await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.fallback():r.abort());
 const widths=info.project.name==='desktop'?[1440]:[393,320];
 for(const width of widths){await page.setViewportSize({width,height:900});for(const language of ['en','zh']){await page.goto(`/?lang=${language}`);await expect(page.getByTestId('oberon-landing')).toHaveAttribute('lang',language==='zh'?'zh-CN':'en');await page.locator('#system').scrollIntoViewIfNeeded();await expect(page.locator('#system').getByRole('heading').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.locator('#arena').scrollIntoViewIfNeeded();await expect(page.locator('#arena')).toContainText('PathUSD');const content=await page.locator('body').innerText();expect(content).not.toMatch(/USDC/);expect(content.replace('From a historical Monad testnet demo','').replace('来自 Monad 测试网历史演示','')).not.toMatch(/Monad/);if(language==='en')expect(content.match(/[\u4e00-\u9fff]+/g)).toEqual(['中文']);await page.locator('#system').scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`landing-${language}-${width}.png`),fullPage:false});}}
 expect(errors).toEqual([]);expect(requests).toEqual([]);
});
