import test from 'node:test';
import assert from 'node:assert/strict';
import {expertAssignments} from '../lib/expert-assignments';
import type {HostedRun} from '../lib/hosted-client';
const run:HostedRun={requestId:'test',agentId:'test',action:'goal',status:'Running',createdAt:'',updatedAt:'',reservedRaw:'0',chargedRaw:'0',recoverable:false,mission:{stage:'executing',phases:[{name:'分析',taskType:'analyst',goal:'资料',output:'完成'},{name:'写作',taskType:'writer',goal:'文稿'}],calls:[]}};
test('mesh highlights only the role of the current executing phase',()=>{const roles=expertAssignments(run);assert.equal(roles[0].id,'writer');assert.deepEqual(roles.filter(r=>r.active).map(r=>r.id),['writer']);assert.equal(roles.find(r=>r.id==='analyst')?.used,1);});
test('stopping or paused requests cannot still show an executing expert',()=>{for(const r of [{...run,stopRequested:true},{...run,status:'Paused' as const}]){const roles=expertAssignments(r);assert.equal(roles.some(n=>n.active),false);assert.equal(roles.find(n=>n.id==='writer')?.halted,true);}});
test('review and revision-review calls belong to reviewer, not writer',()=>{const roles=expertAssignments({...run,mission:{...run.mission!,stage:'reviewing',calls:['review','revision-review'].map(stage=>({stage,model:'kimi-k2.6',chargedRaw:'10000',promptTokens:2,completionTokens:3}))}});assert.equal(roles[0].id,'reviewer');assert.equal(roles[0].used,2);assert.equal(roles.find(r=>r.id==='writer')?.used,0);});
test('idle and planning have no invented expert selection',()=>{assert.equal(expertAssignments().some(r=>r.active||r.used||r.halted),false);assert.equal(expertAssignments({...run,mission:{...run.mission!,stage:'planning'}}).some(r=>r.active),false);});
test('all imported specialists follow the real phase state, including paused executions',()=>{
 for(const id of ['abi-interact','gas-optimization','token-scan','tx-decode','yield-search']){
 const current:HostedRun={...run,mission:{stage:'executing',phases:[{name:id,taskType:id,goal:'source review'}],calls:[]}};
 const roles=expertAssignments(current);assert.equal(roles.length,9);assert.deepEqual(roles.filter(r=>r.active).map(r=>r.id),[id]);
 assert.equal(expertAssignments({...current,status:'Paused'}).find(r=>r.id===id)?.halted,true);
 }
});

test('external execution selects the real service identity and does not double count the internal role',()=>{
 const external={id:'external-writer-cheap',name:'Independent Writer',taskType:'writer',serviceId:'peer/writer',modelId:'cheap',provider:'0x'+'1'.repeat(40),priceRaw:'10000',reputation:{score:4.5,samples:4,source:'registry' as const}};
 const current:HostedRun={...run,mission:{stage:'executing',phases:[{name:'writing',taskType:'writer',goal:'facts',external}],calls:[]}};
 const roles=expertAssignments(current,[external]);assert.equal(roles[0].id,external.id);assert.equal(roles[0].active,true);
 assert.equal(roles.find(r=>r.id==='writer')?.active??false,false);
 const complete=expertAssignments({...current,status:'Succeeded',mission:{...current.mission!,stage:'completed',phases:[{...current.mission!.phases[0],output:'facts'}]}},[external]);
 assert.equal(complete.find(r=>r.id===external.id)?.used,1);assert.equal(complete.find(r=>r.id==='writer')?.used??0,0);
});
