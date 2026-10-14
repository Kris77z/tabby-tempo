import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HostedGoalExecutor, type GoalCall, type GoalDependencies, type GoalState } from "../src/goals/executor.js";
import {validateHostedActivity,type HostedActivityInput} from "../src/scene-types.js";
import { inspectGoalArtifact } from "../src/goals/acceptance.js";
import { validateGoalView, validGoal } from "../src/goal-types.js";
import type { HostedExecution } from "../src/types.js";
import type { HostedTaskExecutorConfig } from "../src/task-executor.js";
const route={id:"cheap",relayUrl:"http://127.0.0.1:1234/v1/chat/completions",provider:"0x0000000000000000000000000000000000000001",priceRaw:"10000",service:"tabby/mission",model:"cheap",physicalModel:"physical"};
const plan=JSON.stringify({phases:[{name:"Analyze",taskType:"analyst",goal:"Find the key facts"},{name:"Write",taskType:"writer",goal:"Produce complete artifact"}]});
const review=JSON.stringify({passed:true,summary:"Covers the requested facts",checks:["Includes the two required facts"]});
function response(text:string):NonNullable<GoalCall['response']>{return{text,chargedRaw:"10000",promptTokens:13,completionTokens:7};}
async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),"hosted-goals-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const now=new Date().toISOString(),id=randomUUID();
  const input:HostedExecution={directory,keyFile:"unused",recover:false,agent:{id,owner:route.provider,wallet:route.provider,name:"Writer",modelId:"cheap",strategy:"balanced",perRunBudgetRaw:"100000",totalBudgetRaw:"200000",allowCredit:true,createdAt:now,updatedAt:now,status:"Ready",spentRaw:"0",reservedRaw:"100000",binding:{chainId:"31337",agentId:"42",wallet:route.provider}},run:{requestId:randomUUID(),agentId:id,action:"goal",goal:"Write a launch note using facts A and B",status:"Running",createdAt:now,updatedAt:now,reservedRaw:"100000",chargedRaw:"0",recoverable:false}};
  const executor=(deps:GoalDependencies)=>new HostedGoalExecutor({models:[route],durationMs:60000},{} as HostedTaskExecutorConfig,deps);
  return {input,executor,journal:()=>readFile(join(directory,"mission/session.json"),"utf8").then(s=>JSON.parse(s) as GoalState)};
}
const normal=(c:GoalCall)=>response(c.stage==="plan"?plan:c.stage==="review"?review:`Artifact for ${c.stage}`);
test("goal persists each specialist output, passes prior context, and runs a separate original-goal review",async t=>{
 const f=await fixture(t),calls:GoalCall[]=[],progress:string[]=[];
 f.input.progress=async v=>{progress.push(v.stage);};
 const e=f.executor({call:async(_s,c)=>{calls.push(structuredClone(c));return normal(c);}});
 const result=await e.execute(f.input);
 assert.equal(result.success,true);assert.equal(result.chargedRaw,"40000");
 assert.deepEqual(result.mission?.phases.map(p=>p.output),["Artifact for phase-0","Artifact for phase-1"]);
 assert.equal(result.mission?.review?.passed,true);
 assert.equal(JSON.parse(calls[2].messages[1].content).previous[0].output,"Artifact for phase-0");
 const reviewInput=JSON.parse(calls[3].messages[1].content);
 assert.equal(reviewInput.originalGoal,f.input.run.goal);assert.equal(reviewInput.artifact,"Artifact for phase-1");
 assert.notEqual(calls[2].messages[0].content,calls[3].messages[0].content);
 assert.ok(progress.includes("executing")&&progress.includes("reviewing"));
 assert.deepEqual(await e.execute({...f.input,recover:true}),result);assert.equal(calls.length,4);
});
test("different free-form goals reach the commander unchanged; mismatched recovery is rejected",async t=>{
 const f=await fixture(t);f.input.run.goal="帮我把这两条发布说明翻译成英文：甲，乙。";
 let received="";const e=f.executor({call:async(_s,c)=>{if(c.stage==="plan")received=c.messages[1].content;return normal(c);}});
 await e.execute(f.input);assert.equal(received,f.input.run.goal);
 await assert.rejects(e.execute({...f.input,run:{...f.input.run,goal:"another goal"},recover:true}),/HOSTED_GOAL_BINDING_CHANGED/);
});
test("budget bounds every additional purchase; completed phases remain available",async t=>{
 const f=await fixture(t);f.input.run.reservedRaw="20000";let count=0;
 const result=await f.executor({call:async(_s,c)=>{count++;return normal(c);}}).execute(f.input);
 assert.equal(result.terminal,true);assert.equal(result.success,false);assert.equal(result.reason,"HOSTED_GOAL_BUDGET_REQUIRED");assert.equal(result.chargedRaw,"20000");assert.equal(count,2);assert.equal(result.mission?.phases[0].output,"Artifact for phase-0");
});
test("unknown call keeps reservation and resumes exact messages without repurchasing completed stages",async t=>{
 const f=await fixture(t),attempts:string[]=[];let uncertain=true,savedMessages="";
 const e=f.executor({call:async(_s,c,_i,save)=>{attempts.push(c.stage);if(c.stage==="phase-1"){if(uncertain){savedMessages=JSON.stringify(c.messages);await save();throw new Error("connection lost");}assert.equal(JSON.stringify(c.messages),savedMessages);}return normal(c);}});
 const first=await e.execute(f.input);assert.equal(first.terminal,false);assert.equal(first.chargedRaw,"20000");
 uncertain=false;const final=await e.execute({...f.input,recover:true});assert.equal(final.success,true);assert.equal(final.chargedRaw,"40000");
 assert.deepEqual(attempts,["plan","phase-0","phase-1","phase-1","review"]);
});
test("cancellation after a known call terminates before any further purchase",async t=>{
 const f=await fixture(t);let cancelled=false,count=0;
 const result=await f.executor({control:async()=>({paused:false,cancelled}),call:async(_s,c)=>{count++;cancelled=true;return normal(c);}}).execute(f.input);
 assert.equal(result.terminal,true);assert.equal(result.phase,"Cancelled");assert.equal(result.chargedRaw,"10000");assert.equal(count,1);
});
test("cancellation cannot mark unresolved dispatch terminal; after reconciliation charges are retained",async t=>{
 const f=await fixture(t);let attempt=0,cancelled=false;
 const e=f.executor({control:async()=>({paused:false,cancelled}),call:async(_s,c)=>{attempt++;if(attempt===1)throw new Error("lost receipt");if(attempt===2)throw new Error("HOSTED_GOAL_CANCELLED");return normal(c);}});
 assert.equal((await e.execute(f.input)).terminal,false);cancelled=true;
 const unresolved=await e.execute({...f.input,recover:true});assert.equal(unresolved.terminal,false);assert.equal(unresolved.chargedRaw,"0");
 const reconciled=await e.execute({...f.input,recover:true});assert.equal(reconciled.phase,"Cancelled");assert.equal(reconciled.chargedRaw,"10000");assert.equal(attempt,3);
});
test("proved unpaid cancellation releases only the unconsumed reservation",async t=>{
 const f=await fixture(t);const r=await f.executor({call:async(_s,c,_i,save)=>{c.unpaid=true;await save();throw new Error("HOSTED_GOAL_CANCELLED");}}).execute(f.input);
 assert.equal(r.terminal,true);assert.equal(r.chargedRaw,"0");assert.equal(r.phase,"Cancelled");
});
test("rejected independent review never becomes a successful mission",async t=>{
 const f=await fixture(t);const r=await f.executor({call:async(_s,c)=>["review","revision-review"].includes(c.stage)?response(JSON.stringify({passed:false,summary:"Missing B",checks:["Fact B absent"]})):normal(c)}).execute(f.input);
 assert.equal(r.terminal,true);assert.equal(r.success,false);assert.equal(r.reason,"HOSTED_GOAL_REVIEW_FAILED");assert.equal(r.chargedRaw,"60000");
});
for(const [name,text,reason] of [["malformed paid plan","not JSON","HOSTED_GOAL_PLAN_INVALID"],["empty paid output","","HOSTED_GOAL_OUTPUT_INVALID"]])test(name,async t=>{
 const f=await fixture(t);const r=await f.executor({call:async()=>response(text)}).execute(f.input);
 assert.equal(r.terminal,true);assert.equal(r.success,false);assert.equal(r.reason,reason);assert.equal(r.chargedRaw,"10000");
});
test("confirmed payment with wrong provider model is accounted and fails",async t=>{
 const f=await fixture(t);const r=await f.executor({call:async()=>({...response("untrusted"),deliveryError:"HOSTED_GOAL_MODEL_CHANGED"})}).execute(f.input);
 assert.equal(r.terminal,true);assert.equal(r.success,false);assert.equal(r.chargedRaw,"10000");assert.equal(r.reason,"HOSTED_GOAL_MODEL_CHANGED");
});
test("missing inputs yield an explicit failed needs-input result rather than invented execution",async t=>{
 const f=await fixture(t);const r=await f.executor({call:async()=>response(JSON.stringify({needsInput:"Provide the source data; web tools are unavailable."}))}).execute(f.input);
 assert.equal(r.terminal,true);assert.equal(r.success,false);assert.equal(r.mission?.stage,"needs-input");assert.equal(r.chargedRaw,"10000");
});
test("public projection discards private fields and validates user goal text",()=>{
 assert.equal(validGoal("hello\nworld"),true);assert.equal(validGoal("\0"),false);assert.equal(validGoal(" "),false);
 const v=validateGoalView({stage:"planning",phases:[],calls:[],secret:"key"} as never);assert.equal("secret" in v,false);
 assert.throws(()=>validateGoalView({stage:"planning",phases:[],calls:[{stage:"a",model:"b",chargedRaw:"-1",promptTokens:0,completionTokens:0}]}));
});
test("explicit length and no-invented-date constraints override a rubber-stamp model review; revision is re-reviewed once",async t=>{
 const f=await fixture(t);f.input.run.goal="不超过20字，不编造额外数据。提供事实A和B的摘要。";const stages:string[]=[];
 const e=f.executor({call:async(_s,c)=>{stages.push(c.stage);if(c.stage==="plan")return response(JSON.stringify({phases:[{name:"Write",taskType:"writer",goal:"Write summary"}]}));if(c.stage==="phase-0")return response("A和B。".repeat(10)+"反馈截止4月5日。");if(c.stage==="revision"){assert.match(JSON.parse(c.messages[1].content).compressionTarget,/不超过 16 个/);return response("事实A和B的简短摘要。");}return response(review);}});
 const r=await e.execute(f.input);assert.equal(r.success,true);assert.equal(r.mission?.answer,"事实A和B的简短摘要。");assert.equal(r.chargedRaw,"50000");assert.deepEqual(stages,["plan","phase-0","review","revision","revision-review"]);
});
test("revision review must still run on recovery when initial model passed but deterministic checks failed",async t=>{
 const f=await fixture(t);f.input.run.goal="不超过10字的简报";let uncertain=true;const stages:string[]=[];
 const e=f.executor({call:async(_s,c)=>{stages.push(c.stage);if(c.stage==="plan")return response(JSON.stringify({phases:[{name:"Write",taskType:"writer",goal:"Write"}]}));if(c.stage==="phase-0")return response("超长报告".repeat(20));if(c.stage==="revision")return response("简报。");if(c.stage==="revision-review"&&uncertain)throw new Error("lost review");return response(review);}});
 assert.equal((await e.execute(f.input)).terminal,false);uncertain=false;
 const r=await e.execute({...f.input,recover:true});assert.equal(r.success,true);assert.equal(r.chargedRaw,"50000");assert.equal(stages.filter(s=>s==="revision-review").length,2);assert.equal(stages.filter(s=>s==="revision").length,1);
});
test("insufficient revision budget preserves a rejected result without extra spending",async t=>{
 const f=await fixture(t);f.input.run.reservedRaw="40000";f.input.run.goal="不超过10字的简报";let calls=0;
 const r=await f.executor({call:async(_s,c)=>{calls++;return normal(c);}}).execute(f.input);
 assert.equal(r.success,false);assert.equal(r.reason,"HOSTED_GOAL_REVIEW_FAILED");assert.equal(r.chargedRaw,"40000");assert.equal(calls,4);
});
test("deterministic acceptance counts Unicode characters, checks explicit limits and unsupported dates",()=>{
 assert.equal(inspectGoalArtifact("不超过3字","好😀呀").failures.length,0);
 assert.equal(inspectGoalArtifact("3字以内","好😀呀！").failures.length,1);
 assert.equal(inspectGoalArtifact("不编造数据，已有4月5日","新增4月6日").failures.length,1);
 assert.equal(inspectGoalArtifact("do not fabricate; at most 2 words","one two three").failures.length,1);
});
test('chain research is persisted before payment and never refetched during uncertain-call recovery',async t=>{
 const f=await fixture(t);f.input.run.goal='分析 0x'+'1'.repeat(40);const events:HostedActivityInput[]=[];f.input.activity=async e=>{events.push(validateHostedActivity(e));};
 const research={evidence:{version:1 as const,chainId:'31337',observedAt:new Date().toISOString(),digest:'0x'+'a'.repeat(64),records:[]},context:JSON.stringify({network:'31337',facts:'immutable snapshot'})};
 let lookups=0,phaseAttempts=0,plans=0;
 const deps:GoalDependencies={lookup:async()=>{lookups++;return research;},call:async(state,c)=>{
  assert.deepEqual(state.view.research,research.evidence);assert.equal(JSON.parse(c.messages[1].content).researchDigest,research.evidence.digest);
  if(c.stage==='plan'){plans++;return response(JSON.stringify({phases:[{name:'ABI',taskType:'abi-interact',goal:'analyze snapshot'}]}));}
  if(c.stage==='phase-0'&&++phaseAttempts===1)throw Error('network response lost');
  return response(c.stage==='review'?review:'Evidence-based analysis');
 }};
 const e=new HostedGoalExecutor({models:[route],durationMs:60000,chainLookup:true},{} as HostedTaskExecutorConfig,deps);
 assert.equal((await e.execute(f.input)).terminal,false);
 const done=await e.execute({...f.input,recover:true});assert.equal(done.success,true);assert.equal(lookups,1);assert.equal(plans,1);assert.equal(done.chargedRaw,'30000');
 assert.deepEqual(await e.execute({...f.input,recover:true}),done);assert.equal(lookups,1);assert.equal(phaseAttempts,2);assert.ok(events.some(e=>e.scene==='chain-lookup'&&e.state==='confirmed'&&e.evidence?.researchDigest===research.evidence.digest));
});

