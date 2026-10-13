import { Contract, Transaction, Wallet, keccak256, ZeroAddress, type JsonRpcProvider } from 'ethers';
import { ACCOUNT_ABI } from '@agentfuel/sdk';
import { TEMPO_PATH_USD, TEMPO_FEE_MANAGER } from '../../../../scripts/tempo-config.js';
import type { GoalState, GoalCall } from './executor.js';
import { reconcileGoalPayment } from './reconciliation.js';

/** Replace only an expired, unpaid signature. Persist replacement bytes before
 * broadcast; recovery must never sign a new payment or silently release funds. */
export async function voidExpiredGoalPayment(state:GoalState,call:GoalCall,accountAddress:string,asset:string,rpc:JsonRpcProvider,wallet:Pick<Wallet,'address'|'signTransaction'>,save:()=>Promise<void>,timeoutMs:number){
 const reconciled=await reconcileGoalPayment(state,call,accountAddress,asset,rpc);
 if(reconciled)return reconciled;
 const h=call.handle;
 if(!h)return;
 const head=await rpc.getBlock('latest');
 if(!head?.hash||BigInt(h.quote.quoteExpiry)>=BigInt(head.timestamp))return;
 const account=new Contract(accountAddress,ACCOUNT_ABI,rpc);
 const payment=await account.getFunction('getPayment').staticCall(h.quote.paymentId,{blockTag:head.number});
 if(payment.agentId!==0n||payment.fromCash!==0n||payment.fromCredit!==0n||payment.refundedAmount!==0n)return;
 if(!h.submission)return {chargedRaw:'0',refundedRaw:'0',resolved:true,voided:true};
 if(!h.submission.rawTransaction||!h.submission.txHash)return;
 // reconcileGoalPayment above has validated the complete quote and signed call.
 const original=Transaction.from(h.submission.rawTransaction);
 if(wallet.address.toLowerCase()!==state.input.wallet.toLowerCase())throw Error('HOSTED_GOAL_BINDING_CHANGED');
 if(await rpc.getTransactionReceipt(h.submission.txHash))return;
 if(await rpc.getTransactionCount(wallet.address,head.number)!==original.nonce)return;
 if((await rpc.getBlock(head.number))?.hash!==head.hash)throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
 const tempoAssetGuard=async()=>{
  if(asset.toLowerCase()!==TEMPO_PATH_USD||original.type!==2)throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
  const token=new Contract(TEMPO_PATH_USD,['function decimals() view returns(uint8)','function symbol() view returns(string)','function balanceOf(address) view returns(uint256)'],rpc);
  const manager=new Contract(TEMPO_FEE_MANAGER,['function userTokens(address) view returns(address)'],rpc);
  const [decimals,symbol,balance,preference]=await Promise.all([token.decimals({blockTag:head.number}),token.symbol({blockTag:head.number}),token.balanceOf(wallet.address,{blockTag:head.number}),manager.userTokens(wallet.address,{blockTag:head.number})]);
  if(decimals!==6n||symbol!=='PathUSD'||balance<=0n||![ZeroAddress,TEMPO_PATH_USD].includes(String(preference).toLowerCase()))throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
  if((await rpc.getBlock(head.number))?.hash!==head.hash)throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
 };
 if(!call.voidSubmission){
  const fees=await rpc.getFeeData(),bump=(n:bigint)=>n*125n/100n+1n,max=(a:bigint,b:bigint)=>a>b?a:b;
  const priority=max(fees.maxPriorityFeePerGas??0n,bump(original.maxPriorityFeePerGas??original.gasPrice??0n));
  const fee=max(max(fees.maxFeePerGas??fees.gasPrice??0n,bump(original.maxFeePerGas??original.gasPrice??0n)),priority);
  let gasLimit=21000n;
  if(state.input.chainId==='42431'){
   // Ethereum type-2 is supported by Tempo, but its intrinsic gas is not 21k.
   // Estimate the exact self-transfer with the configured PathUSD fee asset.
   await tempoAssetGuard();
   // Limit the replacement to the original signed gas budget and at most a
   // twofold fee bump. Missing/insufficient evidence leaves the call Unknown.
   const estimate=await rpc.estimateGas({from:wallet.address,to:wallet.address,value:0n,data:'0x',type:2,nonce:original.nonce,maxFeePerGas:fee,maxPriorityFeePerGas:priority});
   gasLimit=(estimate*120n+99n)/100n;
   if(gasLimit<=0n||gasLimit>original.gasLimit||gasLimit>10_000_000n||!original.maxFeePerGas||fee>original.maxFeePerGas*2n)throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
   if((await rpc.getBlock(head.number))?.hash!==head.hash)throw Error('HOSTED_GOAL_PAYMENT_UNCONFIRMED');
  }
  const raw=await wallet.signTransaction({type:2,chainId:BigInt(state.input.chainId),nonce:original.nonce,to:wallet.address,value:0n,data:'0x',gasLimit,maxFeePerGas:fee,maxPriorityFeePerGas:priority});
  call.voidSubmission={raw,hash:keccak256(raw)};await save();
 }
 const cancel=Transaction.from(call.voidSubmission.raw);
 if(cancel.hash!==call.voidSubmission.hash||cancel.type!==2||cancel.chainId!==original.chainId||cancel.nonce!==original.nonce||cancel.from?.toLowerCase()!==wallet.address.toLowerCase()||cancel.to?.toLowerCase()!==wallet.address.toLowerCase()||cancel.value!==0n||cancel.data!=='0x'||(state.input.chainId==='42431'?(asset.toLowerCase()!==TEMPO_PATH_USD||original.type!==2||cancel.gasLimit<=0n||cancel.gasLimit>original.gasLimit||cancel.gasLimit>10_000_000n||!original.maxFeePerGas||!cancel.maxFeePerGas||cancel.maxFeePerGas>original.maxFeePerGas*2n):cancel.gasLimit!==21000n))throw Error('HOSTED_GOAL_BINDING_CHANGED');
 try{
  if(!await rpc.getTransactionReceipt(call.voidSubmission.hash)){
   // Type-2 bytes do not bind the mutable fee-token preference. Recheck it on
   // every rebroadcast without signing another replacement.
   if(state.input.chainId==='42431')await tempoAssetGuard();
   const tx=await rpc.broadcastTransaction(call.voidSubmission.raw);await tx.wait(1,timeoutMs);
  }
 }catch{
  // Either the original or its replacement can win the nonce race. Only chain
  // reconciliation decides the outcome, never a broadcast response or timeout.
 }
 return reconcileGoalPayment(state,call,accountAddress,asset,rpc);
}
