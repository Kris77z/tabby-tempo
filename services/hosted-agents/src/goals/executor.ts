import {collectChainResearch,type ChainResearch} from './chain-lookup.js';
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionStore } from "@agentfuel/pi-loop/session";
import type { Inference, PaymentHandle } from "@agentfuel/sdk";
import { HostedError, type HostedExecution, type HostedExecutor, type HostedResult } from "../types.js";
import { validGoal, validateGoalView, type GoalView } from "../goal-types.js";
import { missionSystem, specialistSystem, reviewSystem, parseMissionPlan, parseMissionReview } from "./commander.js";
import { paidGoalCall } from "./payment.js";
import type { HostedTaskExecutorConfig } from "../task-executor.js";
import { taskLoopbackUrl } from "../../../../packages/pi-loop/src/task-runner/config.js";
import { getAddress } from "ethers";
import type { GoalPaymentRecovery } from "./reconciliation.js";
import { specialistPrompt, normalizeSpecialistOutput } from "../specialists/execution.js";
import { specialistOutputContract } from "../specialists/catalog.js";
import { inspectGoalArtifact } from "./acceptance.js";
export interface GoalModelRoute { id:string; relayUrl:string; provider:string; priceRaw:string; service:string; model:string; physicalModel:string; responseModel?:string }
export interface HostedGoalConfig { models:GoalModelRoute[]; durationMs:number; chainLookup?:boolean }
export interface GoalCall { stage:string; serviceId?:string; promptDigest?:string; messages:{role:string;content:string}[]; max_completion_tokens:number; handle?:PaymentHandle; inference?:Inference; started?:boolean; unpaid?:boolean; voidSubmission?:{raw:string;hash:string}; recovery?:GoalPaymentRecovery; response?:{text:string;chargedRaw:string;promptTokens:number;completionTokens:number;paymentId?:string;txHash?:string;deliveryError?:string} }
export interface GoalState { version:1; lookupEnabled?:boolean; research?:ChainResearch; binding:string; deadlineMs:number; route:GoalModelRoute; input:{goal:string;owner:string;wallet:string;agentId:string;chainAgentId:string;chainId:string;strategy:string;reservedRaw:string}; view:GoalView; calls:GoalCall[]; result?:HostedResult; policy?:{raw:string;hash:string} }
export interface GoalDependencies {
  lookup?:typeof collectChainResearch;
  control?(agentId:string,requestId:string):Promise<{paused:boolean;cancelled:boolean}>;
  call?(state:GoalState,call:GoalCall,input:HostedExecution,save:()=>Promise<void>):Promise<NonNullable<GoalCall['response']>>;
}
export function validateHostedGoalConfig(v:HostedGoalConfig):HostedGoalConfig {
  if(!v||v.chainLookup!==undefined&&typeof v.chainLookup!=="boolean"||!Array.isArray(v.models)||!v.models.length||v.models.length>8||new Set(v.models.map(m=>m.id)).size!==v.models.length||!Number.isInteger(v.durationMs)||v.durationMs<1000||v.durationMs>3600000)throw new HostedError("HOSTED_GOAL_CONFIG_INVALID",503);
  for(const m of v.models){taskLoopbackUrl(m.relayUrl);getAddress(m.provider);if(!/^[1-9][0-9]{0,29}$/.test(m.priceRaw)||[m.id,m.service,m.model,m.physicalModel,m.responseModel??m.physicalModel].some(x=>typeof x!=="string"||!x||x.length>120))throw new HostedError("HOSTED_GOAL_CONFIG_INVALID",503);}
  return structuredClone(v);
}
const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class HostedGoalExecutor implements HostedExecutor {
  readonly config:HostedGoalConfig;
  constructor(config:HostedGoalConfig,private task:HostedTaskExecutorConfig,private deps:GoalDependencies={}){this.config=validateHostedGoalConfig(config);}
  async execute(input:HostedExecution):Promise<HostedResult>{
    if(input.run.action!=="goal"||!validGoal(input.run.goal)||input.agent.configurationRequired||!input.agent.binding||input.run.agentId!==input.agent.id||!/^[1-9][0-9]{0,29}$/.test(input.run.reservedRaw))throw new HostedError("HOSTED_GOAL_INVALID");
    const identity={goal:input.run.goal,owner:input.agent.owner,wallet:input.agent.wallet,agentId:input.agent.id,chainAgentId:input.agent.binding.agentId,chainId:input.agent.binding.chainId,strategy:input.agent.strategy,reservedRaw:input.run.reservedRaw};
    const binding=digest({requestId:input.run.requestId,...identity});
    const store=new SessionStore<GoalState>(join(input.directory,"mission"));await store.start(input.recover);
    let state:GoalState;
    try{
      const saved=await store.read();if(saved&&saved.binding!==binding)throw new HostedError("HOSTED_GOAL_BINDING_CHANGED",409);
      const route=this.config.models.find(m=>m.id===input.agent.modelId);if(!saved&&!route)throw new HostedError("HOSTED_GOAL_MODEL_UNAVAILABLE");
      state=saved??{version:1,lookupEnabled:this.config.chainLookup===true,binding,input:identity,route:structuredClone(route!),deadlineMs:Date.now()+this.config.durationMs,view:{stage:"planning",phases:[],calls:[]},calls:[]};
      const save=()=>store.write(state);
      const publish=async()=>{state.view=validateGoalView(state.view);await save();await input.progress?.(state.view);};
      const total=()=>state.view.calls.reduce((sum,c)=>sum+BigInt(c.chargedRaw),0n)+state.calls.filter(c=>!state.view.calls.some(v=>v.stage===c.stage)).reduce((sum,c)=>sum+BigInt(c.recovery?.chargedRaw??"0"),0n);
      const refunded=()=>state.calls.reduce((sum,c)=>sum+BigInt(c.recovery?.refundedRaw??"0"),0n).toString();
      const finish=async(stage:GoalView['stage'],success:boolean,reason?:string)=>{
        state.view.stage=stage;state.result={phase:stage==="completed"?"Completed":stage==="cancelled"?"Cancelled":"Stopped",terminal:true,success,chargedRaw:total().toString(),refundedRaw:refunded(),mission:validateGoalView(state.view),...(reason?{reason}:{})};await publish();return state.result;
      };
      if(state.result)return structuredClone(state.result);
      await publish();
      const call=async(stage:string,system:string,user:string,maxTokens:number,specialist?:{serviceId:string;promptDigest:string})=>{
        let entry=state.calls.find(c=>c.stage===stage);
        if(entry?.recovery?.resolved)throw new Error(entry.recovery.voided?"HOSTED_GOAL_PAYMENT_VOIDED":entry.recovery.reverted?"HOSTED_GOAL_PAYMENT_REVERTED":"HOSTED_GOAL_UNDELIVERED_REFUNDED");
        const control=await this.deps.control?.(input.agent.id,input.run.requestId);
        if(!entry?.started){
          if(control?.cancelled||input.run.stopRequested)throw new Error("HOSTED_GOAL_CANCELLED");
          if(control?.paused)throw new Error("HOSTED_AGENT_PAUSED");
          if(Date.now()>=state.deadlineMs)throw new Error("HOSTED_GOAL_DEADLINE");
          if(total()+BigInt(state.route.priceRaw)>BigInt(input.run.reservedRaw))throw new Error("HOSTED_GOAL_BUDGET_REQUIRED");
        }
        if(!entry){if(Buffer.byteLength(JSON.stringify({system,user}))>112000)throw Error("HOSTED_GOAL_INPUT_TOO_LARGE");entry={stage,...(specialist?{serviceId:specialist.serviceId,promptDigest:specialist.promptDigest}:{}),messages:[{role:"system",content:system},{role:"user",content:user}],max_completion_tokens:maxTokens};state.calls.push(entry);await save();}
        if(!entry.response){
          // Persist dispatch intent before crossing the payment boundary. A timeout
          // remains unresolved until the same call is reconciled, including on stop.
          entry.started=true;entry.unpaid=false;await save();
          entry.response=await(this.deps.call?this.deps.call(state,entry,input,save):paidGoalCall(this.task,state,entry,input,save,()=>this.deps.control?.(input.agent.id,input.run.requestId)));await save();
        }
        const r=entry.response;
        if(r.chargedRaw!==state.route.priceRaw||![r.promptTokens,r.completionTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error("HOSTED_GOAL_DELIVERY_INVALID");
        if(!state.view.calls.some(c=>c.stage===stage)){state.view.calls.push({stage,model:state.route.id,chargedRaw:r.chargedRaw,promptTokens:r.promptTokens,completionTokens:r.completionTokens,...(r.paymentId?{paymentId:r.paymentId}:{}),...(r.txHash?{txHash:r.txHash}:{}),...(entry.serviceId?{serviceId:entry.serviceId,promptDigest:entry.promptDigest}:{}),...(entry.handle?{requestDigest:entry.handle.quote.requestDigest}:{})});await publish();}
        // A canonically paid but unusable response still consumed budget.
        if(r.deliveryError)throw new Error(r.deliveryError);
        if(typeof r.text!=="string"||!r.text.trim()||r.text.length>24000)throw new Error("HOSTED_GOAL_OUTPUT_INVALID");
        return r.text;
      };
      try{
        if(state.lookupEnabled&&!state.research&&!state.calls.length){
          const control=await this.deps.control?.(input.agent.id,input.run.requestId);
          if(control?.cancelled||input.run.stopRequested)return await finish('cancelled',false,'HOSTED_GOAL_CANCELLED');
          if(control?.paused)throw Error('HOSTED_AGENT_PAUSED');
          state.research=await(this.deps.lookup??collectChainResearch)(identity.goal,identity.chainId,this.task);
          if(state.research){state.view.research=state.research.evidence;await publish();}
        }
        const research=state.research?{chainResearch:JSON.parse(state.research.context),researchDigest:state.research.evidence.digest}:{};
        if(!state.view.phases.length){const plan=parseMissionPlan(await call("plan",missionSystem,state.research?JSON.stringify({originalGoal:identity.goal,...research}):identity.goal,1024));
          if(plan.needsInput){state.view.answer=plan.needsInput;return await finish("needs-input",false,"HOSTED_GOAL_NEEDS_INPUT");}
          state.view.phases=plan.phases;await publish();}
        for(let index=0;index<state.view.phases.length;index++){
          const phase=state.view.phases[index];
          if(phase.output)continue;state.view.stage="executing";await publish();
          const profile=specialistPrompt(phase.taskType,specialistSystem,identity.chainId);
          const output=normalizeSpecialistOutput(phase.taskType,await call(`phase-${index}`,profile.system,JSON.stringify({originalGoal:identity.goal,...research,assignment:phase,previous:state.view.phases.slice(0,index)}),2048,profile));
          state.view.phases[index].output=output;
          state.view.answer=output;await publish();
        }
        state.view.stage="reviewing";await publish();
        const originalArtifact=state.view.phases.at(-1)!.output!;
        const reviewArtifact=async(stage:string,artifact:string)=>{
          const measurement=inspectGoalArtifact(identity.goal,artifact,state.research?.evidence.observedAt);
          const review=parseMissionReview(await call(stage,reviewSystem,JSON.stringify({originalGoal:identity.goal,...research,plan:state.view.phases.map(({output,...p})=>p),outputContract:specialistOutputContract(state.view.phases.at(-1)!.taskType),artifact,measuredLengths:measurement}),1536));
          if(measurement.failures.length){review.passed=false;review.summary=`验收未通过：${measurement.failures.join(" ")}`.slice(0,4000);review.checks=[...measurement.failures,...review.checks].slice(0,20).map(c=>c.slice(0,1000));}
          return review;
        };
        const firstReview=await reviewArtifact("review",originalArtifact);state.view.review=firstReview;
        // One revision only, including its independent re-review in the budget.
        if(!state.view.review.passed&&(state.calls.some(c=>c.stage==="revision")||total()+2n*BigInt(state.route.priceRaw)<=BigInt(input.run.reservedRaw))){
          await publish();
          const measured=inspectGoalArtifact(identity.goal,originalArtifact);
          const compression=measured.maxCharacters!==undefined?`当前 ${measured.characters} 个非空白字符，上限 ${measured.maxCharacters}；本次请重写为不超过 ${Math.max(1,Math.floor(measured.maxCharacters*0.8))} 个非空白 Unicode 字符，留出计数余量。标点、数字、Markdown 符号也计入。优先去掉粗体等 Markdown 装饰、重复原始数据列、重复结论和冗余说明；保留用户要求的全部指标、计算、建议和邮件等交付物。精简重写，不要直接截断或遗漏必需内容。`:measured.maxWords!==undefined?`Rewrite to at most ${Math.max(1,Math.floor(measured.maxWords*0.8))} words, below the hard ${measured.maxWords}-word limit. Remove repetition and formatting, preserving every required deliverable; do not truncate.`:undefined;
          const revisionType=state.view.phases.at(-1)!.taskType,profile=specialistPrompt(revisionType,specialistSystem,identity.chainId);
          const revised=normalizeSpecialistOutput(revisionType,await call("revision",profile.system,JSON.stringify({originalGoal:identity.goal,...research,artifact:originalArtifact,review:state.view.review,measuredLengths:measured,...(compression?{compressionTarget:compression}:{}),assignment:"Revise the complete artifact to resolve all review findings. Return only the full corrected deliverable. Preserve all required facts and deliverables, remove unsupported facts or dates, and obey the compression target."}),2048,profile));
          state.view.answer=revised;await publish();
          const revisedReview=await reviewArtifact("revision-review",revised);state.view.review=revisedReview;
        }
        return await finish("completed",state.view.review.passed,state.view.review.passed?undefined:"HOSTED_GOAL_REVIEW_FAILED");
      }catch(error){
        let code=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:"HOSTED_GOAL_CALL_UNCERTAIN";
        const unresolved=state.calls.some(c=>c.started&&!c.response&&!c.unpaid&&!c.recovery?.resolved);
        if(!unresolved&&code==="HOSTED_GOAL_PAYMENT_VOIDED"&&(input.run.stopRequested||(await this.deps.control?.(input.agent.id,input.run.requestId))?.cancelled))return await finish("cancelled",false,code);
        if(!unresolved&&["HOSTED_GOAL_PAYMENT_VOIDED","HOSTED_GOAL_INPUT_TOO_LARGE","HOSTED_GOAL_LOOKUP_LIMIT","HOSTED_GOAL_LOOKUP_NETWORK","HOSTED_GOAL_CANCELLED","HOSTED_GOAL_DEADLINE","HOSTED_GOAL_BUDGET_REQUIRED","HOSTED_GOAL_PLAN_INVALID","HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID","HOSTED_GOAL_REVIEW_INVALID","HOSTED_GOAL_OUTPUT_INVALID","HOSTED_GOAL_MODEL_CHANGED","HOSTED_GOAL_UNDELIVERED_REFUNDED","HOSTED_GOAL_PAYMENT_REVERTED"].includes(code))return await finish(code==="HOSTED_GOAL_CANCELLED"?"cancelled":"paused",false,code);
        if(unresolved&&["HOSTED_GOAL_CANCELLED","HOSTED_GOAL_DEADLINE"].includes(code))code="HOSTED_GOAL_RECONCILIATION_REQUIRED";
        state.view.stage="paused";await publish();return{phase:"Paused",terminal:false,success:false,chargedRaw:total().toString(),refundedRaw:refunded(),reason:code,mission:state.view};
      }
    }finally{await store.close();}
  }
}
