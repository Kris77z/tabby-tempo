import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {missionSpecialists,resolveSpecialist,specialistOutputContract} from '../src/specialists/catalog.js';
import {specialistPrompt,normalizeSpecialistOutput} from '../src/specialists/execution.js';
import {specialistSystem,parseMissionPlan} from '../src/goals/commander.js';
import {HostedGoalExecutor} from '../src/goals/executor.js';
import {validateGoalView} from '../src/goal-types.js';
import {specialistCases} from './specialist-cases.js';
import type {HostedExecution} from '../src/types.js';
import type {HostedTaskExecutorConfig} from '../src/task-executor.js';
const route={id:'cheap',relayUrl:'http://127.0.0.1:1234/v1/chat',provider:'0x'+'1'.repeat(40),priceRaw:'10000',service:'tabby/mission',model:'cheap',physicalModel:'controlled'};
for(const sample of specialistCases)test(`${sample.id}: original prompt -> paid call contract -> output -> independent review -> evidence -> idempotent recovery`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'af-specialist-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const now=new Date().toISOString(),id=randomUUID();
 const input:HostedExecution={directory,keyFile:'unused',recover:false,agent:{id,owner:route.provider,wallet:route.provider,name:'test',modelId:'cheap',strategy:'balanced',perRunBudgetRaw:'120000',totalBudgetRaw:'1000000',allowCredit:false,createdAt:now,updatedAt:now,status:'Ready',spentRaw:'0',reservedRaw:'0',binding:{chainId:'31337',agentId:'42',wallet:route.provider}},run:{requestId:randomUUID(),agentId:id,action:'goal',goal:sample.goal,status:'Running',createdAt:now,updatedAt:now,reservedRaw:'120000',chargedRaw:'0',recoverable:false}};
 let calls=0;
 const executor=new HostedGoalExecutor({models:[route],durationMs:60000},{} as HostedTaskExecutorConfig,{call:async(_s,c)=>{calls++;if(c.stage==='review'){assert.equal(JSON.parse(c.messages[1].content).outputContract.serviceId,sample.serviceId);}if(c.stage==='phase-0'){assert.match(c.messages[0].content,new RegExp(sample.serviceId));assert.equal(c.serviceId,sample.serviceId);assert.equal(c.promptDigest,createHash('sha256').update(c.messages[0].content).digest('hex'));}return{text:c.stage==='plan'?JSON.stringify({phases:[{name:sample.id,taskType:sample.serviceId,goal:sample.goal}]}):c.stage==='phase-0'?sample.output:JSON.stringify({passed:true,summary:'Inputs respected',checks:['No invented live data']}),chargedRaw:'10000',promptTokens:10,completionTokens:20,paymentId:'0x'+'a'.repeat(64),txHash:'0x'+'b'.repeat(64)};}});
 const result=await executor.execute(input);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.mission?.phases[0].taskType,sample.id);assert.equal(result.mission?.calls[1].serviceId,sample.serviceId);assert.equal(result.mission?.calls[1].txHash,'0x'+'b'.repeat(64));assert.deepEqual(await executor.execute({...input,recover:true}),result);assert.equal(calls,3);
});
test('catalog uses exact source files and resolves every imported alias',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../src/specialists/monad-rebel/provenance.json',import.meta.url),'utf8'));
 for(const [file,hash] of Object.entries(manifest.sha256)){assert.equal(createHash('sha256').update(await readFile(new URL('../src/specialists/monad-rebel/'+file,import.meta.url))).digest('hex'),hash);}
 for(const role of missionSpecialists)for(const alias of role.aliases)assert.equal(parseMissionPlan(JSON.stringify({phases:[{name:'test',taskType:alias,goal:'read supplied data'}]})).phases[0].taskType,role.id);
 assert.equal(resolveSpecialist('external-unknown'),undefined);
});
test('structured specialists reject malformed and fallback reports instead of apparent success',()=>{
 for(const id of ['gas-optimization','token-scan']){assert.throws(()=>normalizeSpecialistOutput(id,'rate limit'),/SPECIALIST_OUTPUT_INVALID/);assert.throws(()=>normalizeSpecialistOutput(id,'{"fallback":{},"vulnerabilities":[]}'),/SPECIALIST_OUTPUT_INVALID/);}
 assert.equal(normalizeSpecialistOutput('gas-optimization','```json\n'+specialistCases[1].output+'\n```'),JSON.stringify(JSON.parse(specialistCases[1].output),null,2));
});
test('public evidence metadata is bounded and private fields are stripped',()=>{
 const call={stage:'phase-0',model:'cheap',chargedRaw:'1',promptTokens:1,completionTokens:1,serviceId:'abi-reader-v1',promptDigest:'a'.repeat(64),requestDigest:'0x'+'b'.repeat(64),secret:'hidden'};
 const view=validateGoalView({stage:'completed',phases:[],calls:[call]});assert.equal(view.calls[0].serviceId,call.serviceId);assert.equal(view.calls[0].requestDigest,call.requestDigest);assert.equal('secret' in view.calls[0],false);assert.throws(()=>validateGoalView({...view,calls:[{...call,promptDigest:'invalid'}]}));
 assert.match(specialistPrompt('yield-search',specialistSystem).system,/No arbitrary live lookup/);
});

test('Tempo effective specialist prompts override historical Monad assumptions without altering provenance',()=>{
 for(const role of missionSpecialists.filter(role=>role.directory)){
  const result=specialistPrompt(role.id,specialistSystem,'42431');
  assert.match(result.system,/Tempo Moderato, settlement and fee asset PathUSD/);
  assert.match(result.system,/Do not apply Monad gas-limit charging claims/);
  assert.match(result.system,/supplied, dated evidence/);
  assert.match(result.system,/no arbitrary RPC, Web, shell or transaction tools/);
  assert.match(result.system,/bounded read-only snapshot from its configured network and Sourcify/);
  assert.equal(result.promptDigest,createHash('sha256').update(result.system).digest('hex'));
  assert.notEqual(result.promptDigest,specialistPrompt(role.id,specialistSystem,'31337').promptDigest);
 }
});

test('token scan preserves missing evidence as unknown without permitting malformed reports',()=>{
 const contract=specialistOutputContract('token-scan');
 assert.match(contract.fields!.riskScore!,/null/);assert.match(contract.fields!.riskLevel!,/unknown/);assert.match(contract.fields!.tokenomics!,/boolean\|unknown/);
 assert.match(specialistPrompt('token-scan',specialistSystem,'42431').system,/riskScore may be null, riskLevel unknown, and tokenomics flags unknown/);
 const sample=JSON.parse(specialistCases.find(c=>c.id==='token-scan')!.output);
 sample.riskScore=null;sample.riskLevel='unknown';
 for(const key of ['isMintable','isPausable','hasBlacklist'])sample.tokenomics[key]='unknown';
 assert.deepEqual(JSON.parse(normalizeSpecialistOutput('token-scan',JSON.stringify(sample))),sample);
 for(const malformed of [{...sample,riskScore:'unknown'},{...sample,riskScore:101},{...sample,riskLevel:'assumed'},{...sample,tokenomics:{...sample.tokenomics,isMintable:0}}])assert.throws(()=>normalizeSpecialistOutput('token-scan',JSON.stringify(malformed)),/SPECIALIST_OUTPUT_INVALID/);
});
