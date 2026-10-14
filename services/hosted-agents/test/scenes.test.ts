import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,realpath,readFile,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Wallet} from "ethers";
import {HostedService} from "../src/service.js";
import {HOSTED_ACTIVITY_LIMIT,validateHostedActivity,type HostedActivityInput} from "../src/scene-types.js";
import type {AgentSettings,HostedExecution,HostedExecutor,HostedResult} from "../src/types.js";
const settings:AgentSettings={name:"Tabby",modelId:"cheap",strategy:"balanced",perRunBudgetRaw:"100",totalBudgetRaw:"1000",allowCredit:false};
const hex=`0x${"ab".repeat(32)}`;
async function fixture(t:any,execute:(input:HostedExecution)=>Promise<HostedResult>){
 const directory=await realpath(await mkdtemp(join(tmpdir(),"hosted-scenes-")));
 let identity=0;
 const executor:HostedExecutor={capabilities:{goals:{maxPhases:4,models:[{id:"cheap",pricePerCallRaw:"10"}]}},execute:async input=>input.run.action==="provision"?{phase:"Ready",terminal:true,success:true,chargedRaw:"0",binding:{chainId:"31337",agentId:String(++identity),wallet:input.agent.wallet}}:execute(input)};
 const config={directory,origin:"http://localhost:3020",chainId:"31337" as const,models:[{id:"cheap",label:"Cheap"}],maxAgentsPerOwner:5,maxTotalBudgetRaw:"1000",maxPerRunBudgetRaw:"100"};
 let service=await HostedService.open(config,executor);
 t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
 return {directory,get service(){return service;},restart:async()=>{await service.close();service=await HostedService.open(config,executor);},reopen:async()=>{service=await HostedService.open(config,executor);}};
}
const success:HostedResult={phase:"Completed",terminal:true,success:true,chargedRaw:"10"};
test("activity and goal projection writes are ordered, persisted, bounded and isolated by owner",async t=>{
 const f=await fixture(t,async input=>{
  await Promise.all([input.progress?.({stage:"planning",phases:[],calls:[]}),input.activity?.({scene:"specialists",state:"started",evidence:{candidateIds:["writer","analyst"]}})]);
  for(let i=0;i<HOSTED_ACTIVITY_LIMIT+5;i++)await input.activity?.({scene:"model",state:"waiting",phaseId:`call-${i}`,subject:{id:"cheap",name:"Cheap",kind:"model"}});
  return success;
 });
 const who=Wallet.createRandom().address,other=Wallet.createRandom().address;
 const agent=await f.service.create(who,{...settings,requestId:randomUUID()});await f.service.waitUntilIdle();
 const rid=randomUUID();await f.service.command(who,agent.id,{action:"goal",requestId:rid,goal:"Write a note"});await f.service.waitUntilIdle();
 const before=(await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)!;
 assert.equal(before.activities?.length,HOSTED_ACTIVITY_LIMIT);assert.ok(before.activities![0].seq>1);
 assert.equal(before.mission?.stage,"planning");assert.equal(before.activities?.at(-1)?.state,"completed");
 assert.deepEqual(before.activities!.map(e=>e.seq),Array.from({length:HOSTED_ACTIVITY_LIMIT},(_,i)=>before.activities![0].seq+i));
 assert.equal((await f.service.snapshot(other)).runs.length,0);
 await f.restart();assert.deepEqual((await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)?.activities,before.activities);
 assert.ok(before.activities!.every(e=>Number.isFinite(Date.parse(e.at))));
});
test("interruption, recovery and stop retain original sequence and close the active request only after outcome",async t=>{
 const f=await fixture(t,async input=>{
  await input.activity?.({scene:"model",state:"waiting",phaseId:"plan",evidence:{paymentId:hex}});
  return input.run.stopRequested?{phase:"Cancelled",terminal:true,success:false,chargedRaw:"10",reason:"HOSTED_GOAL_CANCELLED"}:{phase:"Paused",terminal:false,success:false,chargedRaw:"0",reason:"HOSTED_GOAL_RECONCILIATION_REQUIRED"};
 });
 const who=Wallet.createRandom().address,agent=await f.service.create(who,{...settings,requestId:randomUUID()});await f.service.waitUntilIdle();
 const rid=randomUUID();await f.service.command(who,agent.id,{action:"goal",requestId:rid,goal:"Write a note"});await f.service.waitUntilIdle();
 const before=(await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)!;assert.equal(before.activities?.at(-1)?.state,"reconciling");
 await f.service.close();
 const database=join(f.directory,"database/session.json"),state=JSON.parse(await readFile(database,"utf8"));state.runs.find((r:any)=>r.requestId===rid).status="Running";await writeFile(database,JSON.stringify(state));
 await f.reopen();let snapshot=await f.service.snapshot(who),run=snapshot.runs.find(r=>r.requestId===rid)!;
 assert.equal(run.activities?.at(-1)?.reason,"HOSTED_PROCESS_INTERRUPTED");assert.equal(run.activities?.at(-1)?.seq,before.activities!.at(-1)!.seq+1);assert.equal(snapshot.agents[0].activeRequestId,rid);
 await f.service.cancelGoal(who,agent.id,rid);await f.service.waitUntilIdle();snapshot=await f.service.snapshot(who);run=snapshot.runs.find(r=>r.requestId===rid)!;
 assert.ok(run.activities?.some(e=>e.state==="stopping"));assert.equal(run.activities?.at(-1)?.state,"cancelled");assert.equal(snapshot.agents[0].activeRequestId,undefined);assert.equal(snapshot.agents[0].spentRaw,"10");
});
test("activity whitelist rejects private fields, malformed subjects, receipts and untrusted types",async t=>{
 const good:HostedActivityInput={scene:"chain-lookup",state:"confirmed",evidence:{chainId:"31337",researchDigest:hex}};
 assert.deepEqual(validateHostedActivity(good),good);assert.equal(validateHostedActivity({...good,reason:"UPSTREAM_PRIVATE_PROVIDER_ERROR"}).reason,"HOSTED_ACTIVITY_UNCERTAIN");
 for(const value of [{...good,prompt:"secret"},{...good,evidence:{privateKey:"secret"}},{...good,subject:{id:"cheap",name:"Cheap",kind:"unknown"}},{...good,subject:{id:"cheap",name:"private\nkey",kind:"model"}},{...good,evidence:{txHash:"invalid"}},{...good,evidence:{candidateIds:new Array(33).fill("writer")}},{...good,reason:"upstream secret"}])assert.throws(()=>validateHostedActivity(value),/HOSTED_ACTIVITY_INVALID/);
 const f=await fixture(t,async input=>{await input.activity?.({...good,evidence:{privateKey:"secret"}} as any);return success;});
 const who=Wallet.createRandom().address,agent=await f.service.create(who,{...settings,requestId:randomUUID()});await f.service.waitUntilIdle();await f.service.command(who,agent.id,{action:"goal",requestId:randomUUID(),goal:"A note"});await f.service.waitUntilIdle();
 const snapshot=await f.service.snapshot(who);assert.equal(snapshot.runs[0].status,"Paused");assert.equal(snapshot.runs[0].activities?.at(-1)?.reason,"HOSTED_ACTIVITY_INVALID");assert.equal(JSON.stringify(snapshot).includes("secret"),false);
});
test("terminal scenes retain actual business evidence and distinguish missing inputs and no game reward",async t=>{
 const f=await fixture(t,async input=>input.run.action==="game"?{phase:"Succeeded",terminal:true,success:true,chargedRaw:"0",matchId:`hosted-${input.run.requestId}`,rewardRaw:"0"}:input.run.action==="reward-task"?{phase:"Paused",terminal:false,success:false,chargedRaw:"0",reason:"INFERENCE_FUNDING_REQUIRED"}:{phase:"Stopped",terminal:true,success:false,chargedRaw:"10",reason:"HOSTED_GOAL_NEEDS_INPUT"});
 const who=Wallet.createRandom().address,agent=await f.service.create(who,{...settings,modelId:"cheap",requestId:randomUUID()});await f.service.waitUntilIdle();
 let snapshot=await f.service.snapshot(who);assert.equal(snapshot.runs[0].activities?.at(-1)?.scene,"onboarding");assert.equal(snapshot.runs[0].activities?.at(-1)?.evidence?.agentId,"1");
 const rid=randomUUID();await f.service.command(who,agent.id,{action:"game",requestId:rid,rewardKind:"usdc"});await f.service.waitUntilIdle();
 snapshot=await f.service.snapshot(who);const end=snapshot.runs.find(r=>r.requestId===rid)!.activities!.at(-1)!;assert.equal(end.scene,"game");assert.equal(end.evidence?.outcome,"no-reward");assert.equal(end.state,"completed");
 const goal=randomUUID();await f.service.command(who,agent.id,{action:"goal",requestId:goal,goal:"A note"});await f.service.waitUntilIdle();
 const blocked=(await f.service.snapshot(who)).runs.find(r=>r.requestId===goal)!.activities!.at(-1)!;assert.equal(blocked.requiredAction,"provide-input");assert.equal(blocked.state,"blocked");
});


