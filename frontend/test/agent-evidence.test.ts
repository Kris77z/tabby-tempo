import {test} from 'node:test';
import assert from 'node:assert/strict';
import {agentEvidence,roleCalls} from '../lib/agent-evidence';
import type {HostedRun} from '../lib/hosted-client';
const hash='0x'+'a'.repeat(64),other='0x'+'b'.repeat(64);
const run:HostedRun={requestId:'request',agentId:'mine',action:'goal',status:'Succeeded',createdAt:'2026-10-13',updatedAt:'2026-10-13',chargedRaw:'1',reservedRaw:'0',recoverable:false,result:{phase:'Complete',terminal:true,success:true,chargedRaw:'1',chainId:'10143',txHash:hash,paymentTxHash:hash},mission:{stage:'completed',phases:[{name:'Write',taskType:'writer',goal:'write'},{name:'Code',taskType:'coder',goal:'code'}],calls:[{stage:'phase-0',model:'model',chargedRaw:'1',promptTokens:1,completionTokens:2,txHash:hash},{stage:'review',model:'model',chargedRaw:'1',promptTokens:1,completionTokens:2,txHash:other},{stage:'revision',model:'model',chargedRaw:'1',promptTokens:1,completionTokens:2}]}};
test('proofs stay with their Agent and deduplicate hashes within a chain',()=>{const proofs=agentEvidence([run,{...run,agentId:'foreign',result:{...run.result!,txHash:'0x'+'c'.repeat(64)}}],'mine');assert.equal(proofs.length,2);assert.deepEqual(proofs.map(p=>p.hash),[hash,other]);});
test('role proofs use actual phase assignments and never inherit unrelated settlement',()=>{assert.deepEqual(agentEvidence([run],'mine','10143','reviewer').map(p=>p.hash),[other]);assert.equal(agentEvidence([run],'mine','10143','coder').length,0);assert.equal(roleCalls(run,'coder')[0].stage,'revision');assert.equal(roleCalls(run,'analyst').length,0);});
test('invalid hashes and missing transaction evidence do not create explorer links',()=>{assert.equal(agentEvidence([{...run,mission:undefined,result:{...run.result!,txHash:'invalid',paymentTxHash:undefined}}],'mine').length,0);});
test('imported expert payment and revision receipts stay scoped to the matching service',()=>{
 const ids=['abi-interact','gas-optimization','token-scan','tx-decode','yield-search'];
 for(const id of ids){const current:HostedRun={...run,mission:{stage:'completed',phases:[{name:id,taskType:id,goal:'source review'}],calls:[{...run.mission!.calls[0],stage:'phase-0'},{...run.mission!.calls[1],stage:'revision'},{...run.mission!.calls[0],stage:'review',txHash:'0x'+'c'.repeat(64)}]}};
 assert.deepEqual(agentEvidence([current],'mine','10143',id).map(p=>p.hash),[hash,other]);
 for(const otherId of ids.filter(x=>x!==id))assert.equal(roleCalls(current,otherId).length,0);
 }
});
