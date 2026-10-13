import test from "node:test";
import assert from "node:assert/strict";
import { type JsonRpcProvider, ZeroAddress } from "ethers";
import { accountInterface, requestDigest, paymentId, EMPTY_AUTH, type PaymentHandle } from "@agentfuel/sdk";
import { reconcileGoalPayment } from "../src/goals/reconciliation.js";
import type { GoalState, GoalCall } from "../src/goals/executor.js";

test("canonical revert proves zero cost; missing or noncanonical receipt never releases an uncertain payment",async()=>{
 const account="0x0000000000000000000000000000000000000001",wallet="0x0000000000000000000000000000000000000002",provider="0x0000000000000000000000000000000000000003";
 const route={id:"cheap",relayUrl:"http://127.0.0.1:1234/v1/chat",provider,priceRaw:"10000",service:"tabby/mission",model:"logical",physicalModel:"physical"};
 const messages=[{role:"user",content:"goal"}],input={service:route.service,model:route.model,messages,max_completion_tokens:1024,thinking:{type:"disabled"},agentId:"42",taskId:"0"};
 const nonce="0x"+"ab".repeat(32),digest=requestDigest(input),id=paymentId("0",digest,nonce),txHash="0x"+"cd".repeat(32),blockHash="0x"+"ef".repeat(32);
 const handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:id,agentId:"42",taskId:"0",requestDigest:digest,serverNonce:nonce,service:route.service,model:route.model,price:route.priceRaw,payTo:provider,asset:ZeroAddress,chainId:"31337",account,quoteExpiry:"9999999999",createdBlock:1},creditNonce:"1",submission:{txHash,nonce:3,from:wallet}} as PaymentHandle;
 const state={route,input:{chainId:"31337",chainAgentId:"42",wallet}} as GoalState,call={messages,max_completion_tokens:1024,stage:"plan",handle} as GoalCall;
 let missing=false,canonical=true;
 const rpc={send:async()=>"0x7a69",call:async()=>accountInterface.encodeFunctionResult("getPayment",[[0n,0n,0n,0n,0n]]),getBlock:async(n:number|string)=>({number:n==="latest"?10:n,hash:canonical?blockHash:"0x"+"ff".repeat(32)}),getTransaction:async()=>({to:account,from:wallet,nonce:3,data:accountInterface.encodeFunctionData("payProvider",["42",provider,"10000",id,EMPTY_AUTH,"0x"]),value:0n}),getTransactionReceipt:async()=>missing?null:({hash:txHash,status:0,blockNumber:10,blockHash,logs:[]})} as unknown as JsonRpcProvider;
 assert.deepEqual(await reconcileGoalPayment(state,call,account,ZeroAddress,rpc),{chargedRaw:"0",refundedRaw:"0",resolved:true,reverted:true});
 missing=true;assert.equal(await reconcileGoalPayment(state,call,account,ZeroAddress,rpc),undefined);
 missing=false;canonical=false;await assert.rejects(reconcileGoalPayment(state,call,account,ZeroAddress,rpc),/HOSTED_GOAL_PAYMENT_UNCONFIRMED/);
});

