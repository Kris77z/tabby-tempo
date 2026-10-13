import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { canonical } from "../packages/sdk/src/protocol.js";
import { saveJson, reportDemoFailure } from "./demo-common.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";

const directory=resolve("demo-output/monad-hosted-20261012/runtime");
const paymentId="0x64f4796ba4a999af1c74f20f40ff78ccd8c8a5d43be5fd0688a7c9804e386137";
const mode=process.argv[2]; assert.ok(["inspect","resolve","refund"].includes(mode));
async function main(){
  const read=async(file:string)=>JSON.parse(await readFile(file,"utf8"));
  const b=await read(join(directory,"..","bootstrap.json")),r=await read(join(directory,"planner",paymentId+".json"));
  assert.equal(r.quote.paymentId,paymentId);assert.equal(r.quote.agentId,"2202");assert.equal(r.quote.taskId,"0");assert.equal(r.quote.price,"10000");
  assert.equal(r.proof.fromCash,"10000");assert.equal(r.proof.fromCredit,"0");assert.equal(r.result,undefined);assert.equal(r.receipt,undefined);
  assert.equal(r.upstreamAttempts.length,1); const a=r.upstreamAttempts[0];assert.equal(a.state,"Unknown");assert.equal(a.httpStatus,503);assert.equal(a.model,"cheap/kimi-k2.6");
  const calls=(await readFile(resolve("demo-output/local-hosted-20261012/gateway/attempts.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  const dispatch=calls.filter(x=>x.phase==="DispatchIntent"&&Math.abs(Date.parse(x.at)-a.startedAt)<1000&&x.model==="kimi-k2.6");
  assert.equal(dispatch.length,1);assert.equal(dispatch[0].attempt,10);assert.equal(dispatch[0].maxCompletionTokens,512);
  const responses=calls.filter(x=>x.attempt===10&&x.phase!=="DispatchIntent");assert.equal(responses.length,1);assert.equal(responses[0].phase,"Response");assert.equal(responses[0].httpStatus,503);assert.equal(responses[0].usage,undefined);
  const connection=await monadProvider(await readRpcUrlFile(b.rpcUrlFile),b.rpcTransport);
  try{
    const p=connection.provider;assert.equal(BigInt(await p.send("eth_chainId",[])),10143n);
    const receipt=await p.getTransactionReceipt(r.proof.txHash);assert.equal(receipt?.status,1);assert.equal(receipt?.blockHash,r.proof.blockHash);
    assert.equal((await p.getBlock(receipt!.blockNumber))?.hash,receipt!.blockHash);
    const evidence={version:1,paymentId,agentId:"2202",chainId:"10143",priceRaw:"10000",requestDigest:r.quote.requestDigest,payment:{txHash:receipt!.hash,blockNumber:receipt!.blockNumber,blockHash:receipt!.blockHash,canonical:true},
      relayAttempts:r.upstreamAttempts,gatewayDispatch:dispatch[0],gatewayResponse:responses[0],
      observedDelivery:"No response result or delivery receipt; complete HTTP 503 at configured gateway, correlated with the sole serial dispatch within 52ms",
      providerCost:"Unknown; operator accepts this possible cost. This is not a claim that the provider performed no inference or charged nothing.",
      resolution:"Refund the original full service price and permanently seal this payment against further model dispatch; preserve the original Unknown attempt."};
    const evidenceDigest=keccak256(toUtf8Bytes(canonical(evidence)));
    const file=join(directory,"planner-resolution.json");let journal:any;
    try{journal=await read(file);assert.equal(journal.evidenceDigest,evidenceDigest);}catch(e:any){if(e.code!=="ENOENT")throw e;journal={version:1,evidence,evidenceDigest,resolutionId:randomUUID(),refundId:keccak256(toUtf8Bytes(randomUUID()))};await saveJson(file,journal);}
    if(mode==="inspect"){console.log(JSON.stringify({paymentId,evidenceDigest,canonical:true,providerCost:"unknown",dispatches:1,completeHttpStatus:503}));return;}
    const state=await read(join(directory,"runtime-journal","session.json")),ready=await read(join(directory,"ready.json"));
    const body=mode==="resolve"?{paymentId,resolutionId:journal.resolutionId,expectedAttemptsDigest:keccak256(toUtf8Bytes(canonical(r.upstreamAttempts))),evidenceDigest}:{paymentId,refundId:journal.refundId,amount:"10000"};
    const response=await fetch(`http://127.0.0.1:${ready.ports.planner}/ops/${mode==="resolve"?"resolve-undelivered":"refund"}`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${state.operatorToken}`},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    const result=await response.json();journal[mode]={status:response.status,result,observedAt:new Date().toISOString()};await saveJson(file,journal);console.log(JSON.stringify({mode,status:response.status,result}));assert.equal(response.ok,true);
    if(mode==="refund"){assert.equal(result.state,"Refunded");assert.equal(result.refundedAmount,"10000");}
  }finally{connection.close();}
}
main().catch(error=>{reportDemoFailure(error);process.exitCode=1;});
