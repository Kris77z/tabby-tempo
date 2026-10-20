import {Interface} from 'ethers';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InferCredit,PaymentError } from '@agentfuel/sdk';
import {startFixture,body} from '../../sdk-standalone/fixture.mjs';
import {dispatchAdmission as publisherGuard} from '../worker.mjs';
import {dispatchAdmission as economicGuard,revalidateSettlement} from '../../economic-worker/controller.mjs';

test('actual SDK pending paid resume cannot dispatch after either consumer deadline; Delivered remains readable',async()=>{
 const f=await startFixture();let handle;const originalFetch=globalThis.fetch;let posts=0;
 const client=new InferCredit({...f.options,beforePayment:()=>{throw new PaymentError('BLOCKED','test')},onHandle:h=>{handle=h}});
 try{
 await assert.rejects(client.forTask('1').fetch(f.relayUrl,{body}),/test/);
 const provider={getBlock:async()=>({timestamp:Math.floor(Date.now()/1000)})},escrow={getTask:async()=>({status:2n,agentId:1n,deadline:BigInt(Math.floor(Date.now()/1000)+100)})};
 for(const mode of ['publisher','economic']){
 const state={policy:{startedAtMs:0,deadlineMs:Date.now()-1,totalSpendRaw:'10000'},spentRaw:'0',reservedRaw:'10000'};
 const p={manifest:{publication:{taskId:'1'}},handle};
 globalThis.fetch=async(input,init)=>{if(String(input).includes('/payments/'))return Response.json({state:'Paid'});if(String(input)===f.relayUrl && init?.headers?.['x-payment-id'])posts++;return originalFetch(input,init)};
 const guard=mode==='publisher'?h=>publisherGuard({agentId:'1',solveDeadlineMs:0},p.manifest,provider,escrow,state,async()=>{},h):h=>economicGuard(state,p,provider,escrow,async()=>{},h);
 const resumed=new InferCredit({...f.options,beforeDispatch:guard});
 try{await assert.rejects(resumed.resume(handle),e=>e.code==='DISPATCH_NOT_AUTHORIZED');}finally{resumed.close()}
 }
 assert.equal(posts,0);
 globalThis.fetch=originalFetch;f.setDelivered(handle);
 const cached=new InferCredit({...f.options,beforeDispatch:()=>assert.fail('cached delivery must skip new dispatch admission')});
 try{assert.equal((await cached.resume(handle)).result.mode,'fixture-only')}finally{cached.close()}
 }finally{globalThis.fetch=originalFetch;client.close();await f.close()}
});

test('economic guard treats malformed reservations as spent and rechecks persistence-time stop',async()=>{
 const h={quote:{paymentId:'same'},input:{agentId:'1'}};
 const state={policy:{startedAtMs:0,deadlineMs:Date.now()+100000,totalSpendRaw:'10000'},spentRaw:'0',reservedRaw:'10000'};
 const provider={getBlock:async()=>({timestamp:Math.floor(Date.now()/1000)})},escrow={getTask:async()=>({status:2n,agentId:1n,deadline:BigInt(Math.floor(Date.now()/1000)+100)})};
 const pending=()=>({manifest:{publication:{taskId:'1'}},handle:h});
 for(const prior of [null,false,{}, {paymentId:'different',attempts:1}])await assert.rejects(economicGuard(state,{...pending(),dispatchAdmission:prior},provider,escrow,async()=>{},h),e=>e.code==='DISPATCH_NOT_AUTHORIZED');
 const p=pending();await assert.rejects(economicGuard(state,p,provider,escrow,async()=>{state.sealed=true},h),e=>e.code==='DISPATCH_NOT_AUTHORIZED');
});

test('cold accounting revalidates canonical settlement and refund closure before history can advance',async()=>{
 const iface=new Interface(['event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)']);
 const address='0x'+'11'.repeat(20),verifier='0x'+'22'.repeat(20),txHash='0x'+'33'.repeat(32),blockHash='0x'+'44'.repeat(32);
 let status=3n,passed=true,from=verifier,currentBlock=blockHash;
 const logs=()=>{const e=iface.encodeEventLog(iface.getEvent('TaskSettled'),[1,passed,0,0,100]);return [{address,topics:e.topics,data:e.data}]};
 const provider={getTransactionReceipt:async()=>({hash:txHash,status:1,blockNumber:3,blockHash,logs:logs()}),getBlock:async()=>({hash:currentBlock}),getTransaction:async()=>({from,to:address})};
 const escrow={target:address,interface:iface,getTask:async()=>({agentId:1n,status,escrowBalance:0n})};
 const config={agentId:'1',verifier,escrow:address};
 const p={manifest:{publication:{taskId:'1'}},settlement:{txHash,blockHash,blockNumber:3},outcome:'succeeded',run:{taskId:'1',result:{settlement:{txHash},verdict:{taskId:'1',agentId:'1',passed:true,mode:'docker'}}},handle:{quote:{paymentId:'p',price:'100'}}};
 const history=[];await revalidateSettlement(config,p,provider,escrow,{});
 currentBlock='0x'+'55'.repeat(32);await assert.rejects(revalidateSettlement(config,p,provider,escrow,{}),/NONCANONICAL/);assert.equal(history.length,0);
 currentBlock=blockHash;from=address;await assert.rejects(revalidateSettlement(config,p,provider,escrow,{}),/MISMATCH/);from=verifier;
 const refund={...p,outcome:'refunded',refundResolution:{kind:'provider-full-refund-and-authorized-task-failure'}};passed=false;status=4n;
 const account={getPayment:async()=>({agentId:1n,taskId:0n,fromCredit:0n,fromCash:100n,refundedAmount:100n})};
 await revalidateSettlement(config,refund,provider,escrow,account);account.getPayment=async()=>({agentId:1n,taskId:0n,fromCredit:0n,fromCash:100n,refundedAmount:0n});
 await assert.rejects(revalidateSettlement(config,refund,provider,escrow,account),/REFUND_TERMINATION/);assert.equal(history.length,0);
});
