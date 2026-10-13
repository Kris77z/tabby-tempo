import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedTaskFixture } from "./task-fixture.js";
import { HostedGoalExecutor } from "../src/goals/executor.js";
import { Relay } from "../../provider-relay/src/relay.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { upstreamAttemptsDigest } from "../../provider-relay/src/store.js";
import { randomUUID } from "node:crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import type { GoalState } from "../src/goals/executor.js";

test("goal pays canonical cash receipts for commander, specialist and independent reviewer; replay never pays twice",{timeout:180000},async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),"af-goal-paid-")));
 const f=await createHostedTaskFixture(join(directory,"chain"));
 let dispatches=0,unknown=false,cancelled=false;
 const relay=new Relay({...f.fx.relayConfig,dataDir:join(directory,"goals"),service:{id:"tabby/mission",model:"goal-model",price:10000n,upstreams:[{name:"cheap",model:"physical-goal",baseUrl:"http://127.0.0.1:9999/v1",key:"controlled"}]}},{provider:f.fx.f.provider,upstreamFetch:async(_url,init)=>{
   dispatches++;if(unknown)throw new Error("vendor outcome unknown");const body=JSON.parse(String(init?.body));assert.equal(body.model,"physical-goal");
   const content=dispatches===1?JSON.stringify({phases:[{name:"Write",taskType:"writer",goal:"Use facts A and B"}]}):dispatches===2?"Launch note: A and B.":JSON.stringify({passed:true,summary:"Includes A and B",checks:["Both supplied facts are present"]});
   return Response.json({model:"physical-goal",choices:[{finish_reason:"stop",message:{role:"assistant",content}}],usage:{prompt_tokens:21,completion_tokens:12,total_tokens:33}});
 }});
 await relay.initialize();const refunder=new Refunder(relay);await refunder.initialize();
 const server=createHttpServer(relay,refunder);server.listen(0,"127.0.0.1");await once(server,"listening");
 try{
  const actor=await f.actor(5,"cheap",40000n);
  const provision=await f.executor.execute(actor.input("provision"));assert.equal(provision.success,true,JSON.stringify(provision));actor.agent.binding=provision.binding;actor.agent.status="Ready";
  const input=actor.input("task");input.run.action="goal";input.run.goal="Write a launch note containing A and B.";
  const goals=new HostedGoalExecutor({durationMs:120000,models:[{id:"cheap",relayUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat`,provider:f.fx.f.payee,priceRaw:"10000",service:"tabby/mission",model:"goal-model",physicalModel:"physical-goal"}]},f.config,{control:async()=>({paused:false,cancelled})});
  const initialCash=await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId);
  const result=await goals.execute(input);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.chargedRaw,"30000");assert.equal(dispatches,3);
  assert.equal(await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId),initialCash-30000n);
  for(const call of result.mission!.calls){
   assert.equal(call.promptTokens,21);assert.equal(call.completionTokens,12);assert.match(call.txHash!,/^0x[0-9a-f]{64}$/);
   const payment=await f.fx.f.account.getFunction("getPayment").staticCall(call.paymentId!);assert.equal(payment.fromCash,10000n);assert.equal(payment.fromCredit,0n);assert.equal(payment.taskId,0n);
  }
  const nonce=await f.fx.f.provider.getTransactionCount(actor.wallet.address);
  assert.deepEqual(await goals.execute({...input,recover:true}),result);assert.equal(dispatches,3);assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address),nonce);
  unknown=true;
  const next=actor.input("task");next.run.action="goal";next.run.goal="Another launch note";
  const uncertain=await goals.execute(next);
  assert.equal(uncertain.terminal,false,JSON.stringify(uncertain));assert.equal(uncertain.chargedRaw,"10000");assert.equal(dispatches,4);
  cancelled=true;
  const stopped=await goals.execute({...next,recover:true});assert.equal(stopped.terminal,false);assert.equal(stopped.chargedRaw,"10000");assert.equal(dispatches,4);
  const journal=JSON.parse(await readFile(join(next.directory,"mission/session.json"),"utf8")) as GoalState;
  const paymentId=journal.calls[0].handle!.quote.paymentId,record=await relay.store.read(paymentId);
  await relay.resolveUndelivered({paymentId,resolutionId:randomUUID(),expectedAttemptsDigest:upstreamAttemptsDigest(record.upstreamAttempts!),evidenceDigest:keccak256(toUtf8Bytes("owned test operator accepts unknown vendor cost"))});
  await refunder.refund(paymentId,keccak256(toUtf8Bytes("goal-refund")),"10000");
  const settled=await goals.execute({...next,recover:true});assert.equal(settled.terminal,true,JSON.stringify(settled));assert.equal(settled.success,false);assert.equal(settled.reason,"HOSTED_GOAL_UNDELIVERED_REFUNDED");assert.equal(settled.chargedRaw,"0");assert.equal(settled.refundedRaw,"10000");assert.equal(dispatches,4);
  const settledNonce=await f.fx.f.provider.getTransactionCount(actor.wallet.address);
  assert.deepEqual(await goals.execute({...next,recover:true}),settled);assert.equal(dispatches,4);assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address),settledNonce);
 }finally{await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});relay.close();await f.close();await rm(directory,{recursive:true,force:true});}
});
