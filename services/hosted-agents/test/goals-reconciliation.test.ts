import test from "node:test";
import assert from "node:assert/strict";
import { type JsonRpcProvider, ZeroAddress, keccak256, toUtf8Bytes } from "ethers";
import { accountInterface, managerInterface, canonical, requestDigest, paymentId, EMPTY_AUTH, type PaymentHandle, type Json } from "@agentfuel/sdk";
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

function refundedFixture(){
 const hash=(n:number)=>"0x"+n.toString(16).padStart(64,"0"),account="0x"+"1".repeat(40),wallet="0x"+"2".repeat(40),provider="0x"+"3".repeat(40),manager="0x"+"4".repeat(40);
 const route={id:"cheap",relayUrl:"http://127.0.0.1:1234/v1/chat",provider,priceRaw:"10000",service:"tabby/mission",model:"logical",physicalModel:"physical"};
 const messages=[{role:"user",content:"goal"}],input={service:route.service,model:route.model,messages,max_completion_tokens:1024,thinking:{type:"disabled"},agentId:"42",taskId:"0"};
 const digest=requestDigest(input),serverNonce=hash(1),pid=paymentId("0",digest,serverNonce),paidHash=hash(2),refundHash=hash(3),refundId=hash(4),headHash=hash(5),paidBlock=hash(6),refundBlock=hash(7);
 const handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:pid,agentId:"42",taskId:"0",requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:provider,asset:ZeroAddress,chainId:"31337",account,quoteExpiry:"9999999999",createdBlock:1},creditNonce:"1",submission:{txHash:paidHash,nonce:3,from:wallet}} as PaymentHandle;
 const state={route,input:{chainId:"31337",chainAgentId:"42",wallet}} as GoalState,call={messages,max_completion_tokens:1024,stage:"plan",handle} as GoalCall;
 const event=(args:unknown[],address=manager)=>({address,...managerInterface.encodeEventLog(managerInterface.getEvent("RefundProcessed")!,args)});
 const chain={payment:[42n,0n,10000n,0n,10000n],consumed:true,headReads:0,reorg:false,reads:[] as {name:string;blockTag:unknown}[],refundReceipt:{hash:refundHash,status:1,blockNumber:8,blockHash:refundBlock,logs:[event([pid,refundId,10000n,0n,10000n])]} as any};
 const view:any={state:"Refunded",paymentId:pid,refundedAmount:"10000",upstreamAttempts:[],confirmedRefunds:[{refundId,amount:"10000",txHash:refundHash}]};
 const rpc={send:async(method:string)=>{assert.equal(method,"eth_chainId");return"0x7a69";},call:async(request:any)=>{
  const parsed=accountInterface.parseTransaction({data:request.data})!;chain.reads.push({name:parsed.name,blockTag:request.blockTag});
  if(parsed.name==="getPayment")return accountInterface.encodeFunctionResult("getPayment",[chain.payment]);
  if(parsed.name==="creditManager")return accountInterface.encodeFunctionResult("creditManager",[manager]);
  assert.equal(parsed.name,"refundConsumed");assert.equal(parsed.args[0],refundId);return accountInterface.encodeFunctionResult("refundConsumed",[chain.consumed]);
 },getBlock:async(n:any)=>({number:n==="latest"?10:n,timestamp:200,hash:n===7?paidBlock:n===8?refundBlock:n===10&&chain.reorg&&++chain.headReads>1?hash(99):headHash}),
 getTransaction:async()=>({to:account,from:wallet,nonce:3,data:accountInterface.encodeFunctionData("payProvider",["42",provider,"10000",pid,EMPTY_AUTH,"0x"]),value:0n}),
 getTransactionReceipt:async(id:string)=>id===paidHash?{hash:paidHash,status:1,blockNumber:7,blockHash:paidBlock,logs:[{address:account,...accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!,["42",provider,pid,10000n,0n])}]}:id===refundHash?chain.refundReceipt:null} as unknown as JsonRpcProvider;
 return{state,call,account,manager,view,chain,rpc,event,pid,refundId,refundHash,hash};
}

