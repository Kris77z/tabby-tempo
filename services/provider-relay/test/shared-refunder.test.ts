import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {id} from 'ethers';
import {EMPTY_AUTH,type ChatInput} from '@agentfuel/sdk';
import {fixture,key,read,startAnvil,stopAnvil,tx} from '../../underwriter/test/fixture.js';
import {Relay} from '../src/relay.js';
import {Refunder} from '../src/refunder.js';

test('one refunder wallet serializes concurrent refunds across distinct relay journals and replays without sending', {timeout:60000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'shared-refunder-')),local=await startAnvil();
 let f:Awaited<ReturnType<typeof fixture>>|undefined;const relays:Relay[]=[];
 try{
  f=await fixture(local.rpc,join(directory,'underwriter'),6,{refunderKey:key(4)});
  await f.provider.send('anvil_setBalance',[f.payee,'0x3635c9adc5dea00000']);
  let queue:Promise<unknown>=Promise.resolve(),inflight=0,maximum=0;
  const serialize=<T>(operation:()=>Promise<T>):Promise<T>=>{const next=queue.catch(()=>{}).then(async()=>{inflight++;maximum=Math.max(maximum,inflight);try{return await operation();}finally{inflight--;}});queue=next;return next;};
  const payments=[];let calls=0;
  for(let i=0;i<2;i++){
   const relay=new Relay({rpcUrl:local.rpc,chainId:31337n,account:await f.account.getAddress(),asset:f.config.settlementAsset,assetDecimals:6,payTo:f.payee,service:{id:`controlled-${i}`,model:'controlled',price:1000n,upstreams:[{name:'controlled',model:'controlled',baseUrl:'https://controlled.invalid/v1',key:'synthetic'}]},dataDir:join(directory,`relay-${i}`),quoteTtl:300,confirmations:1,upstreamTimeout:1000,host:'127.0.0.1',port:0,refunderKey:key(4)},{provider:f.provider,upstreamFetch:async()=>{calls++;return Response.json({error:'controlled rejection'},{status:400});}});
   relays.push(relay);const refunder=new Refunder(relay,{serialize});await relay.initialize();await refunder.initialize();
   const input:ChatInput={agentId:'1',taskId:'0',service:relay.config.service.id,model:'controlled',messages:[{role:'user',content:'controlled'}]};
   const quote=await relay.quote(input),paid=await tx(f.account,f.agent,'payProvider',['1',f.payee,'1000',quote.paymentId,EMPTY_AUTH,'0x']);
   await assert.rejects(relay.chat(input,quote.paymentId,paid.hash));payments.push({relay,refunder,paymentId:quote.paymentId,refundId:id(`separate-refund-${i}`)});
  }
  let sends=0;const broadcast=f.provider.broadcastTransaction.bind(f.provider);f.provider.broadcastTransaction=async raw=>{sends++;return broadcast(raw);};
  await Promise.all(payments.map(p=>p.refunder.refund(p.paymentId,p.refundId,'1000')));
  assert.equal(maximum,1);assert.equal(calls,2);
  const operations=[];
  for(const p of payments){const record=await p.relay.store.read(p.paymentId);assert.equal(record.state,'Refunded');assert.equal((await read(f.account,'getPayment',[p.paymentId])).refundedAmount,1000n);operations.push(record.refunds[0].approval!,record.refunds[0].transaction!);}
  assert.equal(new Set(operations.map(o=>o.nonce)).size,4);assert.equal(sends,4);
  for(const operation of operations){const receipt=await f.provider.getTransactionReceipt(operation.txHash);assert.equal(receipt?.status,1);assert.equal((await f.provider.getBlock(receipt!.blockNumber))?.hash,receipt!.blockHash);}
  const nonce=await f.provider.getTransactionCount(f.payee);
  await Promise.all(payments.map(p=>p.refunder.refund(p.paymentId,p.refundId,'1000')));
  assert.equal(await f.provider.getTransactionCount(f.payee),nonce);assert.equal(sends,4);assert.equal(await f.providerBalance(),0n);
 }finally{for(const relay of relays)relay.close();await f?.close();await stopAnvil(local.child);await rm(directory,{recursive:true,force:true});}
});
