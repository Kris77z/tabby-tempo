import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet,Interface,Transaction,keccak256,ZeroAddress,type JsonRpcProvider} from 'ethers';
import {accountInterface,requestDigest,paymentId,EMPTY_AUTH,type PaymentHandle} from '@agentfuel/sdk';
import {fixture,startAnvil,stopAnvil,key} from '../../underwriter/test/fixture.js';
import {voidExpiredGoalPayment} from '../src/goals/void-payment.js';
import {TEMPO_PATH_USD,TEMPO_FEE_MANAGER} from '../../../scripts/tempo-config.js';
import type {GoalState,GoalCall} from '../src/goals/executor.js';
async function goal(wallet:Pick<Wallet,'address'|'signTransaction'>,account:string,payee:string,chainId:string,nonce:number,asset:string,gasLimit=200000n){
 const route={id:'cheap',relayUrl:'http://127.0.0.1:9/v1/chat',provider:payee,priceRaw:'10000',service:'tabby/mission',model:'logical',physicalModel:'physical'};
 const messages=[{role:'user',content:'goal'}],input={service:route.service,model:route.model,messages,max_completion_tokens:1024,thinking:{type:'disabled'},agentId:'1',taskId:'0'},serverNonce='0x'+'4'.repeat(64),digest=requestDigest(input),pid=paymentId('0',digest,serverNonce);
 const raw=await wallet.signTransaction({type:2,chainId,nonce,to:account,gasLimit,maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,data:accountInterface.encodeFunctionData('payProvider',['1',payee,'10000',pid,EMPTY_AUTH,'0x'])});
 const handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:pid,agentId:'1',taskId:'0',requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:payee,asset,chainId,account,quoteExpiry:'100',createdBlock:1},creditNonce:'1',submission:{txHash:keccak256(raw),rawTransaction:raw,nonce,from:wallet.address}} as PaymentHandle;
 return {state:{route,input:{chainId,chainAgentId:'1',wallet:wallet.address}} as GoalState,call:{messages,max_completion_tokens:1024,stage:'plan',handle} as GoalCall};
}
test('Anvil lost broadcast response restores only the persisted replacement; original payment may win the nonce race',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'af-goal-void-')),local=await startAnvil();let f:Awaited<ReturnType<typeof fixture>>|undefined;
 try{
  f=await fixture(local.rpc,directory,6);const rpc=f.provider,wallet=new Wallet(key(2),rpc),account=await f.account.getAddress(),asset=await f.token!.getAddress();
  await t.test('transport loss before node acceptance and restart reuse the same signature, never buy inference',async()=>{
   const {state,call}=await goal(wallet,account,f!.payee,'31337',await rpc.getTransactionCount(wallet.address),asset);
   const broadcast=rpc.broadcastTransaction.bind(rpc);let saved=0,sends=0,savedRaw='';
   rpc.broadcastTransaction=async raw=>{sends++;assert.equal(String(raw),savedRaw);if(sends===1)throw Error('lost broadcast response');return broadcast(raw);};
   try{
    assert.equal(await voidExpiredGoalPayment(state,call,account,asset,rpc,wallet,async()=>{saved++;savedRaw=call.voidSubmission!.raw;},1000),undefined);
    const restored=structuredClone(call);assert.equal(saved,1);
    assert.deepEqual(await voidExpiredGoalPayment(state,restored,account,asset,rpc,wallet,async()=>{throw Error('must not re-sign');},1000),{chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true});
    assert.equal(restored.voidSubmission!.raw,savedRaw);assert.equal(sends,2);
    await voidExpiredGoalPayment(state,restored,account,asset,rpc,wallet,async()=>{throw Error('terminal replay');},1000);assert.equal(sends,2);
    assert.equal((await f!.account.getFunction('getPayment').staticCall(call.handle!.quote.paymentId)).fromCash,0n);
   }finally{rpc.broadcastTransaction=broadcast;}
  });
  await t.test('original payment wins after the replacement is saved, canonical charge remains unresolved',async()=>{
   const {state,call}=await goal(wallet,account,f!.payee,'31337',await rpc.getTransactionCount(wallet.address),asset);
   const broadcast=rpc.broadcastTransaction.bind(rpc);let saves=0,sends=0;
   rpc.broadcastTransaction=async _raw=>{sends++;await(await broadcast(call.handle!.submission!.rawTransaction!)).wait();throw Error('nonce already consumed by original');};
   try{
    const result=await voidExpiredGoalPayment(state,call,account,asset,rpc,wallet,async()=>{saves++;},1000);
    assert.deepEqual(result,{chargedRaw:'10000',refundedRaw:'0',resolved:false});assert.equal(saves,1);assert.equal(sends,1);
    const nonce=await rpc.getTransactionCount(wallet.address);
    assert.deepEqual(await voidExpiredGoalPayment(state,call,account,asset,rpc,wallet,async()=>{throw Error('no new signature');},1000),result);
    assert.equal(await rpc.getTransactionCount(wallet.address),nonce);assert.equal(sends,1);assert.equal(call.inference,undefined);
   }finally{rpc.broadcastTransaction=broadcast;}
  });
 }finally{if(f)await f.close();await stopAnvil(local.child);await rm(directory,{recursive:true,force:true});}
});
test('Tempo replacement estimates gas and guards mutable fee preference on every persisted-byte rebroadcast',async()=>{
 const wallet=Wallet.createRandom(),account='0x'+'1'.repeat(40),payee='0x'+'2'.repeat(40),blockHash='0x'+'3'.repeat(64);
 const {state,call}=await goal(wallet,account,payee,'42431',3,TEMPO_PATH_USD);
 const token=new Interface(['function decimals() view returns(uint8)','function symbol() view returns(string)','function balanceOf(address) view returns(uint256)']),manager=new Interface(['function userTokens(address) view returns(address)']);
 let preference=ZeroAddress,broadcasts=0,saves=0,estimates=0,nonce=3;
 const rpc={send:async()=> '0xa5bf',call:async(tx:any)=>{if(tx.to.toLowerCase()===TEMPO_PATH_USD){const fn=token.parseTransaction({data:tx.data})!.name;return token.encodeFunctionResult(fn,[({decimals:6,symbol:'PathUSD',balanceOf:1000000} as any)[fn]]);}if(tx.to.toLowerCase()===TEMPO_FEE_MANAGER)return manager.encodeFunctionResult('userTokens',[preference]);return accountInterface.encodeFunctionResult('getPayment',[[0n,0n,0n,0n,0n]]);},getBlock:async()=>({number:10,timestamp:200,hash:blockHash}),getTransaction:async()=>null,getTransactionReceipt:async()=>null,getTransactionCount:async()=>nonce,getFeeData:async()=>({maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000_000n}),estimateGas:async()=>{estimates++;return 50000n;},broadcastTransaction:async(raw:string)=>{broadcasts++;assert.equal(raw,call.voidSubmission?.raw);throw Error('lost transport');}} as unknown as JsonRpcProvider;
 assert.equal(await voidExpiredGoalPayment(state,call,account,TEMPO_PATH_USD,rpc,wallet,async()=>{saves++;},100),undefined);
 const raw=call.voidSubmission!.raw;assert.equal(Transaction.from(raw).gasLimit,60000n);assert.equal(broadcasts,1);assert.equal(saves,1);
 preference=payee;
 assert.equal(await voidExpiredGoalPayment(state,call,account,TEMPO_PATH_USD,rpc,wallet,async()=>{throw Error('no resign');},100),undefined);
 assert.equal(broadcasts,1);assert.equal(estimates,1);assert.equal(call.voidSubmission!.raw,raw);
 nonce=4;assert.deepEqual(await voidExpiredGoalPayment(state,call,account,TEMPO_PATH_USD,rpc,wallet,async()=>{},100),{chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true});
});
