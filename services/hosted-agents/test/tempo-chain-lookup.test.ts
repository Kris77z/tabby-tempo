import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,type JsonRpcProvider} from 'ethers';
import {collectChainResearch} from '../src/goals/chain-lookup.js';
import {tempoReceiptFee} from '../src/goals/tempo-fee.js';
import {validateChainEvidence} from '../src/chain-evidence.js';
import {TEMPO_PATH_USD,TEMPO_FEE_MANAGER} from '../../../scripts/tempo-config.js';
import type {HostedTaskExecutorConfig} from '../src/task-executor.js';
const payer='0x'+'1'.repeat(40),recipient='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
const abi=new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)','function balanceOf(address) view returns(uint256)','function name() view returns(string)','function symbol() view returns(string)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function owner() view returns(address)','function paused() view returns(bool)']);
const reason=(r:ReturnType<typeof tempoReceiptFee>)=>'reason' in r?r.reason:undefined;
const transfer=(from:string,to:string,amount:number)=>({address:TEMPO_PATH_USD,...abi.encodeEventLog(abi.getEvent('Transfer')!,[from,to,amount]),logIndex:'0x1'});
test('Tempo fee uses exact metadata/counterparties, never business transfers or ambiguous matches',()=>{
 const receipt={feeToken:TEMPO_PATH_USD,feePayer:payer,logs:[transfer(payer,recipient,120000),transfer(payer,TEMPO_FEE_MANAGER,210)]};
 assert.deepEqual(tempoReceiptFee(receipt),{status:'confirmed-receipt-transfer',feeToken:TEMPO_PATH_USD,feePayer:payer,symbol:'PathUSD',decimals:6,amountRaw:'210',amount:'0.00021',logIndex:'0x1'});
 assert.equal(reason(tempoReceiptFee({...receipt,logs:[...receipt.logs,transfer(payer,TEMPO_FEE_MANAGER,12)]})),'ambiguous-fee-transfers');
 assert.equal(tempoReceiptFee({...receipt,feeToken:recipient}).status,'unknown');
 assert.equal(reason(tempoReceiptFee({...receipt,logs:[transfer(recipient,TEMPO_FEE_MANAGER,210)]})),'fee-transfer-missing');
 assert.equal(tempoReceiptFee({logs:receipt.logs}).status,'unknown');
});
function fixture(batch=false){
 const methods:string[]=[];
 const provider={send:async(method:string,args:any[])=>{methods.push(method);
  if(method==='eth_chainId')return '0xa5bf';
  if(method==='eth_getBlockByNumber')return {number:args[0]==='latest'?'0x66':args[0],hash:blockHash};
  if(method==='eth_getCode')return '0x60006000';
  if(method==='eth_getBalance')throw Error('Tempo native placeholder must not become a balance');
  if(method==='eth_getStorageAt')return '0x'+'0'.repeat(64);
  if(method==='eth_call'){assert.equal(args[0].gas,'0xf4240');const fn=abi.parseTransaction({data:args[0].data})!.name;return abi.encodeFunctionResult(fn,[({balanceOf:900000,name:'PathUSD',symbol:'PathUSD',decimals:6,totalSupply:1000000,owner:payer,paused:false} as any)[fn]]);}
  if(method==='eth_getTransactionByHash')return {hash,from:payer,nonce:'0x1',blockHash,type:batch?'0x76':'0x2',...(batch?{calls:[{to:recipient,value:'0x0',data:'0x1234'}]}:{to:recipient,value:'0x0',input:'0x1234'})};
  if(method==='eth_getTransactionReceipt')return {transactionHash:hash,blockHash,blockNumber:'0x64',status:'0x1',gasUsed:'0x55202',effectiveGasPrice:'0x23c34601',feeToken:TEMPO_PATH_USD,feePayer:payer,logs:[transfer(payer,recipient,120000),transfer(payer,TEMPO_FEE_MANAGER,210)]};
  throw Error('Unexpected method '+method);
 }} as unknown as JsonRpcProvider;
 const fetcher:typeof fetch=async input=>{assert.match(String(input),/^https:\/\/sourcify.dev\/server\/v2\/contract\/42431\//);return new Response('',{status:404});};
 return {provider,fetcher,methods};
}
test('Tempo snapshot pins real token balance and fee without an invented native balance',async()=>{
 const f=fixture(),r=(await collectChainResearch(`${TEMPO_PATH_USD} ${hash}`,'42431',{} as HostedTaskExecutorConfig,f))!;
 const tx=JSON.parse(r.evidence.records.find(r=>r.kind==='transaction')!.dataJson),a=JSON.parse(r.evidence.records[0].dataJson);
 assert.equal(tx.fee.amountRaw,'210');assert.equal(tx.feeNative,undefined);assert.equal(a.nativeBalanceRaw,undefined);assert.equal(a.nativeBalanceIsPlaceholder,true);assert.equal(a.feeAsset.balance.value,'"900000"');assert.ok(!f.methods.includes('eth_getBalance'));
 assert.equal(validateChainEvidence(r.evidence).chainId,'42431');
 const record=r.evidence.records[0];
 for(const url of [record.source!.url.replace('/42431/','/10143/'),record.source!.url.replace(record.target,recipient)])assert.throws(()=>validateChainEvidence({...r.evidence,records:[{...record,source:{...record.source!,url}}]}),/EVIDENCE_INVALID/);
 await assert.rejects(collectChainResearch(`Monad ${TEMPO_PATH_USD}`,'42431',{} as HostedTaskExecutorConfig,f),/LOOKUP_NETWORK/);
});
test('Tempo batch transaction with no input retains bounded calls and explicit decode limitation',async()=>{
 const r=(await collectChainResearch(hash,'42431',{} as HostedTaskExecutorConfig,fixture(true)))!,tx=JSON.parse(r.evidence.records.find(r=>r.kind==='transaction')!.dataJson);
 assert.equal(tx.type,'0x76');assert.equal(tx.calldata,null);assert.equal(tx.calls[0].calldata,'0x1234');assert.match(tx.decodeStatus,/batch ABI decoding is not supported/);assert.equal(tx.decoded,undefined);
});
test('lookup total read budget rejects a stuck RPC before any payment',async()=>{
 await assert.rejects(collectChainResearch(TEMPO_PATH_USD,'42431',{} as HostedTaskExecutorConfig,{provider:{send:async()=>new Promise(()=>{})} as unknown as JsonRpcProvider,timeoutMs:20}),/LOOKUP_UNAVAILABLE/);
});