test("terminal game projection preserves observed loss while keeping zero reward explicit",async t=>{
 const f=await fixture(t,async input=>{const matchId=`hosted-${input.run.requestId}`;await input.activity?.({scene:"game",state:"completed",evidence:{matchId,outcome:"lost"}});return {phase:"Succeeded",terminal:true,success:true,chargedRaw:"0",matchId,rewardRaw:"0"};});
 const who=Wallet.createRandom().address,agent=await f.service.create(who,{...settings,requestId:randomUUID()});await f.service.waitUntilIdle();const rid=randomUUID();await f.service.command(who,agent.id,{action:"game",rewardKind:"usdc",requestId:rid});await f.service.waitUntilIdle();
 const end=(await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)!.activities!.at(-1)!;assert.equal(end.scene,"game");assert.equal(end.evidence?.outcome,"lost");assert.equal(end.evidence?.rewardRaw,"0");
});


test("funding blockers keep cash, gas and underwriting distinct and late callbacks cannot revive a terminal run",async t=>{
 let reason="CASH_REQUIRED",lastInput:HostedExecution|undefined;
 const f=await fixture(t,async input=>{lastInput=input;return {phase:"Stopped",terminal:true,success:false,chargedRaw:"0",reason};});
 const who=Wallet.createRandom().address,agent=await f.service.create(who,{...settings,requestId:randomUUID()});await f.service.waitUntilIdle();
 for(const [code,scene,action] of [["CASH_REQUIRED","funding","deposit"],["HOSTED_WALLET_GAS_REQUIRED","funding","fund-gas"],["AUTHORIZATION_REJECTED","credit",undefined]] as const){reason=code;const rid=randomUUID();await f.service.command(who,agent.id,{action:"goal",requestId:rid,goal:"A note"});await f.service.waitUntilIdle();const before=(await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)!;assert.equal(before.activities!.at(-1)!.scene,scene);assert.equal(before.activities!.at(-1)!.requiredAction,action);assert.equal(before.activities!.at(-1)!.state,"blocked");await lastInput!.activity?.({scene:"model",state:"started"});assert.deepEqual((await f.service.snapshot(who)).runs.find(r=>r.requestId===rid)?.activities,before.activities);}
});
