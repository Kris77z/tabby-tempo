import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Interface, Wallet, keccak256 } from "ethers";
import { InferCredit, PaymentError, accountInterface, requestDigest, paymentId, EMPTY_AUTH, type PaymentHandle } from "@agentfuel/sdk";
import { fixture, startAnvil, stopAnvil, key, tx } from "../../underwriter/test/fixture.js";
import { HostedGoalExecutor, type GoalState, type GoalCall, type GoalModelRoute } from "../src/goals/executor.js";
import { paidGoalCall } from "../src/goals/payment.js";
import { voidExpiredGoalPayment } from "../src/goals/void-payment.js";
import type { HostedExecution } from "../src/types.js";
import type { HostedTaskExecutorConfig } from "../src/task-executor.js";

const abi=new Interface(["function setPolicy(uint256,tuple(uint256 maxCashPerTx,uint256 maxDebtPerTx,uint256 maxDebtPerDay,bool ownerFrozen))"]);
const root=fileURLToPath(new URL("../../../",import.meta.url));
type Policy=NonNullable<GoalCall['policy']>;

// The installed guard remains unchanged: exercise it with the actual mission
// journal, inside its own isolated synthetic state fixture.
function guardCode(state:GoalState){
  const code=`import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('policy_guard_test',Path(sys.argv[1])/'deploy/tempo-vps/cicd/test/test_state_guard.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=m.GuardTest();f.setUp()
try:
 f.put('runtime/hosted/agents/a/runs/b/mission/session.json',json.load(sys.stdin))
 try:m.guard.require_quiescent(f.capture());print('ACCEPTED')
 except m.guard.StateError as e:print(e.code)
finally:f.doCleanups()
`;
  const result=spawnSync("python3",["-c",code,root],{input:JSON.stringify(state),encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);return result.stdout.trim();
}

test("saved policy recovery binds original signatures and never writes while stopping or awaiting confirmation",{timeout:120000},async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"hosted-goal-policy-"))),local=await startAnvil();
  let f:Awaited<ReturnType<typeof fixture>>|undefined;
  const methods:string[]=[],relayPaths:string[]=[];let drop:"before"|"after"|undefined,reorg=false,relayRequests=0;
  const proxy=createServer(async(req,res)=>{
    try{
      let raw="";for await(const part of req)raw+=part;
      const body=JSON.parse(raw),requests=Array.isArray(body)?body:[body];methods.push(...requests.map((r:{method:string})=>r.method));
      const send=requests.find((r:{method:string})=>r.method==="eth_sendRawTransaction");
      if(send&&drop==="before"){drop=undefined;res.setHeader("content-type","application/json");res.end(JSON.stringify({jsonrpc:"2.0",id:send.id,error:{code:-32000,message:"synthetic transport loss before acceptance"}}));return;}
      const response=await fetch(local.rpc,{method:"POST",headers:{"content-type":"application/json"},body:raw});
      let value=await response.json() as any;
      if(send&&drop==="after"){drop=undefined;value={jsonrpc:"2.0",id:send.id,error:{code:-32000,message:"synthetic transport loss after acceptance"}};}
      if(reorg){for(const item of Array.isArray(value)?value:[value])if(item.result?.transactions&&item.result.hash)item.result.hash="0x"+"f".repeat(64);}
      res.setHeader("content-type","application/json");res.end(JSON.stringify(value));
    }catch{res.writeHead(500);res.end();}
  });
  const relay=createServer((req,res)=>{relayRequests++;relayPaths.push(req.url??"");res.writeHead(503);res.end();});
  try{
    f=await fixture(local.rpc,directory,6);
    proxy.listen(0,"127.0.0.1");relay.listen(0,"127.0.0.1");await Promise.all([once(proxy,"listening"),once(relay,"listening")]);
    const rpcUrlFile=join(directory,"rpc-url"),keyFile=join(directory,"agent.key"),wallet=new Wallet(key(2),f.provider),account=await f.account.getAddress();
    await writeFile(rpcUrlFile,`http://127.0.0.1:${(proxy.address() as {port:number}).port}`,{mode:0o600});await writeFile(keyFile,key(2),{mode:0o600});
    const route:GoalModelRoute={id:"cheap",relayUrl:`http://127.0.0.1:${(relay.address() as {port:number}).port}/v1/chat`,provider:f.payee,priceRaw:"10000",service:"tabby/mission",model:"logical",physicalModel:"controlled"};
    const config={rpcUrlFile,rpcTransport:"direct",timeoutMs:200,models:[{templates:{conservative:{account,asset:await f.token!.getAddress(),chainId:"31337"}}}]} as unknown as HostedTaskExecutorConfig;
    const signed=async(change:{signer?:Wallet;chainId?:number;to?:string;agentId?:string;limit?:string;frozen?:boolean;gasLimit?:bigint}={}):Promise<Policy>=>{
      const raw=await(change.signer??wallet).signTransaction({type:2,chainId:change.chainId??31337,nonce:await f!.provider.getTransactionCount(wallet.address),to:change.to??account,value:0n,gasLimit:change.gasLimit??200000n,maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,data:abi.encodeFunctionData("setPolicy",[change.agentId??"1",{maxCashPerTx:change.limit??"100000",maxDebtPerTx:0,maxDebtPerDay:0,ownerFrozen:change.frozen??false}])});
      return{raw,hash:keccak256(raw)};
    };
    const mission=async(options:{policy?:Policy;legacy?:boolean;expired?:boolean;models?:GoalModelRoute[];seed?:boolean;reserve?:string;seedCall?:(state:GoalState,call:GoalCall)=>Promise<void>}={})=>{
      const now=new Date().toISOString(),id=randomUUID(),runId=randomUUID(),runDirectory=join(directory,"runs",runId),reserve=options.reserve??"100000";
      const input:HostedExecution={directory:runDirectory,keyFile,recover:false,agent:{id,owner:wallet.address,wallet:wallet.address,name:"Policy test",modelId:options.models?.[0].id??route.id,strategy:"balanced",perRunBudgetRaw:reserve,totalBudgetRaw:reserve,allowCredit:false,createdAt:now,updatedAt:now,status:"Ready",spentRaw:"0",reservedRaw:reserve,binding:{chainId:"31337",agentId:"1",wallet:wallet.address}},run:{requestId:runId,agentId:id,action:"goal",goal:"Write supplied facts A and B",status:"Running",createdAt:now,updatedAt:now,reservedRaw:reserve,chargedRaw:"0",recoverable:false}};
      let seeded=false,paused=false,cancelled=false;
      const executor=new HostedGoalExecutor({models:options.models??[route],durationMs:60000},config,{control:async()=>({paused,cancelled}),call:async(state,call,execution,save)=>{
        if(options.seed!==false&&!seeded){seeded=true;if(options.policy){if(options.legacy)state.policy=structuredClone(options.policy);else call.policy=structuredClone(options.policy);}await options.seedCall?.(state,call);if(options.expired)state.deadlineMs=Date.now()-1;await save();throw Error("HOSTED_GOAL_POLICY_UNCERTAIN");}
        return paidGoalCall(config,state,call,execution,save,async()=>({paused,cancelled}));
      }});
      const read=async()=>JSON.parse(await readFile(join(runDirectory,"mission/session.json"),"utf8")) as GoalState;
      return{input,executor,read,stop:(kind:"cancel"|"pause"|"deadline")=>{cancelled=kind==="cancel";paused=kind==="pause";},resume:()=>executor.execute({...input,recover:true})};
    };
    for(const legacy of [false,true])for(const kind of ["cancel","pause","deadline"] as const)await t.test(`${legacy?"legacy state":"per-call"} pending policy ${kind} stays nonterminal and guard-blocked`,async()=>{
      const policy=await signed(),m=await mission({policy,legacy,expired:kind==="deadline"});await m.executor.execute(m.input);m.stop(kind);
      const sends=methods.filter(m=>m==="eth_sendRawTransaction").length,result=await m.resume(),state=await m.read();
      assert.equal(result.terminal,false);assert.equal(result.phase,"Paused");assert.equal(result.reason,"HOSTED_GOAL_POLICY_UNCERTAIN");assert.equal(state.calls[0].started,true);assert.equal(state.calls[0].unpaid,false);
      assert.equal((legacy?state.policy:state.calls[0].policy)?.raw,policy.raw);assert.equal(guardCode(state),"STATE_MISSION_INFLIGHT");
      assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);assert.equal(relayRequests,0);
    });
    await t.test("ordinary recovery of a saved signature is also read-only, ignoring an unverified receipt marker",async()=>{
      const policy=await signed();policy.receipt={txHash:policy.hash,status:1,blockNumber:1,blockHash:"0x"+"e".repeat(64)};
      const m=await mission({policy});await m.executor.execute(m.input);const sends=methods.filter(m=>m==="eth_sendRawTransaction").length;
      assert.equal((await m.resume()).reason,"HOSTED_GOAL_POLICY_UNCERTAIN");assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);assert.equal(relayRequests,0);
    });
    const invalid:{name:string;policy:()=>Promise<Policy>}[]=[
      {name:"signer",policy:()=>signed({signer:new Wallet(key(3))})},{name:"chain",policy:()=>signed({chainId:42431})},
      {name:"destination",policy:()=>signed({to:f!.payee})},{name:"agent",policy:()=>signed({agentId:"2"})},
      {name:"limit",policy:()=>signed({limit:"100001"})},{name:"ownerFrozen",policy:()=>signed({frozen:true})},
      {name:"hash",policy:async()=>({...await signed(),hash:"0x"+"0".repeat(64)})}
    ];
    for(const entry of invalid)await t.test(`reject saved policy with changed ${entry.name} before any broadcast`,async()=>{
      const m=await mission({policy:await entry.policy(),legacy:true});await m.executor.execute(m.input);m.stop("cancel");
      const sends=methods.filter(m=>m==="eth_sendRawTransaction").length,result=await m.resume();
      assert.equal(result.terminal,false);assert.equal(result.reason,"HOSTED_GOAL_BINDING_CHANGED");assert.equal((await m.read()).calls[0].unpaid,false);assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);
    });
    await t.test("confirmed old policy permits cancellation without payment or model dispatch; noncanonical receipt does not",async()=>{
      const policy=await signed();await(await f!.provider.broadcastTransaction(policy.raw)).wait();
      for(const legacy of [false,true]){
        const m=await mission({policy,legacy});await m.executor.execute(m.input);m.stop("cancel");
        reorg=true;assert.equal((await m.resume()).reason,"HOSTED_GOAL_POLICY_UNCERTAIN");reorg=false;
        const sends=methods.filter(m=>m==="eth_sendRawTransaction").length,result=await m.resume(),state=await m.read();
        assert.equal(result.terminal,true);assert.equal(result.phase,"Cancelled");assert.equal(state.calls[0].unpaid,true);assert.equal((legacy?state.policy:state.calls[0].policy)?.receipt?.txHash,policy.hash);assert.equal(guardCode(state),"ACCEPTED");assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);
      }
      assert.equal(relayRequests,0);
    });
    await t.test("canonical reverted policy resolves a stopped chain intent without retrying it",async()=>{
      const policy=await signed({gasLimit:25000n});try{await(await f!.provider.broadcastTransaction(policy.raw)).wait();}catch{/* The original exact transaction intentionally exhausts its gas. */}
      assert.equal((await f!.provider.getTransactionReceipt(policy.hash))?.status,0);
      const m=await mission({policy,legacy:true});await m.executor.execute(m.input);m.stop("cancel");const sends=methods.filter(m=>m==="eth_sendRawTransaction").length;
      const result=await m.resume(),state=await m.read();assert.equal(result.terminal,true);assert.equal(result.phase,"Cancelled");assert.equal(state.policy?.receipt?.status,0);assert.equal(guardCode(state),"ACCEPTED");assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);
    });
    for(const lost of ["before","after"] as const)await t.test(`fresh policy ${lost} acceptance response loss never retries or replaces on cancellation`,async()=>{
      await tx(f!.account,wallet,"setPolicy",["1",{maxCashPerTx:0,maxDebtPerTx:0,maxDebtPerDay:0,ownerFrozen:false}]);
      const m=await mission({seed:false});drop=lost;const sends=methods.filter(m=>m==="eth_sendRawTransaction").length;
      const first=await m.executor.execute(m.input);assert.equal(first.terminal,false);assert.equal(first.reason,"HOSTED_GOAL_POLICY_UNCERTAIN");const original=(await m.read()).calls[0].policy!;assert.ok(original.raw);
      m.stop("cancel");const stopped=await m.resume();assert.equal(stopped.terminal,lost==="after");assert.equal(stopped.reason,lost==="after"?"HOSTED_GOAL_CANCELLED":"HOSTED_GOAL_POLICY_UNCERTAIN");assert.equal((await m.read()).calls[0].policy!.raw,original.raw);assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends+1);assert.equal(relayRequests,0);
    });
    await t.test("cash must cover current route plus frozen future reserve before quote, payment or model dispatch",async()=>{
      // The fixture has 40,000 cash: strong=40,000, cheap=24,000 and the
      // saved call reserves 24,000 (the 10/6/6/10 boundary scaled by 4,000).
      const models=[{...route,id:"strong",model:"strong",priceRaw:"40000"},{...route,priceRaw:"24000"}];
      const m=await mission({models,reserve:"200000",seedCall:async(_state,call)=>{call.futureReserveRaw="24000";}});await m.executor.execute(m.input);const sends=methods.filter(m=>m==="eth_sendRawTransaction").length;
      const result=await m.resume(),state=await m.read();assert.equal(result.terminal,false);assert.equal(result.reason,"INFERENCE_FUNDING_REQUIRED");assert.equal(state.calls[0].unpaid,true);assert.equal(state.calls[0].handle,undefined);assert.equal(state.calls[0].policy,undefined);assert.equal(state.calls[0].route?.id,"strong");assert.equal(relayRequests,0);assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);
    });
    await t.test("cancelled signed payment remains nonterminal and keeps its original handle, nonce and route",async()=>{
      let original:PaymentHandle;
      const m=await mission({seedCall:async(state,call)=>{
        const input={service:route.service,model:route.model,messages:call.messages,max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"},agentId:"1",taskId:"0"},serverNonce="0x"+"4".repeat(64),digest=requestDigest(input),pid=paymentId("0",digest,serverNonce),nonce=await f!.provider.getTransactionCount(wallet.address);
        const raw=await wallet.signTransaction({type:2,chainId:31337,nonce,to:account,gasLimit:200000n,maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,data:accountInterface.encodeFunctionData("payProvider",["1",route.provider,route.priceRaw,pid,EMPTY_AUTH,"0x"])});
        call.handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:pid,agentId:"1",taskId:"0",requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:route.provider,asset:await f!.token!.getAddress(),chainId:"31337",account,quoteExpiry:String((await f!.provider.getBlock("latest"))!.timestamp+3600),createdBlock:1},creditNonce:"1",submission:{txHash:keccak256(raw),rawTransaction:raw,nonce,from:wallet.address}};original=structuredClone(call.handle);
        // Admission cash is deliberately insufficient; a saved handle still
        // must reconcile its original route rather than create a cheaper quote.
        call.futureReserveRaw="100000000";
      }});
      await m.executor.execute(m.input);m.stop("cancel");const sends=methods.filter(m=>m==="eth_sendRawTransaction").length;
      const result=await m.resume(),state=await m.read();assert.equal(result.terminal,false);assert.equal(state.calls[0].unpaid,false);assert.deepEqual(state.calls[0].handle,original!);assert.equal(state.calls[0].voidSubmission,undefined);assert.equal(state.calls[0].route?.id,route.id);assert.equal(guardCode(state),"STATE_MISSION_INFLIGHT");assert.equal(methods.filter(m=>m==="eth_sendRawTransaction").length,sends);assert.ok(relayPaths.every(path=>path.startsWith("/payments/")));
    });
    await t.test("the first allowlisted SDK code persists before activity failure without saving private diagnostics",async st=>{
      const secret="SYNTHETIC_PRIVATE_DIAGNOSTIC_MUST_NOT_PERSIST";
      const m=await mission({seedCall:async(_state,call)=>{
        const input={service:route.service,model:route.model,messages:call.messages,max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"},agentId:"1",taskId:"0"},serverNonce="0x"+"6".repeat(64),digest=requestDigest(input);
        call.handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:paymentId("0",digest,serverNonce),agentId:"1",taskId:"0",requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:route.provider,asset:await f!.token!.getAddress(),chainId:"31337",account,quoteExpiry:"9999999999",createdBlock:1},creditNonce:"1"};
      }});
      await m.executor.execute(m.input);
      let failure:unknown=new PaymentError("RELAY_UNAVAILABLE",secret,{rawTransaction:secret});
      st.mock.method(InferCredit.prototype,"resume",async()=>{throw failure;});
      const state=await m.read(),call=state.calls[0],file=join(m.input.directory,"mission/session.json"),originalHandle=structuredClone(call.handle);
      const save=async()=>writeFile(file,JSON.stringify(state),{mode:0o600});
      const execution={...m.input,activity:async()=>{assert.equal((await m.read()).calls[0].firstPaymentErrorCode,call.firstPaymentErrorCode);throw Error("SYNTHETIC_ACTIVITY_FAILURE");}};
      await assert.rejects(paidGoalCall(config,state,call,execution,save,async()=>({paused:false,cancelled:false})),/SYNTHETIC_ACTIVITY_FAILURE/);
      assert.equal((await m.read()).calls[0].firstPaymentErrorCode,"RELAY_UNAVAILABLE");
      failure=new PaymentError("UPSTREAM_UNCERTAIN",secret,{rawTransaction:secret});
      await assert.rejects(paidGoalCall(config,state,call,execution,save,async()=>({paused:false,cancelled:false})),/SYNTHETIC_ACTIVITY_FAILURE/);
      assert.equal(call.firstPaymentErrorCode,"RELAY_UNAVAILABLE");
      delete call.firstPaymentErrorCode;await save();
      for(const error of [new PaymentError(secret,secret,{rawTransaction:secret}),Object.assign(new Error(secret),{code:"PAYMENT_UNCERTAIN"})]){
        failure=error;await assert.rejects(paidGoalCall(config,state,call,execution,save,async()=>({paused:false,cancelled:false})),/SYNTHETIC_ACTIVITY_FAILURE/);
        assert.equal((await m.read()).calls[0].firstPaymentErrorCode,undefined);
      }
      assert.deepEqual(call.handle,originalHandle);assert.equal(call.inference,undefined);assert.equal(call.response,undefined);
      assert.equal((await readFile(file,"utf8")).includes(secret),false);
    });
    await t.test("combined unconfirmed policy blocks an otherwise voidable expired payment handle",async()=>{
      const policy=await signed();let original:PaymentHandle;
      const m=await mission({policy,seedCall:async(_state,call)=>{
        const input={service:route.service,model:route.model,messages:call.messages,max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"},agentId:"1",taskId:"0"},serverNonce="0x"+"5".repeat(64),digest=requestDigest(input),pid=paymentId("0",digest,serverNonce),nonce=await f!.provider.getTransactionCount(wallet.address),head=(await f!.provider.getBlock("latest"))!;
        const raw=await wallet.signTransaction({type:2,chainId:31337,nonce,to:account,gasLimit:200000n,maxFeePerGas:3_000_000_000n,maxPriorityFeePerGas:1_000_000_000n,data:accountInterface.encodeFunctionData("payProvider",["1",route.provider,route.priceRaw,pid,EMPTY_AUTH,"0x"])});
        call.handle={version:1,relayUrl:route.relayUrl,input,quote:{paymentId:pid,agentId:"1",taskId:"0",requestDigest:digest,serverNonce,service:route.service,model:route.model,price:route.priceRaw,payTo:route.provider,asset:await f!.token!.getAddress(),chainId:"31337",account,quoteExpiry:String(head.timestamp-1),createdBlock:1},creditNonce:"1",submission:{txHash:keccak256(raw),rawTransaction:raw,nonce,from:wallet.address}};original=structuredClone(call.handle);
      }});
      await m.executor.execute(m.input);const before=await m.read();let voidSignAttempts=0;
      // Prove this exact expired handle passes the existing canonical void
      // admission checks. Stop at signing so this eligibility probe cannot write.
      await assert.rejects(voidExpiredGoalPayment(before,structuredClone(before.calls[0]),account,await f!.token!.getAddress(),f!.provider,{address:wallet.address,signTransaction:async()=>{voidSignAttempts++;throw Error("TEST_VOID_SIGN_BOUNDARY");}},async()=>{throw Error("unexpected replacement persistence");},200),/TEST_VOID_SIGN_BOUNDARY/);
      assert.equal(voidSignAttempts,1);
      const nonce=await f!.provider.getTransactionCount(wallet.address),sends=methods.filter(method=>method==="eth_sendRawTransaction").length,reads=relayPaths.length;
      m.stop("cancel");const result=await m.resume(),state=await m.read();
      assert.equal(result.phase,"Paused");assert.equal(result.terminal,false);assert.equal(result.reason,"HOSTED_GOAL_POLICY_UNCERTAIN");assert.equal(state.calls[0].started,true);assert.equal(state.calls[0].unpaid,false);assert.equal(state.calls[0].policy?.raw,policy.raw);assert.deepEqual(state.calls[0].handle,original!);assert.equal(state.calls[0].voidSubmission,undefined);assert.equal(state.calls[0].recovery,undefined);assert.equal(methods.filter(method=>method==="eth_sendRawTransaction").length,sends);assert.equal(await f!.provider.getTransactionCount(wallet.address),nonce);assert.equal(relayPaths.length,reads);assert.equal(guardCode(state),"STATE_MISSION_INFLIGHT");
    });
  }finally{
    for(const server of [proxy,relay])if(server.listening)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
    if(f)await f.close();await stopAnvil(local.child);await rm(directory,{recursive:true,force:true});
  }
});
