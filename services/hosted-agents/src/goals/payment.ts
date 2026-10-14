import { Contract, Wallet, Interface, keccak256 } from "ethers";
import { InferCredit, ACCOUNT_ABI, type Json } from "@agentfuel/sdk";
import { confirmPaidDelivery } from "@agentfuel/pi-loop/fixed-task";
import { taskPrivateFile } from "../../../../packages/pi-loop/src/task-runner/config.js";
import { openHostedPlannerConnection } from "../autonomy-executor.js";
import type { HostedTaskExecutorConfig } from "../task-executor.js";
import type { HostedExecution } from "../types.js";
import type { GoalState, GoalCall } from "./executor.js";
import { isDeepStrictEqual } from "node:util";
import { voidExpiredGoalPayment } from "./void-payment.js";
const policyABI=new Interface(["function setPolicy(uint256,tuple(uint256 maxCashPerTx,uint256 maxDebtPerTx,uint256 maxDebtPerDay,bool ownerFrozen))"]);
const goalAccountABI=[...ACCOUNT_ABI,"function getPolicy(uint256) view returns(tuple(uint256 maxCashPerTx,uint256 maxDebtPerTx,uint256 maxDebtPerDay,bool ownerFrozen))","function protocolFrozen(uint256) view returns(bool)"];
export async function paidGoalCall(config:HostedTaskExecutorConfig,state:GoalState,call:GoalCall,input:HostedExecution,save:()=>Promise<void>,control:()=>Promise<{paused:boolean;cancelled:boolean}>|undefined){
  const connection=await openHostedPlannerConnection((await taskPrivateFile(config.rpcUrlFile)).trim(),state.input.chainId,config.rpcTransport);
  const rpc=connection.provider, template=config.models[0].templates.conservative;
  const wallet=new Wallet((await taskPrivateFile(input.keyFile)).trim(),rpc), route=state.route;
  let sdk:InferCredit|undefined;
  const guard=async()=>{
    const c=await control();
    const reason=c?.cancelled||input.run.stopRequested?"HOSTED_GOAL_CANCELLED":c?.paused?"HOSTED_AGENT_PAUSED":Date.now()>=state.deadlineMs?"HOSTED_GOAL_DEADLINE":undefined;
    if(reason){
      // SDK persists the signed payment in onHandle before broadcasting. Without
      // a handle/submission this runtime cannot have sent a payment for this call.
      if(!call.handle?.submission&&!call.inference){call.unpaid=true;await save();}
      throw new Error(reason);
    }
  };
  try{
    if(wallet.address.toLowerCase()!==state.input.wallet.toLowerCase()||template.chainId!==state.input.chainId)throw new Error("HOSTED_GOAL_BINDING_CHANGED");
    const account=new Contract(template.account,goalAccountABI,rpc);
    if(!call.inference){
      // Quote receipt is persisted before SDK payment; recovery always uses that exact handle.
      if(!call.handle){
        await guard();
        await input.activity?.({scene:"funding",state:"started",phaseId:call.stage,evidence:{priceRaw:route.priceRaw}});
        const cash=await account.getFunction("cash").staticCall(state.input.chainAgentId);
        await input.activity?.({scene:"funding",state:cash<BigInt(route.priceRaw)?"blocked":"confirmed",phaseId:call.stage,evidence:{cashRaw:String(cash),priceRaw:route.priceRaw},...(cash<BigInt(route.priceRaw)?{reason:"INFERENCE_FUNDING_REQUIRED",requiredAction:"deposit" as const}:{})});
        if(cash<BigInt(route.priceRaw))throw new Error("INFERENCE_FUNDING_REQUIRED");
        const policy=await account.getFunction("getPolicy").staticCall(state.input.chainAgentId);
        if(policy.ownerFrozen||await account.getFunction("protocolFrozen").staticCall(state.input.chainAgentId))throw new Error("HOSTED_AGENT_FROZEN");
        if(policy.maxCashPerTx<BigInt(route.priceRaw)){
          if(!state.policy){
            const tx=await wallet.populateTransaction({to:template.account,chainId:BigInt(state.input.chainId),data:policyABI.encodeFunctionData("setPolicy",[state.input.chainAgentId,{maxCashPerTx:route.priceRaw,maxDebtPerTx:policy.maxDebtPerTx,maxDebtPerDay:policy.maxDebtPerDay,ownerFrozen:false}])});
            const raw=await wallet.signTransaction(tx);state.policy={raw,hash:keccak256(raw)};await save();
          }
          await guard();
          let receipt=await rpc.getTransactionReceipt(state.policy.hash);
          if(!receipt){const sent=await rpc.broadcastTransaction(state.policy.raw);receipt=await sent.wait(1,config.timeoutMs??60000);}
          if(!receipt||receipt.status!==1||(await rpc.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash)throw new Error("HOSTED_GOAL_POLICY_UNCERTAIN");
        }
      }else if(!call.inference){
        const c=await control();
        if(c?.cancelled||c?.paused||input.run.stopRequested||Date.now()>=state.deadlineMs){
          const url=new URL(call.handle.relayUrl);url.pathname=`/payments/${call.handle.quote.paymentId}`;url.search=new URLSearchParams({agentId:call.handle.input.agentId,requestDigest:call.handle.quote.requestDigest}).toString();
          const response=await fetch(url,{signal:AbortSignal.timeout(10000),redirect:"error"});const view=await response.json() as {state:string};
          if(!response.ok)throw new Error("HOSTED_GOAL_RECONCILIATION_REQUIRED");
          if(view.state!=="Delivered"){
            if(view.state==="Quoted"&&!call.handle.submission){
              const payment=await account.getFunction("getPayment").staticCall(call.handle.quote.paymentId);
              if(payment.fromCash===0n&&payment.fromCredit===0n)await guard();
            }
            throw new Error("HOSTED_GOAL_RECONCILIATION_REQUIRED");
          }
        }
      }
      sdk=new InferCredit({agentId:state.input.chainAgentId,signer:wallet,chainId:BigInt(state.input.chainId),account:template.account,asset:template.asset,
        provider:route.provider,maxPrice:BigInt(route.priceRaw),timeoutMs:config.timeoutMs??120000,
        onHandle:async handle=>{if(handle.input.taskId!=="0"||call.handle&&call.handle.quote.paymentId!==handle.quote.paymentId)throw new Error("HOSTED_GOAL_BINDING_CHANGED");call.handle=structuredClone(handle);await save();await input.activity?.({scene:"model",state:"waiting",phaseId:call.stage,evidence:{paymentId:handle.quote.paymentId,priceRaw:handle.quote.price,...(handle.submission?{txHash:handle.submission.txHash}:{})}});},beforePayment:async()=>{await guard();await input.activity?.({scene:"funding",state:"waiting",phaseId:call.stage,evidence:{priceRaw:route.priceRaw,...(call.handle?{paymentId:call.handle.quote.paymentId}:{})}});}});
      call.started=true;await save();
      call.inference=call.handle?await sdk.resume(call.handle):await sdk.fetch(route.relayUrl,{body:{service:route.service,model:route.model,messages:call.messages as unknown as Json[],max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"}}});await save();
    }
    const receipt=call.inference.receipt, quote=call.handle!.quote;
    const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
    if(call.handle!.relayUrl!==route.relayUrl||!isDeepStrictEqual(call.handle!.input,{service:route.service,model:route.model,messages:call.messages,max_completion_tokens:call.max_completion_tokens,thinking:{type:"disabled"},agentId:state.input.chainAgentId,taskId:"0"})
      ||quote.price!==route.priceRaw||quote.model!==route.model||quote.service!==route.service||quote.chainId!==state.input.chainId||quote.agentId!==state.input.chainAgentId||quote.taskId!=="0"||!same(quote.payTo,route.provider)||!same(quote.account,template.account)||!same(quote.asset,template.asset)
      ||receipt.chainId!==quote.chainId||receipt.service!==quote.service||!same(receipt.payTo,quote.payTo)||!same(receipt.account,quote.account)||!same(receipt.asset,quote.asset))throw new Error("HOSTED_GOAL_RECEIPT_INVALID");
    if(receipt.fromCredit!=="0"||receipt.fromCash!==route.priceRaw||receipt.price!==route.priceRaw||receipt.paymentId!==quote.paymentId||receipt.requestDigest!==quote.requestDigest||receipt.model!==route.physicalModel||receipt.taskId!=="0"||receipt.agentId!==state.input.chainAgentId)throw new Error("HOSTED_GOAL_RECEIPT_INVALID");
    await confirmPaidDelivery(call,{chainId:template.chainId,account:template.account,agentId:state.input.chainAgentId,provider:route.provider,taskId:"0"},rpc,wallet);
    // Accounting must survive an observer failure before entry.response exists.
    // Only the canonical delivery proof above permits this charge, never an
    // unverified provider receipt. Recovery still uses the original inference.
    call.recovery={chargedRaw:receipt.fromCash,refundedRaw:"0",resolved:false};await save();
    await input.activity?.({scene:"funding",state:"confirmed",phaseId:call.stage,evidence:{paymentId:receipt.paymentId,txHash:receipt.txHash,fromCashRaw:receipt.fromCash,fromCreditRaw:receipt.fromCredit,chargedRaw:receipt.price}});
    const result=call.inference.result as {model?:string;choices?:{message?:{content?:string}}[];usage?:{prompt_tokens?:number;completion_tokens?:number}};
    const validUsage=[result?.usage?.prompt_tokens,result?.usage?.completion_tokens].every(n=>Number.isSafeInteger(n)&&Number(n)>=0)&&isDeepStrictEqual(receipt.usage,result.usage);
    const deliveryError=result?.model!==(route.responseModel??route.physicalModel)?"HOSTED_GOAL_MODEL_CHANGED":!validUsage?"HOSTED_GOAL_OUTPUT_INVALID":undefined;
    return{text:result?.choices?.[0]?.message?.content??"",chargedRaw:receipt.fromCash,promptTokens:validUsage?result.usage!.prompt_tokens!:0,completionTokens:validUsage?result.usage!.completion_tokens!:0,paymentId:receipt.paymentId,txHash:receipt.txHash,...(deliveryError?{deliveryError}:{})};
  }catch(error){
    // Record canonical cash movement even when the vendor/relay response is lost.
    // Recovery never invents a new quote and never redispatches a refunded call.
    if(call.handle&&!call.inference){
      await input.activity?.({scene:"interruption",state:"reconciling",phaseId:call.stage,reason:"HOSTED_GOAL_RECONCILIATION_REQUIRED",evidence:{paymentId:call.handle.quote.paymentId,...(call.handle.submission?{txHash:call.handle.submission.txHash}:{})}});
      try{const recovered=await voidExpiredGoalPayment(state,call,template.account,template.asset,rpc,wallet,save,config.timeoutMs??60000);if(recovered){call.recovery=recovered;await save();await input.activity?.({scene:"interruption",state:recovered.resolved?BigInt(recovered.refundedRaw)>0n?"refunded":recovered.voided?"cancelled":"failed":"reconciling",phaseId:call.stage,evidence:{paymentId:call.handle!.quote.paymentId,chargedRaw:recovered.chargedRaw,refundedRaw:recovered.refundedRaw}});}}
      catch{/* Preserve unresolved reservation if any evidence cannot be confirmed. */}
      if(call.recovery?.resolved)throw new Error(call.recovery.voided?"HOSTED_GOAL_PAYMENT_VOIDED":call.recovery.reverted?"HOSTED_GOAL_PAYMENT_REVERTED":"HOSTED_GOAL_UNDELIVERED_REFUNDED");
    }
    throw error;
  }finally{sdk?.close();connection.close();}
}
