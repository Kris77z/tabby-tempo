import test from 'node:test';
import assert from 'node:assert/strict';
import {tabbyScene,tabbySceneHistory,practiceGameScene,runOutcomeLabel} from '../lib/tabby-scenes';
import {expertAssignments} from '../lib/expert-assignments';
import type {HostedActivity,HostedActivityInput,HostedFinance,HostedRun} from '../lib/hosted-client';
import type {PlayMatchView} from '../lib/play-types';
const at='2026-10-14T03:00:00.000Z',hash='0x'+'a'.repeat(64);
const event=(input:HostedActivityInput,seq=1):HostedActivity=>({...input,seq,at});
const run=(values:Partial<HostedRun>={}):HostedRun=>({requestId:'scene-test',agentId:'agent-1',action:'goal',status:'Running',createdAt:at,updatedAt:at,reservedRaw:'120000',chargedRaw:'10000',recoverable:false,...values});
test('queued requests and needs-input results cannot display execution or successful delivery',()=>{
 const queued=tabbyScene(run({status:'Queued',activities:[event({scene:'execution',state:'started',subject:{id:'writer',name:'Writer',kind:'specialist'}})]}));
 assert.equal(queued.scene,'idle');assert.equal(queued.state,'queued');assert.equal(queued.animated,false);assert.equal(queued.selectedExpert,undefined);
 const waiting=run({status:'Succeeded',mission:{stage:'needs-input',phases:[],answer:'请提供资料',calls:[]},result:{phase:'Completed',terminal:true,success:true,chargedRaw:'10000'},activities:[event({scene:'delivery',state:'completed'})]});
 assert.equal(tabbyScene(waiting).requiredAction,'provide-input');assert.equal(tabbyScene(waiting).animated,false);assert.equal(runOutcomeLabel(waiting),'需要补充信息');
 const failedReview=run({status:'Succeeded',mission:{stage:'completed',phases:[],calls:[],review:{passed:false,summary:'不通过',checks:[]}}});assert.equal(tabbyScene(failedReview).state,'failed');assert.equal(runOutcomeLabel(failedReview),'已停止');
});
test('stop and unknown outcomes outrank a partial refund while preserving confirmed costs',()=>{
 const unresolved=run({status:'Paused',reason:'HOSTED_GOAL_CALL_UNCERTAIN',result:{phase:'Paused',terminal:false,success:false,chargedRaw:'10000',refundedRaw:'5000'},activities:[event({scene:'interruption',state:'refunded',evidence:{refundedRaw:'5000',paymentId:hash}})]});
 const scene=tabbyScene(unresolved);assert.equal(scene.state,'reconciling');assert.equal(scene.evidence.refundedRaw,'5000');assert.equal(scene.evidence.chargedRaw,'10000');assert.equal(scene.evidence.paymentId,hash);assert.equal(runOutcomeLabel(unresolved),'结果待确认');
 assert.equal(tabbyScene({...unresolved,stopRequested:true}).state,'stopping');
 assert.equal(tabbyScene(run({status:'Failed',result:{phase:'Refunded',terminal:true,success:false,chargedRaw:'10000',refundedRaw:'10000'}})).state,'refunded');
});
test('budget, gas and reward-token shortages offer different actions',()=>{
 assert.equal(tabbyScene(run({status:'Paused',reason:'HOSTED_GOAL_BUDGET_REQUIRED'})).requiredAction,'configure');
 assert.equal(tabbyScene(run({status:'Paused',reason:'HOSTED_WALLET_GAS_REQUIRED'})).requiredAction,'fund-gas');
 assert.equal(tabbyScene(run({action:'reward-task',status:'Paused',reason:'INFERENCE_FUNDING_REQUIRED'})).requiredAction,'play-game');
 assert.equal(tabbyScene(run({action:'credits',status:'Paused',reason:'REWARD_INSUFFICIENT_AVAILABLE_TOKENS'})).requiredAction,'play-game');
 assert.equal(tabbyScene(run({action:'metered-task',status:'Paused',reason:'ALLOWANCE_EXHAUSTED'})).requiredAction,undefined);
 assert.equal(tabbyScene(run({status:'Paused',reason:'INFERENCE_FUNDING_REQUIRED'})).requiredAction,'deposit');
 const funding=tabbyScene(run({activities:[event({scene:'funding',state:'confirmed',evidence:{creditAvailableRaw:'50000'}})]}));assert.equal(funding.objects.find(o=>o.id==='quota')?.detail,undefined);
});
test('legacy pending acceptance, settlement and refunds retain their distinct states',()=>{
 const result={phase:'AcceptPending',terminal:false,success:false,chargedRaw:'0',taskId:'42',acceptTxHash:hash};
 const pending=tabbyScene(run({action:'task',status:'Paused',result}));assert.equal(pending.scene,'task');assert.equal(pending.state,'waiting');assert.equal(pending.evidence.acceptTxHash,hash);
 const settlement={txHash:hash,block:{number:50,hash,timestamp:1},passed:false,loanStatus:'3',repaidRaw:'0',slashedRaw:'5000',residualRaw:'0'};
 const failed=tabbyScene(run({action:'task',status:'Failed',result:{...result,phase:'Failed',settlement}}));assert.equal(failed.scene,'settlement');assert.equal(failed.evidence.passed,false);assert.match(failed.label,/失败结算/);
 assert.equal(tabbyScene(run({status:'Paused',result:{...result,phase:'RefundPending'}})).state,'reconciling');
});
test('explicit candidates and selected service IDs map to built-in roles without inventing selection',()=>{
 const candidates=event({scene:'specialists',state:'started',evidence:{candidateIds:['abi-reader-v1','token-scanner-v1','tx-decoder-v1']}});
 const found=tabbyScene(run({activities:[candidates]}));assert.equal(found.objects.length,3);assert.equal(found.objects.some(o=>o.selected),false);assert.equal(found.selectedExpert,undefined);
 const selected=tabbyScene(run({activities:[event({...candidates,state:'selected',subject:{id:'abi-reader-v1',name:'ABI Reader & Explainer',kind:'specialist'}})]}));
 assert.equal(selected.objects.length,3);assert.equal(selected.objects.filter(o=>o.selected).length,1);assert.equal(selected.selectedExpert?.id,'abi-interact');
 assert.equal(tabbyScene(run({activities:[event({scene:'specialists',state:'selected',subject:{id:'writer',name:'Writer',kind:'specialist'}})]})).objects.length,1);
});
test('model waiting retains the selected role; revision never treats the original output as repaired',()=>{
 const mission={stage:'reviewing' as const,phases:[{name:'写作',taskType:'writer',goal:'报告',output:'原稿'}],calls:[]};
 const waiting=run({mission,activities:[event({scene:'specialists',state:'selected',phaseId:'phase-0',subject:{id:'writer',name:'Writer',kind:'specialist'}}),event({scene:'model',state:'waiting',phaseId:'phase-0',subject:{id:'kimi-k2.6',name:'Kimi K2.6',kind:'model'}},2)]});
 assert.equal(tabbyScene(waiting).selectedExpert?.id,'writer');assert.equal(tabbyScene(waiting).pose,'rest');assert.equal(tabbyScene(waiting).animated,true);assert.equal(expertAssignments(waiting).find(r=>r.id==='writer')?.waiting,true);
 const revision={...waiting,activities:[event({scene:'review',state:'revising',phaseId:'revision'})]};assert.equal(tabbyScene(revision).selectedExpert?.id,'writer');assert.equal(tabbyScene(revision).pose,'revise');assert.deepEqual(expertAssignments(revision).filter(r=>r.active).map(r=>r.id),['writer']);
 const secondReview={...waiting,activities:[event({scene:'model',state:'waiting',phaseId:'revision-review'})]};assert.equal(tabbyScene(secondReview).selectedExpert?.id,'reviewer');
});
test('historical events freeze motion and do not borrow later selection or financial snapshots',()=>{
 const records=run({activities:[event({scene:'model',state:'waiting',phaseId:'phase-0'}),event({scene:'specialists',state:'selected',phaseId:'phase-0',subject:{id:'writer',name:'Writer',kind:'specialist'}},2)]});
 const history=tabbySceneHistory(records);assert.equal(history[0].selectedExpert,undefined);assert.equal(history[1].selectedExpert?.id,'writer');assert.equal(history.every(s=>s.history&&!s.animated),true);
 assert.equal(tabbyScene(records,{disconnected:true}).animated,false);assert.match(tabbyScene(records,{disconnected:true}).label,/连接中断/);
});
test('game completion and losses do not create rewards; confirmed credits and cash stay distinct',()=>{
 for(const outcome of ['lost','no-reward'] as const){const scene=tabbyScene(run({action:'game',status:'Succeeded',activities:[event({scene:'game',state:'completed',evidence:{outcome,rewardRaw:'10000',creditsGranted:3000,txHash:hash}})]}));assert.equal(scene.objects.some(o=>o.id==='reward'),false);assert.equal(scene.evidence.rewardRaw,undefined);assert.equal(scene.evidence.creditsGranted,undefined);}
 const credits=tabbyScene(run({action:'game',status:'Succeeded',activities:[event({scene:'settlement',state:'confirmed',evidence:{creditsGranted:3000}})]}));assert.deepEqual(credits.objects.map(o=>o.kind),['quota']);assert.match(credits.label,/模型额度/);assert.equal(credits.evidence.txHash,undefined);
 const legacy=tabbyScene(run({action:'game',status:'Succeeded',result:{phase:'Complete',terminal:true,success:true,chargedRaw:'0',rewardRaw:'10000',txHash:hash}}));assert.equal(legacy.evidence.outcome,undefined);assert.equal(legacy.objects.some(o=>o.id==='reward'),true);
});
test('task settlement shows a verified reputation snapshot without inventing a delta or multiple transactions',()=>{
 const finance={status:'confirmed',observedAt:at,chainId:'10143',agentId:'1',wallet:'w',block:{number:51,hash,timestamp:1},cashRaw:'10000',debtRaw:'0',credit:{score:'570',tier:'C',tierCapRaw:'20000',feeBps:'1500',eligible:true,rejection:null},policy:{maxCashPerTxRaw:'0',maxDebtPerTxRaw:'0',maxDebtPerDayRaw:'0',ownerFrozen:false},counts:{repayments:'1',defaults:'0',mirrorRepayments:'1',successes:'1',mirrorDefaults:'0'},scannedTaskCount:1,ownedTaskCount:1} satisfies HostedFinance;
 const task=run({action:'task',status:'Succeeded',activities:[event({scene:'settlement',state:'confirmed',evidence:{txHash:hash,blockNumber:50,repaidRaw:'1000',residualRaw:'9000',passed:true}})]});
 const scene=tabbyScene(task,{finance});assert.equal(scene.objects.find(o=>o.id==='reputation')?.label,'REP 570');assert.equal(scene.evidence.txHash,hash);assert.match(scene.objects.find(o=>o.id==='reputation')?.detail??'',/不表示本次增长/);
 assert.equal(tabbyScene(task,{finance,history:true}).objects.find(o=>o.id==='reputation')?.name,'信誉待刷新');
 assert.equal(tabbyScene(run({status:'Succeeded',activities:[event({scene:'delivery',state:'completed'})]}),{finance}).objects.some(o=>o.kind==='reputation'),false);
});
test('practice match scenes follow the referee and never create a monetary reward',()=>{
 const match={id:'practice-1',game:'gomoku',mode:'challenge',status:'playing',version:1,createdAt:at,updatedAt:at,players:[],actor:0,deadline:null,config:{chips:1000,hands:1,actionTimeoutMs:1},outcome:null,yourSeat:1,gameView:null,logs:[]} satisfies PlayMatchView;
 assert.equal(practiceGameScene(match).state,'waiting');assert.equal(practiceGameScene({...match,actor:1}).state,'started');
 const finished=practiceGameScene({...match,status:'finished',outcome:{kind:'win',winner:1,reason:'FIVE_IN_A_ROW'}});assert.match(finished.label,/虚拟筹码/);assert.equal(finished.evidence.rewardRaw,undefined);assert.equal(finished.evidence.creditsGranted,undefined);
 assert.equal(practiceGameScene({...match,actor:null,yourSeat:null}).animated,false);assert.equal(practiceGameScene(match,{pending:true}).state,'reconciling');
});

test('a visitor without an agent waits for creation without a configuration action',()=>{
 const scene=tabbyScene(undefined,{ready:false});assert.equal(scene.scene,'onboarding');assert.equal(scene.label,'等待创建 Agent');assert.equal(scene.requiredAction,undefined);assert.equal(scene.animated,false);
});
