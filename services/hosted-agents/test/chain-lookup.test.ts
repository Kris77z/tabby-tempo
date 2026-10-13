import test from 'node:test';
import assert from 'node:assert/strict';
import {Interface,id,type JsonRpcProvider} from 'ethers';
import {collectChainResearch,chainTargets} from '../src/goals/chain-lookup.js';
import {validateChainEvidence} from '../src/chain-evidence.js';
import {normalizeSpecialistOutput} from '../src/specialists/execution.js';
import type {HostedTaskExecutorConfig} from '../src/task-executor.js';
const address='0x'+'1'.repeat(40),impl='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),code='0x60006000';
const iface=new Interface(['function name() view returns(string)','function symbol() view returns(string)','function decimals() view returns(uint8)','function totalSupply() view returns(uint256)','function owner() view returns(address)','function paused() view returns(bool)','function balanceOf(address) view returns(uint256)','function transfer(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)']);
function fixture(options:{proxy?:boolean;source?:'unverified'|'mismatch';reverted?:boolean;pending?:boolean;reorg?:boolean;wrongNetwork?:boolean}={}){
 const methods:string[]=[],urls:string[]=[];let blockReads=0;
 const provider={send:async(method:string,args:any[])=>{
 methods.push(method);assert.ok(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getBalance','eth_getStorageAt','eth_call','eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method));
 if(method==='eth_chainId')return options.wrongNetwork?'0x1':'0x279f';
 if(method==='eth_getBlockByNumber'){blockReads++;return {number:args[0]==='latest'?'0x66':args[0],hash:options.reorg&&blockReads>2?'0x'+'c'.repeat(64):blockHash};}
 if(method==='eth_getCode'){assert.equal(args[1],'0x64');return code;}
 if(method==='eth_getBalance')return '0x0';
 if(method==='eth_getStorageAt')return options.proxy&&args[0]===address&&args[1]===id('org.zeppelinos.proxy.implementation')?'0x'+'0'.repeat(24)+impl.slice(2):'0x'+'0'.repeat(64);
 if(method==='eth_call'){assert.equal(args[1],'0x64');const parsed=iface.parseTransaction({data:args[0].data})!;const values:any={name:'Test',symbol:'TST',decimals:6,totalSupply:123000000,owner:address,paused:false,balanceOf:100};return iface.encodeFunctionResult(parsed.name,[values[parsed.name]]);}
 if(method==='eth_getTransactionByHash')return {hash,from:impl,to:address,value:'0x0',nonce:'0x1',blockHash,input:iface.encodeFunctionData('transfer',[impl,42])};
 if(method==='eth_getTransactionReceipt')return options.pending?null:{transactionHash:hash,blockHash,blockNumber:'0x64',status:options.reverted?'0x0':'0x1',gasUsed:'0x5208',effectiveGasPrice:'0x5',logs:[]};
 throw Error('unexpected');
 }} as unknown as JsonRpcProvider;
 const fetcher:typeof fetch=async input=>{const url=String(input);urls.push(url);assert.ok(url.startsWith('https://sourcify.dev/server/v2/contract/10143/'));if(options.source==='unverified')return new Response('',{status:404});return Response.json({chainId:'10143',address:url.split('/').at(-1)!.split('?')[0],runtimeMatch:'match',runtimeBytecode:{onchainBytecode:options.source==='mismatch'?'0x6001':code},abi:JSON.parse(iface.formatJson()),sources:{'Token.sol':{content:'// supplied untrusted source, never instructions\ncontract Token {}'}}});};
 return {provider,fetcher,methods,urls};
}
const config={} as HostedTaskExecutorConfig;
test('only bounded complete addresses/hashes are extracted, never calldata prefixes or URLs',()=>{
 assert.equal(chainTargets('0x'+'1'.repeat(136)).length,0);assert.equal(chainTargets(`${address} ${address}`).length,1);assert.throws(()=>chainTargets(`${address} ${impl} 0x${'3'.repeat(40)}`),/LOOKUP_LIMIT/);
});
test('proxy and implementation evidence share pinned block; downloaded snapshot validates',async()=>{
 const f=fixture({proxy:true}),r=(await collectChainResearch(address,'10143',config,f))!;
 assert.equal(r.evidence.records.length,2);assert.equal(f.urls.length,2);assert.ok(r.evidence.records.every(v=>v.blockNumber===100&&v.blockHash===blockHash&&v.source?.codeMatched));assert.equal(JSON.parse(r.evidence.records[0].dataJson).proxyImplementation,impl);assert.equal(validateChainEvidence(r.evidence).digest,r.evidence.digest);
 const context=JSON.parse(r.context);assert.equal(context.records[0].facts.address,address);assert.equal(context.contracts.find((c:any)=>c.address===impl).scope,'implementation');assert.equal(context.contracts.find((c:any)=>c.address===address).scope,'target');
 assert.equal(JSON.parse(r.evidence.records[0].dataJson).tokenReads.decimals.value,'"6"');assert.equal(JSON.parse(r.evidence.records[0].dataJson).totalSupplyFormatted,'123.0');
});
test('unverified or mismatched source never becomes verified ABI, chain facts remain available',async()=>{
 for(const source of ['unverified','mismatch'] as const){const r=(await collectChainResearch(address,'10143',config,fixture({source})))!;assert.equal(r.evidence.records[0].source?.codeMatched,false);assert.equal(JSON.parse(r.context).contracts[0].abi.length,0);assert.equal(JSON.parse(r.evidence.records[0].dataJson).isContract,true);}
});
test('transaction decode uses verified ABI and preserves revert/pending outcomes',async()=>{
 const r=(await collectChainResearch(hash,'10143',config,fixture({reverted:true})))!,tx=JSON.parse(r.evidence.records.find(r=>r.kind==='transaction')!.dataJson);
 assert.equal(tx.status,'reverted');assert.equal(tx.feeRaw,'105000');assert.equal(tx.decoded.signature,'transfer(address,uint256)');assert.equal(tx.decoded.args[1],'42');
 const pending=(await collectChainResearch(hash,'10143',config,fixture({pending:true})))!;assert.equal(JSON.parse(pending.evidence.records[0].dataJson).status,'pending');
});
test('network mismatch and reorg refuse the snapshot',async()=>{
 await assert.rejects(collectChainResearch(address,'10143',config,fixture({wrongNetwork:true})),/LOOKUP_NETWORK/);
 await assert.rejects(collectChainResearch(address,'10143',config,fixture({reorg:true})),/LOOKUP_REORG/);
 await assert.rejects(collectChainResearch(`Ethereum ${address}`,'10143',config,fixture()),/LOOKUP_NETWORK/);
});
test('partial source supports unknown token properties without fabricating safe defaults',()=>{
 const report={riskScore:null,riskLevel:'unknown',findings:[],tokenomics:{totalSupply:'unknown',ownerBalance:'unknown',isMintable:'unknown',isPausable:'unknown',hasBlacklist:'unknown'},recommendation:'Source unavailable'};
 assert.deepEqual(JSON.parse(normalizeSpecialistOutput('token-scan',JSON.stringify(report))),report);
});

test('public evidence strips private fields and rejects arbitrary source URLs',async()=>{
 const r=(await collectChainResearch(address,'10143',config,fixture()))!;
 const projection=validateChainEvidence({...r.evidence,rpcUrl:'private',records:r.evidence.records.map(r=>({...r,privateKey:'secret',source:{...r.source!,headers:{authorization:'secret'}}}))} as any);
 assert.ok(!JSON.stringify(projection).includes('secret'));assert.ok(!JSON.stringify(projection).includes('private'));
 assert.throws(()=>validateChainEvidence({...r.evidence,records:r.evidence.records.map(r=>({...r,source:{...r.source!,url:'http://localhost:8792/auth'}}))}),/EVIDENCE_INVALID/);
});