for(const cancel of [false,true])test(`expired payment resolves terminally with prior charges retained (stop=${cancel})`,async t=>{
 const f=await fixture(t);let expired=false,attempts=0;
 const e=f.executor({control:async()=>({paused:false,cancelled:cancel&&expired}),call:async(_s,c,_i,save)=>{attempts++;if(c.stage==='phase-0'){if(!expired)throw Error('unknown payment');c.recovery={chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true};await save();throw Error('HOSTED_GOAL_PAYMENT_VOIDED');}return normal(c);}});
 assert.equal((await e.execute(f.input)).terminal,false);expired=true;
 const result=await e.execute({...f.input,recover:true});assert.equal(result.terminal,true);assert.equal(result.chargedRaw,'10000');assert.equal(result.reason,'HOSTED_GOAL_PAYMENT_VOIDED');assert.equal(result.phase,cancel?'Cancelled':'Stopped');
 const count=attempts;assert.deepEqual(await e.execute({...f.input,recover:true}),result);assert.equal(attempts,count);
});


test("goal events expose real catalog selection, revision and review while keeping paid prompts private",async t=>{
 const f=await fixture(t),events:HostedActivityInput[]=[];f.input.activity=async event=>{events.push(validateHostedActivity(event));};
 const executor=f.executor({call:async(_s,c)=>c.stage==="review"?response(JSON.stringify({passed:false,summary:"Fix B",checks:["B absent"]})):c.stage==="revision-review"?response(review):normal(c)});
 const result=await executor.execute(f.input);assert.equal(result.success,true);
 assert.ok(events.some(e=>e.scene==="specialists"&&e.state==="started"&&e.evidence?.candidateIds?.includes("writer")));
 assert.deepEqual(events.filter(e=>e.scene==="specialists"&&e.state==="selected").map(e=>e.subject?.id),["analyst","writer"]);
 assert.ok(events.some(e=>e.scene==="review"&&e.state==="revising"));assert.ok(events.some(e=>e.phaseId==="revision-review"&&e.state==="confirmed"));
 assert.equal(JSON.stringify(events).includes("messages"),false);assert.equal(events.some(e=>e.scene==="credit"||e.scene==="settlement"||e.scene==="game"),false);
});
