import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,realpath,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preserveTempoRuntimeSponsorship,tempoGoalConfig} from '../tempo-hosted-runtime.js';
import {validateHostedGoalConfig} from '../../services/hosted-agents/src/goals/executor.js';

test('upgrade preserves expired grant bytes and admissions across lost regenerated hosted config',async t=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'tempo-upgrade-')));t.after(()=>rm(directory,{recursive:true,force:true}));
 const origin='http://127.0.0.1:3028',file=join(directory,'authorization.json');
 const grant={version:1,id:randomUUID(),chainId:'42431',origin,asset:'0x20c0000000000000000000000000000000000000',owner:'0x'+'1'.repeat(40),issuedAtMs:Date.now()-3600000,expiresAtMs:Date.now()-60000,baselineGames:3,maxAdditionalGames:6,maxGameCalls:120,maxGameCompletionTokens:61440,maxCashRewardsRaw:'600000',actors:['usdc','llm-credits'].map((rewardKind,i)=>({hostedAgentId:randomUUID(),registryId:String(73+i),wallet:'0x'+String(i+2).repeat(40),rewardKind}))};
 const raw=JSON.stringify(grant),digest=createHash('sha256').update(raw).digest('hex');
 const primary={testSponsorship:{grant,digest,admissions:[{requestId:randomUUID(),ordinal:1}]},sponsoredTotal:7};
 await mkdir(join(directory,'hosted','database'),{recursive:true});
 const database=join(directory,'hosted','database','session.json');await writeFile(database,JSON.stringify(primary));await writeFile(file,raw,{mode:0o600});
 await writeFile(join(directory,'hosted.json'),JSON.stringify({hosted:{testSponsorshipFile:file}}));
 const original=await readFile(database,'utf8'),bound=await preserveTempoRuntimeSponsorship(directory,origin);
 assert.deepEqual(bound,{file,digest,grantId:grant.id});
 await writeFile(join(directory,'hosted.json'),JSON.stringify({hosted:{}}));
 assert.deepEqual(await preserveTempoRuntimeSponsorship(directory,origin,bound),bound);
 assert.equal(await readFile(database,'utf8'),original);assert.equal(await readFile(file,'utf8'),raw);
 await writeFile(file,raw+'\n',{mode:0o600});await assert.rejects(preserveTempoRuntimeSponsorship(directory,origin,bound),/BINDING_CHANGED/);
 await writeFile(file,raw,{mode:0o600});await writeFile(join(directory,'hosted.json'),JSON.stringify({hosted:{testSponsorshipFile:join(directory,'different.json')}}));
 await assert.rejects(preserveTempoRuntimeSponsorship(directory,origin,bound),/BINDING_CHANGED/);
});
test('runtime goal routes preserve original logical aliases and stable named ports without mutating existing ports',()=>{
 const catalog=[{id:'cheap',model:'cheap/kimi-k2.6',responseModel:'kimi-k2.6'},{id:'strong',model:'strong/kimi-k3',responseModel:'kimi-k3'}];
 const ports={arena:60100,underwriter:60101,fixed:60102,allowance:60103,planner:60104,goalCheap:60105,goalStrong:60106},before=structuredClone(ports);
 const config=validateHostedGoalConfig(tempoGoalConfig(catalog as any,ports,'0x'+'1'.repeat(40)));
 assert.deepEqual(config.models.map(m=>[m.id,m.model,m.physicalModel,m.responseModel,m.priceRaw]),[['kimi-k2.6','cheap','cheap/kimi-k2.6','kimi-k2.6','10000'],['kimi-k3','strong','strong/kimi-k3','kimi-k3','20000']]);
 assert.deepEqual(config.models.map(m=>m.relayUrl),['http://127.0.0.1:60105/v1/chat','http://127.0.0.1:60106/v1/chat']);assert.deepEqual(ports,before);
});
