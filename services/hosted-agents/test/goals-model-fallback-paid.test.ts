import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedTaskFixture } from "./task-fixture.js";
import { HostedGoalExecutor, type GoalModelRoute, type GoalState } from "../src/goals/executor.js";
import { Relay } from "../../provider-relay/src/relay.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { HostedTaskExecutor } from "../src/task-executor.js";

test("same mission budget and cash downgrade bind two real relay prices, canonical payments and independent review",{timeout:180000},async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"tabby-goal-model-paid-")));
  const f=await createHostedTaskFixture(join(directory,"chain"));f.config.initialCashRaw="80000";
  const dispatched:{model:string;stage:string}[]=[];
  let priorOutputPreserved=false;
  const relays:Relay[]=[],servers:ReturnType<typeof createHttpServer>[]=[],models:GoalModelRoute[]=[];
  try{
    for(const [id,price] of [["cheap",10000n],["strong",30000n]] as const){
      const relay=new Relay({...f.fx.relayConfig,dataDir:join(directory,id),service:{id:`tabby/mission-${id}`,model:`goal-${id}`,price,upstreams:[{name:id,model:`physical-${id}`,baseUrl:"http://127.0.0.1:9999/v1",key:"controlled"}]}},{provider:f.fx.f.provider,upstreamFetch:async(_url,options)=>{
        const body=JSON.parse(String(options?.body)),system=body.messages[0].content as string;
        const stage=system.includes("Decompose the user's actual goal")?"plan":system.includes("independent reviewer")?"review":"execute";
        if(stage==="execute"){const assignment=JSON.parse(body.messages[1].content);if(assignment.previous?.length)priorOutputPreserved=assignment.previous[0].output==="Launch note contains supplied facts A and B.";}
        dispatched.push({model:id,stage});assert.equal(body.model,`physical-${id}`);
        const content=stage==="plan"?JSON.stringify({phases:[{name:"Analyze",taskType:"analyst",goal:"Use facts A and B"},{name:"Write",taskType:"writer",goal:"Complete launch note"}]}):stage==="review"?JSON.stringify({passed:true,summary:"Includes supplied A and B",checks:["Contains both required facts"]}):"Launch note contains supplied facts A and B.";
        return Response.json({model:`physical-${id}`,choices:[{finish_reason:"stop",message:{role:"assistant",content}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}});
      }});
      await relay.initialize();relays.push(relay);const refunder=new Refunder(relay);await refunder.initialize();
      const server=createHttpServer(relay,refunder);server.listen(0,"127.0.0.1");await once(server,"listening");servers.push(server);
      models.push({id,relayUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1/chat`,provider:f.fx.f.payee,priceRaw:String(price),service:`tabby/mission-${id}`,model:`goal-${id}`,physicalModel:`physical-${id}`});
    }
    const goals=new HostedGoalExecutor({models,durationMs:120000},f.config);
    const provisions=new HostedTaskExecutor(f.config,{provider:f.fx.f.provider});
    const actor=await f.actor(5,"strong",80000n),provision=await provisions.execute(actor.input("provision"));
    assert.equal(provision.success,true,JSON.stringify(provision));actor.agent.binding=provision.binding;actor.agent.status="Ready";actor.agent.perRunBudgetRaw="70000";
    const input=actor.input("task");input.run.action="goal";input.run.goal="Write a launch note containing supplied A and B.";
    const cashBefore=await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId);
    const result=await goals.execute(input);assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.chargedRaw,"60000");
    assert.deepEqual(result.mission?.calls.map(c=>[c.model,c.chargedRaw]),[["strong","30000"],["cheap","10000"],["cheap","10000"],["cheap","10000"]]);
    assert.equal(result.mission?.calls.at(-1)?.stage,"review");assert.equal(await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId),cashBefore-60000n);
    const payments:Record<string,unknown>[]=[];
    for(const call of result.mission!.calls){
      const payment=await f.fx.f.account.getFunction("getPayment").staticCall(call.paymentId!);
      assert.equal(payment.fromCash,BigInt(call.chargedRaw));assert.equal(payment.fromCredit,0n);assert.equal(payment.taskId,0n);
      const receipt=await f.fx.f.provider.getTransactionReceipt(call.txHash!);assert.equal(receipt?.status,1);assert.equal((await f.fx.f.provider.getBlock(receipt!.blockNumber))?.hash,receipt!.blockHash);
      payments.push({stage:call.stage,modelId:call.model,priceRaw:call.chargedRaw,paymentId:call.paymentId,txHash:call.txHash,promptTokens:call.promptTokens,completionTokens:call.completionTokens,fromCashRaw:String(payment.fromCash),fromCreditRaw:String(payment.fromCredit),blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash});
    }
    const journal=JSON.parse(await readFile(join(input.directory,"mission/session.json"),"utf8")) as GoalState;
    assert.deepEqual(journal.calls.map(c=>c.handle?.quote.price),["30000","10000","10000","10000"]);
    assert.deepEqual(journal.calls.map(c=>c.route?.id),["strong","cheap","cheap","cheap"]);
    for(const [index,call]of journal.calls.entries()){payments[index].physicalModel=call.inference?.receipt.model;payments[index].requestDigest=call.handle?.quote.requestDigest;}
    const nonce=await f.fx.f.provider.getTransactionCount(actor.wallet.address);assert.deepEqual(await goals.execute({...input,recover:true}),result);assert.equal(dispatched.length,4);assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address),nonce);
    // The authorized task budget fits a strong planner, but the account's cash
    // must leave room for the cheapest remaining work and independent review.
    f.config.initialCashRaw="40000";const poorer=await f.actor(6,"strong",40000n),ready=await new HostedTaskExecutor(f.config,{provider:f.fx.f.provider}).execute(poorer.input("provision"));
    assert.equal(ready.success,true,JSON.stringify(ready));poorer.agent.binding=ready.binding;poorer.agent.status="Ready";poorer.agent.perRunBudgetRaw="70000";
    const cashInput=poorer.input("task");cashInput.run.action="goal";cashInput.run.goal=input.run.goal;
    const cheaperResult=await goals.execute(cashInput);assert.equal(cheaperResult.success,true,JSON.stringify(cheaperResult));assert.equal(cheaperResult.chargedRaw,"40000");
    assert.deepEqual(cheaperResult.mission?.calls.map(c=>c.model),["cheap","cheap","cheap","cheap"]);
    assert.equal(priorOutputPreserved,true);
    const acceptance=process.env.GOAL_FALLBACK_EVIDENCE_DIRECTORY??join(directory,"acceptance");await mkdir(acceptance,{recursive:true});
    await writeFile(join(acceptance,"model-fallback.json"),JSON.stringify({schemaVersion:1,observedAt:new Date().toISOString(),chainId:actor.agent.binding!.chainId,environment:"Anvil with controlled LLM responses",requestId:input.run.requestId,reservedRaw:input.run.reservedRaw,chargedRaw:result.chargedRaw,modelSequence:result.mission!.calls.map(c=>c.model),payments,priorOutputPreserved,independentReview:{stage:result.mission!.calls.at(-1)!.stage,passed:result.mission!.review?.passed},replay:{dispatchesBefore:4,dispatchesAfter:4,nonceBefore:nonce,nonceAfter:nonce},cashFallback:{requestId:cashInput.run.requestId,reservedRaw:cashInput.run.reservedRaw,cashBeforeRaw:"40000",chargedRaw:cheaperResult.chargedRaw,modelSequence:cheaperResult.mission!.calls.map(c=>c.model)}},null,2)+"\n");
  }finally{
    for(const server of servers)await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});
    for(const relay of relays)relay.close();await f.close();await rm(directory,{recursive:true,force:true});
  }
});
