import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,realpath,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHostedTaskFixture} from './task-fixture.js';
import {HostedGoalExecutor} from '../src/goals/executor.js';
import {Relay} from '../../provider-relay/src/relay.js';
import {createHttpServer} from '../../provider-relay/src/http.js';
import {Refunder} from '../../provider-relay/src/refunder.js';
import {specialistCases} from './specialist-cases.js';
import {specialistPrompt} from '../src/specialists/execution.js';
import {specialistSystem} from '../src/goals/commander.js';

// Opt-in live mode uses the configured local Magpie gateway, but payments remain
// on a fresh isolated Anvil chain. No existing Agent or Monad wallet is used.
const live=process.env.SPECIALIST_LIVE==='1';
test(`five specialists: ${live?'real Magpie':'controlled model'}, real cash receipts and idempotent recovery`,{timeout:1800000},async(t)=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'af-specialists-paid-')));
 const f=await createHostedTaskFixture(join(directory,'chain'));
 if(live)f.config.timeoutMs=120000;
 let selected:typeof specialistCases[number]=specialistCases[0],localCalls=0,dispatches=0,malformed=false;
 let upstream={name:'cheap',model:'physical-specialist',baseUrl:'http://127.0.0.1:9999/v1',key:'controlled'},responseModel=upstream.model;
 if(live){const gateway=JSON.parse(await readFile('demo-output/local-hosted-20261012/gateway/ready.json','utf8'));assert.equal(gateway.url,'http://127.0.0.1:3426/v1');upstream={name:'cheap',model:'cheap/kimi-k2.6',baseUrl:gateway.url,key:(await readFile(gateway.keyFile,'utf8')).trim()};responseModel='kimi-k2.6';}
 const relay=new Relay({...f.fx.relayConfig,dataDir:join(directory,'relay'),upstreamTimeout:120000,service:{id:'tabby/mission',model:'specialist-model',price:10000n,upstreams:[upstream]}},{provider:f.fx.f.provider,upstreamFetch:async(url,init)=>{
  dispatches++;localCalls++;const body=JSON.parse(String(init?.body));
  if(live)return fetch(url,init);
  if(localCalls===2)assert.equal(body.messages[0].content,specialistPrompt(selected.id,specialistSystem,"31337").system);
  const content=localCalls===1?JSON.stringify({phases:[{name:selected.id,taskType:selected.id,goal:selected.goal}]}):localCalls===2?(malformed?'not a JSON report':selected.output):JSON.stringify({passed:true,summary:'All supplied constraints checked',checks:['Supplied facts and limitations preserved']});
  return Response.json({model:upstream.model,choices:[{finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:21,completion_tokens:12,total_tokens:33}});
 }});
 await relay.initialize();const refunder=new Refunder(relay);await refunder.initialize();
 const server=createHttpServer(relay,refunder);server.listen(0,'127.0.0.1');await once(server,'listening');
 const evidence:any={version:1,startedAt:new Date().toISOString(),chainId:'31337',model:live?'kimi-k2.6 via Magpie':'controlled',boundary:'Isolated Anvil payments; not Monad receipts. Model review, not external fact verification.',cases:[]};
 const saveEvidence=async()=>{if(process.env.SPECIALIST_EVIDENCE){const file=resolve(process.env.SPECIALIST_EVIDENCE);await mkdir(dirname(file),{recursive:true});await writeFile(file,JSON.stringify(evidence,null,2));}};
 try{
  const cases=live?specialistCases.filter(s=>!process.env.SPECIALIST_ONLY||s.id===process.env.SPECIALIST_ONLY):[...specialistCases,{...specialistCases[1],invalid:true}];
  for(let i=0;i<cases.length;i++)await t.test(`${cases[i].id}${'invalid' in cases[i]?' rejects paid malformed output':''}`,async()=>{
   selected=cases[i];localCalls=0;malformed='invalid' in cases[i];
   const actor=await f.actor(5+i,'cheap',120000n);
   const provision=await f.executor.execute(actor.input('provision'));assert.equal(provision.success,true,JSON.stringify(provision));actor.agent.binding=provision.binding;actor.agent.status='Ready';
   const deposit=actor.input('deposit');deposit.run.amountRaw='80000';assert.equal((await f.executor.execute(deposit)).success,true);
   const input=actor.input('task');input.run.action='goal';input.run.goal=selected.goal;
   const goals=new HostedGoalExecutor({durationMs:600000,models:[{id:'cheap',relayUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat`,provider:f.fx.f.payee,priceRaw:'10000',service:'tabby/mission',model:'specialist-model',physicalModel:upstream.model,responseModel}]},f.config);
   const before=await f.fx.f.account.getFunction('cash').staticCall(actor.agent.binding!.agentId);
   const result=await goals.execute(input);
   const record:any={id:selected.id,requestId:input.run.requestId,agent:actor.agent,goal:selected.goal,result,receipts:[]};evidence.cases.push(record);await saveEvidence();
   assert.equal(result.terminal,true,JSON.stringify(result));
   assert.ok(result.mission!.phases.some(p=>p.taskType===selected.id));
   const specialistCall=result.mission!.calls.find(c=>c.serviceId===selected.serviceId)!;assert.ok(specialistCall);assert.equal(specialistCall.promptDigest,specialistPrompt(selected.id,specialistSystem,"31337").promptDigest);
   assert.equal(await f.fx.f.account.getFunction('cash').staticCall(actor.agent.binding!.agentId),before-BigInt(result.chargedRaw));
   for(const call of result.mission!.calls){
    assert.match(call.requestDigest!,/^0x[0-9a-f]{64}$/);assert.ok(call.promptTokens>0&&call.completionTokens>0);
    const receipt=await f.fx.f.provider.getTransactionReceipt(call.txHash!);assert.equal(receipt?.status,1);
    const payment=await f.fx.f.account.getFunction('getPayment').staticCall(call.paymentId!);assert.equal(payment.fromCash,10000n);assert.equal(payment.fromCredit,0n);
    record.receipts.push({...call,blockNumber:receipt!.blockNumber,status:receipt!.status});
   }
   const nonce=await f.fx.f.provider.getTransactionCount(actor.wallet.address),count=dispatches;
   assert.deepEqual(await goals.execute({...input,recover:true}),result);assert.equal(dispatches,count);assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address),nonce);
   record.replay={noNewPayment:true,noNewModelCall:true};await saveEvidence();
   if(malformed){assert.equal(result.success,false);assert.equal(result.reason,'HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID');assert.equal(result.chargedRaw,'20000');}
   else{assert.equal(result.success,true,JSON.stringify(result));assert.ok(result.mission!.review!.passed);assert.ok(result.mission!.answer);}
  });
 }finally{evidence.completedAt=new Date().toISOString();await saveEvidence();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});relay.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
