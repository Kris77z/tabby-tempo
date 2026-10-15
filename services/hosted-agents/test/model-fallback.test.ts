import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerExecutor, type Execution } from "@agentfuel/arena/docker";
import { InferenceFundingRequired, runProviderSolver, type JsonObject, type SolveSpec } from "@agentfuel/pi-loop/provider";
import type { Json } from "@agentfuel/sdk";
import { InferenceGateway, type GatewayModel } from "../src/inference-gateway.js";
import { selectMeteredModel } from "../src/metered-task.js";

const catalog:[GatewayModel,GatewayModel]=[
  {id:"cheap",model:"physical-cheap",route:"https://gateway.example/v1/chat/completions",inputMicroCreditsPerToken:"1",outputMicroCreditsPerToken:"2",maxCompletionTokens:256},
  {id:"strong",model:"physical-strong",route:"https://gateway.example/v1/chat/completions",inputMicroCreditsPerToken:"3",outputMicroCreditsPerToken:"6",maxCompletionTokens:256},
];
const binding={agentId:"1",taskId:"9",wallet:`0x${"22".repeat(20)}`};
const request:JsonObject={model:"strong",messages:[{role:"user",content:"solve"}],max_completion_tokens:256,reasoning_effort:"low"};
const good="import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n",bad="print(0)\n";
function response(code:string,model:string):Record<string,Json>{return{model,choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"tool",type:"function",function:{name:"test_public_sample",arguments:JSON.stringify({code})}}]}}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}};}
class Runner extends DockerExecutor {
  calls:string[]=[];
  override async ready(){}
  override async execute(code:string):Promise<Execution>{this.calls.push(code);return{stdout:code===good?"9\n":"0\n",exitCode:0};}
}

test("metered budget downgrade retains the same Pi task, first output, ledger funding and per-model actual usage",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"tabby-model-fallback-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  let calls=0,round=0,admissions=0;
  const gateway=await InferenceGateway.open(join(directory,"gateway"),binding,catalog,async model=>{calls++;return{status:200,body:response(calls===1?bad:good,model.model)};});
  try{
    const runner=new Runner(),input:SolveSpec={version:1,problemId:"sum-integers",tiers:["strong","strong"],maxRounds:2,maxToolCalls:4,maxCompletionTokens:256,deadlineMs:Date.now()+20000};
    const options={routes:{cheap:{name:"cheap",model:"cheap",baseUrl:"https://gateway.example/v1"},strong:{name:"strong",model:"strong",baseUrl:"https://gateway.example/v1"}},runner,
      beforeDispatch:async(body:JsonObject,index:number)=>{
        admissions++;round=index;
        if(index===0)await gateway.grant("approved-allowance",gateway.quote(body).reservedCredits,{kind:"chain-payment",paymentId:`0x${"33".repeat(32)}`,txHash:`0x${"44".repeat(32)}`});
        const choice=selectMeteredModel(gateway,body,catalog,gateway.balance().availableCredits);
        if(BigInt(choice.required)>BigInt(gateway.balance().availableCredits))throw new InferenceFundingRequired();
        if(choice.downgraded)return{tier:"cheap" as const};
      },
      invoke:async(_tier:unknown,body:JsonObject)=>{const result=await gateway.invoke(`round:${round}`,body);return{...(result.response as Record<string,Json>),model:body.model};},
      recoverResponse:async(body:JsonObject,index:number)=>{const result=gateway.readResult(`round:${index}`,body);return result?{...(result.response as Record<string,Json>),model:body.model}:undefined;},
    };
    const done=await runProviderSolver(join(directory,"solver"),input,options);assert.equal(done.phase,"Delivered");
    assert.deepEqual(done.rounds.map(r=>[r.model,r.budgetFallbackFrom]),[["strong",undefined],["cheap","strong"]]);
    assert.ok((done.rounds[1].body.messages as {role:string}[]).some(m=>m.role==="tool"));assert.deepEqual(runner.calls,[bad,good]);
    assert.deepEqual(gateway.status().map(r=>[r.id,r.modelId,r.result?.chargedCredits]),[["round:0","strong","150"],["round:1","cheap","50"]]);
    assert.equal(gateway.balance().spentCredits,"200");assert.equal(gateway.balance().reservedCredits,"0");
    const replay=await runProviderSolver(join(directory,"solver"),input,options);assert.equal(replay.phase,"Delivered");assert.equal(calls,2);assert.equal(admissions,2);
  }finally{await gateway.close();}
});

test("fallback uses both configured rates, leaves unaffordable requests unadmitted and cannot bypass Unknown",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"tabby-model-cost-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const expensiveCheap:[GatewayModel,GatewayModel]=[{...catalog[0],outputMicroCreditsPerToken:"100"},catalog[1]];
  const rates=await InferenceGateway.open(join(directory,"rates"),binding,expensiveCheap,async()=>{throw Error("must not dispatch");});
  try{
    const selection=selectMeteredModel(rates,request,expensiveCheap,"2000");assert.equal(selection.downgraded,false);assert.equal(selection.body.model,"strong");
    assert.equal(rates.status().length,0);
  }finally{await rates.close();}
  let calls=0;const gateway=await InferenceGateway.open(join(directory,"unknown"),binding,catalog,async()=>{calls++;throw Error("lost response");});
  try{
    assert.equal(selectMeteredModel(gateway,request,catalog,"1").downgraded,false);assert.equal(gateway.status().length,0);
    const cheaper=gateway.quote({...request,model:"cheap",reasoning_effort:"low"}).reservedCredits;
    const choice=selectMeteredModel(gateway,request,catalog,cheaper);assert.equal(choice.downgraded,true);assert.equal(choice.body.model,"cheap");assert.equal("reasoning_effort" in choice.body,false);
    await gateway.grant("grant","100000",{kind:"game",rewardId:"grant"});
    await assert.rejects(gateway.invoke("round:0",request),/GATEWAY_OUTCOME_UNKNOWN/);
    assert.throws(()=>selectMeteredModel(gateway,request,catalog,"100000"),/GATEWAY_OUTCOME_UNKNOWN/);
    await assert.rejects(gateway.invoke("round:0",choice.body),/GATEWAY_REQUEST_CONFLICT/);assert.equal(calls,1);
  }finally{await gateway.close();}
});
