import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { Wallet } from "ethers";
import { InferCredit } from "@agentfuel/sdk";
async function listen(server:Server){server.listen(0,"127.0.0.1");await once(server,"listening");return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}
test("SDK rejects relay redirect without forwarding prompt, reaching target or submitting payment",async()=>{
 const asset="0x"+"2".repeat(40),methods:string[]=[];let relayRequests=0,targetRequests=0,saved=0;
 const target=createServer((_req,res)=>{targetRequests++;res.end("unexpected");});const targetUrl=await listen(target);
 const relay=createServer((_req,res)=>{relayRequests++;res.writeHead(307,{location:targetUrl+"/capture"});res.end();});
 const rpc=createServer(async(req,res)=>{let raw="";for await(const p of req)raw+=p;const body=JSON.parse(raw);
  const reply=(request:{method:string;id:unknown})=>{methods.push(request.method);return {jsonrpc:"2.0",id:request.id,result:request.method==="eth_chainId"?"0xa5bf":"0x"+asset.slice(2).padStart(64,"0")};};
  res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(Array.isArray(body)?body.map(reply):reply(body)));});
 const relayUrl=await listen(relay),rpcUrl=await listen(rpc);
 const sdk=new InferCredit({agentId:"1",rpcUrl,sessionKey:"0x"+"1".repeat(64),chainId:42431n,account:new Wallet("0x"+"3".repeat(64)).address,asset,provider:new Wallet("0x"+"4".repeat(64)).address,maxPrice:1n,onHandle:()=>{saved++;}});
 try{await assert.rejects(sdk.fetch(relayUrl+"/v1/chat",{body:{service:"approved",model:"model",messages:[{role:"user",content:"PRIVATE_SYNTHETIC_PROMPT"}]}}),{code:"RELAY_UNAVAILABLE"});
  assert.equal(relayRequests,1);assert.equal(targetRequests,0);assert.equal(saved,0);assert.ok(methods.every(m=>["eth_chainId","eth_call"].includes(m)));
 }finally{sdk.close();await Promise.all([close(rpc),close(relay),close(target)]);}
});