test("only explicit no-dispatch history plus a consumed full canonical refund resolves naturally",async t=>{
 let f=refundedFixture();t.mock.method(globalThis,"fetch",async()=>Response.json(f.view));
 const original=structuredClone(f.call);
 assert.deepEqual(await reconcileGoalPayment(f.state,f.call,f.account,ZeroAddress,f.rpc),{chargedRaw:"0",refundedRaw:"10000",resolved:true});
 assert.deepEqual(f.call,original);assert.deepEqual(f.chain.reads.map(r=>r.name),["getPayment","creditManager","refundConsumed"]);assert.ok(f.chain.reads.every(r=>r.blockTag===10));
 const malformed:{name:string;change:(f:ReturnType<typeof refundedFixture>)=>void}[]=[
  {name:"missing legacy history",change:f=>{delete f.view.upstreamAttempts;}},{name:"null history",change:f=>{f.view.upstreamAttempts=null;}},
  ...["Rejected","Unknown","Dispatching","Delivered"].map(state=>({name:state+" attempt",change:(f:ReturnType<typeof refundedFixture>)=>{f.view.upstreamAttempts=[{state}];}})),
  {name:"result",change:f=>{f.view.result=null;}},{name:"receipt",change:f=>{f.view.receipt={};}},
  {name:"local inference",change:f=>{f.call.inference={} as any;}},{name:"local response",change:f=>{f.call.response={} as any;}},
  {name:"operator resolution",change:f=>{f.view.operatorResolution={};}},{name:"delivered compensation",change:f=>{f.view.operatorCompensation={};}},
  {name:"partial view total",change:f=>{f.view.refundedAmount="9999";}},{name:"partial chain total",change:f=>{f.chain.payment[4]=9999n;}},
  {name:"other payment",change:f=>{f.view.paymentId=f.hash(100);}},{name:"Paid rather than Refunded",change:f=>{f.view.state="Paid";}},
  {name:"missing refund",change:f=>{f.view.confirmedRefunds=[];}},{name:"multiple refunds",change:f=>{f.view.confirmedRefunds.push({...f.view.confirmedRefunds[0]});}},
  {name:"partial refund",change:f=>{f.view.confirmedRefunds[0].amount="9999";}},{name:"invalid refund hash",change:f=>{f.view.confirmedRefunds[0].txHash="not-a-hash";}}
 ];
 for(const item of malformed)await t.test(item.name+" keeps the payment reserved",async()=>{f=refundedFixture();item.change(f);assert.deepEqual(await reconcileGoalPayment(f.state,f.call,f.account,ZeroAddress,f.rpc),{chargedRaw:"10000",refundedRaw:"0",resolved:false});});
});

test("natural refunds require one matching canonical manager event and on-chain consumption",async t=>{
 let f=refundedFixture();t.mock.method(globalThis,"fetch",async()=>Response.json(f.view));
 const cases:{name:string;change:(f:ReturnType<typeof refundedFixture>)=>void}[]=[
  {name:"missing receipt",change:f=>{f.chain.refundReceipt=null;}},{name:"reverted receipt",change:f=>{f.chain.refundReceipt.status=0;}},
  {name:"different receipt hash",change:f=>{f.chain.refundReceipt.hash=f.hash(91);}},{name:"future block",change:f=>{f.chain.refundReceipt.blockNumber=11;}},
  {name:"noncanonical refund block",change:f=>{f.chain.refundReceipt.blockHash=f.hash(92);}},{name:"unconsumed refund",change:f=>{f.chain.consumed=false;}},
  {name:"missing event",change:f=>{f.chain.refundReceipt.logs=[];}},{name:"duplicate event",change:f=>{f.chain.refundReceipt.logs.push(f.chain.refundReceipt.logs[0]);}},
  {name:"different manager",change:f=>{f.chain.refundReceipt.logs[0].address=f.account;}},
  ...["payment","refund","amount","debt","cash"].map((name,i)=>({name:"changed event "+name,change:(f:ReturnType<typeof refundedFixture>)=>{const args:unknown[]=[f.pid,f.refundId,10000n,0n,10000n];args[i]=i<2?f.hash(93):i===3?1n:9999n;f.chain.refundReceipt.logs=[f.event(args)];}})),
  {name:"head reorganization",change:f=>{f.chain.reorg=true;}}
 ];
 for(const item of cases)await t.test(item.name+" fails closed",async()=>{f=refundedFixture();item.change(f);assert.deepEqual(await reconcileGoalPayment(f.state,f.call,f.account,ZeroAddress,f.rpc),{chargedRaw:"10000",refundedRaw:"0",resolved:false});});
});

test("the existing Unknown operator resolution remains separate and Rejected-only history gains no permission",async t=>{
 let f=refundedFixture();t.mock.method(globalThis,"fetch",async()=>Response.json(f.view));
 const resolution=()=>({version:1,paymentId:f.pid,resolutionId:f.hash(80),expectedAttemptsDigest:keccak256(toUtf8Bytes(canonical(f.view.upstreamAttempts as Json))),evidenceDigest:f.hash(81),reason:"operator-accepted-nondelivery-cost",resolvedAt:1});
 f.view.upstreamAttempts=[{state:"Unknown"}];f.view.operatorResolution=resolution();
 assert.deepEqual(await reconcileGoalPayment(f.state,f.call,f.account,ZeroAddress,f.rpc),{chargedRaw:"0",refundedRaw:"10000",resolved:true});
 f=refundedFixture();f.view.upstreamAttempts=[{state:"Rejected"}];f.view.operatorResolution=resolution();
 assert.deepEqual(await reconcileGoalPayment(f.state,f.call,f.account,ZeroAddress,f.rpc),{chargedRaw:"10000",refundedRaw:"0",resolved:false});
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
