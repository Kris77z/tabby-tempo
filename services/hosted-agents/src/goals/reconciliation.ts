import { Contract, Transaction, type JsonRpcProvider, keccak256, toUtf8Bytes } from "ethers";
import { ACCOUNT_ABI, accountInterface, managerInterface, requestDigest, paymentId, canonical, type Json } from "@agentfuel/sdk";
import { isDeepStrictEqual } from "node:util";
import type { GoalCall, GoalState } from "./executor.js";

export interface GoalPaymentRecovery { chargedRaw:string; refundedRaw:string; resolved:boolean; reverted?:boolean; voided?:boolean }
/** Read-only proof. An unknown vendor dispatch is terminal only after explicit
 * nondelivery resolution and its canonical full refund; a timeout is not proof. */
export async function reconcileGoalPayment(state:GoalState, call:GoalCall, accountAddress:string, asset:string, rpc:JsonRpcProvider):Promise<GoalPaymentRecovery|undefined>{
 const handle=call.handle;if(!handle)return;
 const quote=handle.quote,route=state.route,same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
 const hash=(v:unknown):v is string=>typeof v==="string"&&/^0x[0-9a-f]{64}$/.test(v);
 if(handle.version!==1||handle.relayUrl!==route.relayUrl||quote.chainId!==state.input.chainId||!same(quote.account,accountAddress)||!same(quote.asset,asset)||!same(quote.payTo,route.provider)||quote.agentId!==state.input.chainAgentId||quote.taskId!=="0"||quote.service!==route.service||quote.model!==route.model||quote.price!==route.priceRaw
  ||quote.requestDigest!==requestDigest(handle.input)||quote.paymentId!==paymentId("0",quote.requestDigest,quote.serverNonce)
  ||!isDeepStrictEqual(handle.input,{service:route.service,model:route.model,messages:call.messages,max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"},agentId:state.input.chainAgentId,taskId:"0"}))throw new Error("HOSTED_GOAL_BINDING_CHANGED");
 if(BigInt(await rpc.send("eth_chainId",[]))!==BigInt(state.input.chainId))throw new Error("HOSTED_GOAL_BINDING_CHANGED");
 if(!handle.submission?.txHash)return;
 const account=new Contract(accountAddress,ACCOUNT_ABI,rpc),head=await rpc.getBlock("latest");if(!head?.hash)return;
 const [payment,transaction,receipt]=await Promise.all([account.getFunction("getPayment").staticCall(quote.paymentId,{blockTag:head.number}),rpc.getTransaction(handle.submission.txHash),rpc.getTransactionReceipt(handle.submission.txHash)]);
 if(!receipt){
  // An expired signed payment can be closed only once the nonce is canonically
  // consumed and this payment still has zero value. Expiry alone proves nothing.
  if(!handle.submission.rawTransaction||BigInt(quote.quoteExpiry)>=BigInt(head.timestamp)||payment.agentId!==0n||payment.fromCash!==0n||payment.fromCredit!==0n||payment.refundedAmount!==0n)return;
  const signed=Transaction.from(handle.submission.rawTransaction),op=accountInterface.parseTransaction({data:signed.data,value:signed.value});
  if(signed.value!==0n||signed.hash!==handle.submission.txHash||!signed.from||!same(signed.from,state.input.wallet)||!same(handle.submission.from,state.input.wallet)||signed.nonce!==handle.submission.nonce||signed.chainId!==BigInt(state.input.chainId)||!signed.to||!same(signed.to,accountAddress)||!op||op.name!=="payProvider"||op.args[0]!==BigInt(state.input.chainAgentId)||!same(op.args[1],route.provider)||op.args[2]!==BigInt(quote.price)||op.args[3]!==quote.paymentId)throw new Error("HOSTED_GOAL_BINDING_CHANGED");
  if(await rpc.getTransactionCount(state.input.wallet,head.number)<=handle.submission.nonce)return;
  if((await rpc.getBlock(head.number))?.hash!==head.hash)throw new Error("HOSTED_GOAL_PAYMENT_UNCONFIRMED");
  return {chargedRaw:"0",refundedRaw:"0",resolved:true,voided:true};
 }
 const paidBlock=await rpc.getBlock(receipt.blockNumber),operation=transaction&&accountInterface.parseTransaction({data:transaction.data,value:transaction.value});
 if(receipt.status===0){
  if(receipt.hash!==handle.submission.txHash||paidBlock?.hash!==receipt.blockHash||receipt.blockNumber>head.number||!transaction?.to||!same(transaction.to,accountAddress)||!same(transaction.from,state.input.wallet)||transaction.nonce!==handle.submission.nonce||!same(handle.submission.from,state.input.wallet)
   ||!operation||operation.name!=="payProvider"||operation.args[0]!==BigInt(state.input.chainAgentId)||!same(operation.args[1],route.provider)||operation.args[2]!==BigInt(quote.price)||operation.args[3]!==quote.paymentId
   ||payment.agentId!==0n||payment.fromCash!==0n||payment.fromCredit!==0n||payment.refundedAmount!==0n||(await rpc.getBlock(head.number))?.hash!==head.hash)throw new Error("HOSTED_GOAL_PAYMENT_UNCONFIRMED");
  return{chargedRaw:"0",refundedRaw:"0",resolved:true,reverted:true};
 }
 if(receipt.status!==1)return;
 const events=receipt.logs.filter(log=>same(log.address,accountAddress)).flatMap(log=>{try{const e=accountInterface.parseLog(log);return e?.name==="ProviderPaid"?[e]:[];}catch{return[];}});
 if(!transaction?.to||!same(transaction.to,accountAddress)||!same(transaction.from,state.input.wallet)||transaction.nonce!==handle.submission.nonce||!same(handle.submission.from,state.input.wallet)||receipt.hash!==handle.submission.txHash||paidBlock?.hash!==receipt.blockHash||receipt.blockNumber>head.number
  ||payment.agentId!==BigInt(state.input.chainAgentId)||payment.taskId!==0n||payment.fromCash!==BigInt(quote.price)||payment.fromCredit!==0n||payment.refundedAmount>payment.fromCash
  ||!operation||operation.name!=="payProvider"||operation.args[0]!==BigInt(state.input.chainAgentId)||!same(operation.args[1],route.provider)||operation.args[2]!==BigInt(quote.price)||operation.args[3]!==quote.paymentId
  ||events.length!==1||events[0].args.paymentId!==quote.paymentId||events[0].args.agentId!==BigInt(state.input.chainAgentId)||!same(events[0].args.provider,route.provider)||events[0].args.fromCash!==payment.fromCash||events[0].args.fromCredit!==0n)throw new Error("HOSTED_GOAL_PAYMENT_UNCONFIRMED");
 if((await rpc.getBlock(head.number))?.hash!==head.hash)throw new Error("HOSTED_GOAL_PAYMENT_UNCONFIRMED");
 const paid={chargedRaw:quote.price,refundedRaw:"0",resolved:false};
 try{
  const url=new URL(handle.relayUrl);url.pathname=`/payments/${quote.paymentId}`;url.search=new URLSearchParams({agentId:state.input.chainAgentId,requestDigest:quote.requestDigest}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:"error"});if(!response.ok)return paid;
  const view=await response.json() as {state?:string;paymentId?:string;refundedAmount?:string;result?:unknown;receipt?:unknown;upstreamAttempts?:{state:string}[];operatorResolution?:{version:number;paymentId:string;resolutionId:string;expectedAttemptsDigest:string;evidenceDigest:string;reason:string;resolvedAt:number};confirmedRefunds?:{refundId:string;amount:string;txHash:string}[]};
  const resolution=view.operatorResolution,refunds=view.confirmedRefunds;
  if(view.state!=="Refunded"||view.paymentId!==quote.paymentId||view.refundedAmount!==quote.price||payment.refundedAmount!==BigInt(quote.price)||view.result!==undefined||view.receipt!==undefined||!resolution||resolution.version!==1||resolution.paymentId!==quote.paymentId
   ||resolution.reason!=="operator-accepted-nondelivery-cost"||!Number.isSafeInteger(resolution.resolvedAt)||resolution.resolvedAt<=0||!(hash(resolution.resolutionId)||/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(resolution.resolutionId))||!hash(resolution.evidenceDigest)
   ||!view.upstreamAttempts?.some(a=>a.state==="Unknown")||view.upstreamAttempts.some(a=>!["Unknown","Rejected"].includes(a.state))||resolution.expectedAttemptsDigest!==keccak256(toUtf8Bytes(canonical(view.upstreamAttempts as unknown as Json)))
   ||!refunds||refunds.length!==1||!hash(refunds[0].refundId)||!hash(refunds[0].txHash)||refunds[0].amount!==quote.price)return paid;
  const manager=await account.getFunction("creditManager").staticCall({blockTag:head.number}),refund=refunds[0],refundReceipt=await rpc.getTransactionReceipt(refund.txHash);
  if(!refundReceipt||refundReceipt.status!==1||refundReceipt.hash!==refund.txHash||refundReceipt.blockNumber>head.number||(await rpc.getBlock(refundReceipt.blockNumber))?.hash!==refundReceipt.blockHash)return paid;
  const refundsEvents=refundReceipt.logs.filter(log=>same(log.address,manager)).flatMap(log=>{try{const e=managerInterface.parseLog(log);return e?.name==="RefundProcessed"?[e]:[];}catch{return[];}});
  if(refundsEvents.length!==1||refundsEvents[0].args.paymentId!==quote.paymentId||refundsEvents[0].args.refundId!==refund.refundId||refundsEvents[0].args.amount!==BigInt(quote.price)||refundsEvents[0].args.debtReduced!==0n||refundsEvents[0].args.toCash!==BigInt(quote.price)||(await rpc.getBlock(head.number))?.hash!==head.hash)return paid;
  return{chargedRaw:"0",refundedRaw:quote.price,resolved:true};
 }catch{return paid;}
}
