import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { startExternalSpecialistStack } from "../external-specialist-stack.js";
import { registerLocalExternalProvider } from "../local-hosted.js";
import { fixture, key, startAnvil, stopAnvil, tx } from "../../services/underwriter/test/fixture.js";
import { discoverExternalServices } from "../../services/hosted-agents/src/external/registry.js";
import { missionSpecialists } from "../../services/hosted-agents/src/specialists/catalog.js";
import type { RelayConfig } from "../../services/provider-relay/src/config.js";

test("local bootstrap discovers 16 real external HTTP services with canonical identity, distinct provider and original restart ports without model calls or payment",{timeout:120000},async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"tabby-external-stack-"))),local=await startAnvil();
  let f:Awaited<ReturnType<typeof fixture>>|undefined,stack:Awaited<ReturnType<typeof startExternalSpecialistStack>>|undefined;
  let modelCalls=0;
  try{
    f=await fixture(local.rpc,join(directory,"underwriter"),6,{refunderKey:key(4)});
    // Exercise registration after other identities, exactly as local-hosted
    // registers its opponent and two dashboard test Agents before key 8.
    for(const index of [5,6])await tx(f.identity,f.admin,"registerFor",[new Wallet(key(index)).address,new Wallet(key(index)).address]);
    const expectedId=String(await f.identity.getFunction("nextAgentId").staticCall());
    const identity=await registerLocalExternalProvider(f.identity,f.account,f.admin);
    assert.equal(identity.agentId,expectedId);assert.equal(identity.chainId,"31337");assert.notEqual(identity.wallet.toLowerCase(),f.payee.toLowerCase());
    assert.equal(await f.identity.getFunction("ownerOf").staticCall(identity.agentId),identity.wallet);
    assert.equal(await f.identity.getFunction("getAgentWallet").staticCall(identity.agentId),identity.wallet);
    assert.equal(await f.account.getFunction("providerWhitelist").staticCall(identity.wallet),true);
    const ports:Record<string,number>={},saved:{name:string;port:number}[]=[];
    const models=[{id:"kimi-k2.6",model:"cheap/kimi-k2.6",responseModel:"kimi-k2.6",baseUrl:"http://127.0.0.1:1/v1",key:"unused-synthetic-stack-key",priceRaw:"10000"},
      {id:"kimi-k3",model:"strong/kimi-k3",responseModel:"kimi-k3",baseUrl:"http://127.0.0.1:1/v1",key:"unused-synthetic-stack-key",priceRaw:"20000"}];
    const base:RelayConfig={rpcUrl:local.rpc,chainId:31337n,account:await f.account.getAddress(),asset:f.config.settlementAsset,assetDecimals:6,payTo:f.payee,
      service:{id:"internal",model:"internal",price:10000n,upstreams:[{name:"unused",model:"internal",baseUrl:"http://127.0.0.1:1/v1",key:"unused"}]},
      dataDir:join(directory,"unused-base"),quoteTtl:300,confirmations:1,upstreamTimeout:1000,host:"127.0.0.1",port:0,refunderKey:key(4),operatorToken:"synthetic-external-stack-operator-token"};
    const options={base,provider:f.provider,directory:join(directory,"external-services"),providerIdentity:identity,models,ports,
      savePort:async(name:string,port:number)=>{saved.push({name,port});},upstreamFetch:(async()=>{modelCalls++;throw Error("Discovery must not dispatch a model");}) as typeof fetch};
    const guardian=await f.admin.getAddress(),nonceBefore=await f.provider.getTransactionCount(guardian),cashBefore=String(await f.account.getFunction("cash").staticCall("1")),balanceBefore=String(await f.token!.getFunction("balanceOf").staticCall(identity.wallet));
    stack=await startExternalSpecialistStack(options);
    assert.equal(stack.config.services.length,16);assert.equal(new Set(stack.config.services.map(s=>s.id)).size,16);
    assert.equal(Object.keys(ports).length,17);assert.equal(new Set(Object.values(ports)).size,17);assert.equal(saved.length,17);
    const beforeRestart=structuredClone(stack.config),originalPorts={...ports};
    const metadata=await fetch(stack.config.registryUrl).then(r=>r.json()) as {services:unknown[]};assert.equal(metadata.services.length,16);assert.equal(JSON.stringify(metadata).includes("unused-synthetic-stack-key"),false);
    const discovered=await discoverExternalServices(stack.config,{provider:f.provider});assert.equal(discovered.length,16);
    for(const specialist of missionSpecialists){
      const routes=discovered.filter(s=>s.service.taskType===specialist.id);assert.equal(routes.length,2);
      assert.deepEqual(routes.map(s=>[s.service.modelId,s.service.priceRaw]),[["kimi-k2.6","10000"],["kimi-k3","20000"]]);
      for(const candidate of routes){assert.equal(candidate.service.provider,identity.wallet);assert.deepEqual(candidate.service.identity,identity);assert.equal(candidate.service.reputation.score,null);assert.equal(candidate.service.reputation.samples,0);}
    }
    assert.equal(modelCalls,0);assert.equal(await f.provider.getTransactionCount(guardian),nonceBefore);assert.equal(String(await f.account.getFunction("cash").staticCall("1")),cashBefore);assert.equal(String(await f.token!.getFunction("balanceOf").staticCall(identity.wallet)),balanceBefore);
    await stack.close();stack=undefined;
    stack=await startExternalSpecialistStack(options);
    assert.deepEqual(ports,originalPorts);assert.deepEqual(stack.config,beforeRestart);assert.equal(saved.length,34);
    const restarted=await discoverExternalServices(stack.config,{provider:f.provider});assert.deepEqual(restarted,discovered);
    assert.equal(modelCalls,0);assert.equal(await f.provider.getTransactionCount(guardian),nonceBefore);assert.equal(String(await f.account.getFunction("cash").staticCall("1")),cashBefore);
    // Matching HTTP advertisements cannot conceal a changed ERC-8004 wallet.
    f.admin.reset();await tx(f.identity,f.admin,"cheatSetWalletOnly",[identity.agentId,new Wallet(key(9)).address]);
    await assert.rejects(discoverExternalServices(stack.config,{provider:f.provider}),/HOSTED_EXTERNAL_IDENTITY_INVALID/);assert.equal(modelCalls,0);
  }finally{await stack?.close();await f?.close();await stopAnvil(local.child);await rm(directory,{recursive:true,force:true});}
});
