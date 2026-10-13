/** Public, bounded read evidence; never includes RPC endpoints or credentials. */
export interface ChainReadEvidence {
 version:1;chainId:string;observedAt:string;digest:string;
 records:{kind:'address'|'transaction';target:string;blockNumber:number;blockHash:string;dataJson:string;source?:{url:string;status:string;digest?:string;codeMatched:boolean;truncated:boolean}}[];
}
export function validateChainEvidence(v:ChainReadEvidence):ChainReadEvidence{
 const hash=(s:unknown)=>typeof s==='string'&&/^0x[0-9a-f]{64}$/i.test(s);
 if(!v||v.version!==1||!['10143','31337','42431'].includes(v.chainId)||!Number.isFinite(Date.parse(v.observedAt))||!hash(v.digest)||!Array.isArray(v.records)||v.records.length>8)throw Error('HOSTED_GOAL_EVIDENCE_INVALID');
 return {version:1,chainId:v.chainId,observedAt:v.observedAt,digest:v.digest,records:v.records.map(r=>{
 if(!r||!['address','transaction'].includes(r.kind)||!(r.kind==='address'?/^0x[0-9a-f]{40}$/i: /^0x[0-9a-f]{64}$/i).test(r.target)||!Number.isSafeInteger(r.blockNumber)||r.blockNumber<0||!hash(r.blockHash)||typeof r.dataJson!=='string'||r.dataJson.length>50000)throw Error('HOSTED_GOAL_EVIDENCE_INVALID');
 JSON.parse(r.dataJson);
 const s=r.source,sourceUrl=s&&/^https:\/\/sourcify\.dev\/server\/v2\/contract\/(10143|31337|42431)\/(0x[0-9a-f]{40})\?fields=abi,sources,runtimeBytecode.onchainBytecode$/i.exec(s.url);
 if(s&&(!sourceUrl||r.kind!=='address'||sourceUrl[1]!==v.chainId||sourceUrl[2].toLowerCase()!==r.target.toLowerCase()||typeof s.status!=='string'||s.status.length>80||s.digest!==undefined&&!hash(s.digest)||typeof s.codeMatched!=='boolean'||typeof s.truncated!=='boolean'))throw Error('HOSTED_GOAL_EVIDENCE_INVALID');
 return {kind:r.kind,target:r.target,blockNumber:r.blockNumber,blockHash:r.blockHash,dataJson:r.dataJson,...(s?{source:{url:s.url,status:s.status,...(s.digest?{digest:s.digest}:{}),codeMatched:s.codeMatched,truncated:s.truncated}}:{})};})};
}
