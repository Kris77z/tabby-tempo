import { Interface, formatUnits } from 'ethers';
import { TEMPO_FEE_MANAGER, TEMPO_PATH_USD } from '../../../../scripts/tempo-config.js';

const transfers = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same = (a:unknown,b:string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
/** Tempo emits the actual fee as a TIP-20 Transfer after execution. Never sum
 * business transfers or reinterpret gasUsed * gasPrice as an 18-decimal coin. */
export function tempoReceiptFee(receipt:{feeToken?:string;feePayer?:string;logs?:any[]}) {
 const base = {status:'unknown',reason:'missing-or-unsupported-fee-metadata',feeToken:receipt.feeToken??null,feePayer:receipt.feePayer??null};
 if(!same(receipt.feeToken,TEMPO_PATH_USD)||!/^0x[0-9a-f]{40}$/i.test(receipt.feePayer??'')||!Array.isArray(receipt.logs))return base;
 const matches=receipt.logs.filter(log=>same(log.address,TEMPO_PATH_USD)).flatMap(log=>{try{const event=transfers.parseLog(log);return event&&same(event.args.from,receipt.feePayer!)&&same(event.args.to,TEMPO_FEE_MANAGER)?[{event,log}]:[];}catch{return [];}});
 if(matches.length!==1)return {...base,reason:matches.length?'ambiguous-fee-transfers':'fee-transfer-missing'};
 const {event,log}=matches[0];
 return {status:'confirmed-receipt-transfer',feeToken:TEMPO_PATH_USD,feePayer:receipt.feePayer!,symbol:'PathUSD',decimals:6,amountRaw:event.args.value.toString(),amount:formatUnits(event.args.value,6),logIndex:log.logIndex??log.index??null};
}