test('expired unpaid signature remains reserved until its nonce is canonically consumed',async()=>{
 const {Wallet,keccak256}=await import('ethers'),wallet=Wallet.createRandom(),account='0x'+'1'.repeat(40),payee='0x'+'2'.repeat(40),blockHash='0x'+'3'.repeat(64);
 const route={id:'cheap',relayUrl:'http://127.0.0.1:1234/v1/chat',provider:payee,priceRaw:'10000',service:'tabby/mission',model:'logical',physicalModel:'physical'};
 const messages=[{role:'user',content:'goal'}],input={service:route.service,model:route.model,messages,max_completion_tokens:1024,thinking:{type:'disabled'},agentId:'42',taskId:'0'},serverNonce='0x'+'4'.repeat(64),digest=requestDigest(input),pid=paymentId('0',digest,serverNonce);
 const raw=await wallet.signTransaction({chainId:31337,nonce:3,to:account,gasLimit:200000,maxFeePerGas:2,maxPriorityFeePerGas:1,data:accountInterface.encodeFunctionData('payProvider',['42',payee,'10000',pid,EMPTY_AUTH,'0x'])});
 const handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:pid,agentId:'42',taskId:'0',requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:payee,asset:ZeroAddress,chainId:'31337',account,quoteExpiry:'100',createdBlock:1},creditNonce:'1',submission:{txHash:keccak256(raw),rawTransaction:raw,nonce:3,from:wallet.address}} as PaymentHandle;
 const state={route,input:{chainId:'31337',chainAgentId:'42',wallet:wallet.address}} as GoalState,call={messages,max_completion_tokens:1024,stage:'plan',handle} as GoalCall;
 let nonce=3,paid=false,reorg=false,blockReads=0,broadcasts=0,saved=false,loseResponse=true;
 const rpc={send:async()=> '0x7a69',call:async()=>accountInterface.encodeFunctionResult('getPayment',[[paid?42n:0n,0n,paid?10000n:0n,0n,0n]]),getBlock:async(n:any)=>{blockReads++;return {number:10,timestamp:200,hash:reorg&&blockReads>1?'0x'+'5'.repeat(64):blockHash}},getTransaction:async()=>null,getTransactionReceipt:async()=>null,getTransactionCount:async(_a:string,block:number)=>{assert.equal(block,10);return nonce;},getFeeData:async()=>({maxFeePerGas:10n,maxPriorityFeePerGas:2n}),broadcastTransaction:async(raw:string)=>{assert.equal(saved,true);assert.equal(raw,call.voidSubmission?.raw);broadcasts++;if(loseResponse)throw Error('timeout');nonce=4;return{wait:async()=>({status:1})};}} as unknown as JsonRpcProvider;
 assert.equal(await reconcileGoalPayment(state,call,account,ZeroAddress,rpc),undefined);
 nonce=4;assert.deepEqual(await reconcileGoalPayment(state,call,account,ZeroAddress,rpc),{chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true});
 paid=true;assert.equal(await reconcileGoalPayment(state,call,account,ZeroAddress,rpc),undefined);paid=false;
 blockReads=0;reorg=true;await assert.rejects(reconcileGoalPayment(state,call,account,ZeroAddress,rpc),/PAYMENT_UNCONFIRMED/);reorg=false;
 handle.submission!.from=payee;await assert.rejects(reconcileGoalPayment(state,call,account,ZeroAddress,rpc),/BINDING_CHANGED/);handle.submission!.from=wallet.address;
 const {voidExpiredGoalPayment}=await import('../src/goals/void-payment.js');
 nonce=3;handle.quote.quoteExpiry='300';assert.equal(await voidExpiredGoalPayment(state,call,account,ZeroAddress,rpc,wallet,async()=>{saved=true},100),undefined);assert.equal(broadcasts,0);handle.quote.quoteExpiry='100';
 assert.equal(await voidExpiredGoalPayment(state,call,account,ZeroAddress,rpc,wallet,async()=>{saved=true},100),undefined);assert.equal(broadcasts,1);
 const signedCancel=call.voidSubmission!.raw;
 loseResponse=false;assert.deepEqual(await voidExpiredGoalPayment(state,call,account,ZeroAddress,rpc,wallet,async()=>{throw Error('must reuse saved signature')},100),{chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true});
 assert.equal(call.voidSubmission!.raw,signedCancel);assert.equal(broadcasts,2);
 await voidExpiredGoalPayment(state,call,account,ZeroAddress,rpc,wallet,async()=>{},100);assert.equal(broadcasts,2);
 delete handle.submission;assert.deepEqual(await voidExpiredGoalPayment(state,call,account,ZeroAddress,rpc,wallet,async()=>{},100),{chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true});assert.equal(broadcasts,2);

});
