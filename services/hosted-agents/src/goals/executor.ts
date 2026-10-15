import {chainTargets,collectChainResearch,type ChainResearch} from './chain-lookup.js';
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionStore } from "@agentfuel/pi-loop/session";
import type { Inference, PaymentHandle } from "@agentfuel/sdk";
import { HostedError, type HostedExecution, type HostedExecutor, type HostedResult } from "../types.js";
import { validGoal, validateGoalView, type GoalView } from "../goal-types.js";
import { missionSystem, specialistSystem, reviewSystem, parseMissionPlan, parseMissionReview } from "./commander.js";
import { paidGoalCall, readGoalCash } from "./payment.js";
import type { HostedTaskExecutorConfig } from "../task-executor.js";
import { taskLoopbackUrl } from "../../../../packages/pi-loop/src/task-runner/config.js";
import { getAddress } from "ethers";
import type { GoalPaymentRecovery } from "./reconciliation.js";
import { specialistPrompt, normalizeSpecialistOutput } from "../specialists/execution.js";
import { missionSpecialists, resolveSpecialist, specialistOutputContract } from "../specialists/catalog.js";
import { inspectGoalArtifact } from "./acceptance.js";
import { discoverExternalServices, rankExternalServices, validateExternalHiringConfig, type ExternalHiringConfig, type ExternalServiceSnapshot } from "../external/registry.js";
import { prepareExternalHire, executeExternalHire, type ExternalHireState } from "../external/hiring.js";
import { openHostedPlannerConnection } from "../autonomy-executor.js";
import { taskPrivateFile } from "../../../../packages/pi-loop/src/task-runner/config.js";
export interface GoalModelRoute { id:string; relayUrl:string; provider:string; priceRaw:string; service:string; model:string; physicalModel:string; responseModel?:string }
export interface HostedGoalConfig { models:GoalModelRoute[]; durationMs:number; chainLookup?:boolean; external?:ExternalHiringConfig }
export interface GoalCall { stage:string; route?:GoalModelRoute; futureReserveRaw?:string; policy?:{raw:string;hash:string;receipt?:{txHash:string;status:0|1;blockNumber:number;blockHash:string}}; serviceId?:string; promptDigest?:string; messages:{role:string;content:string}[]; max_completion_tokens:number; handle?:PaymentHandle; inference?:Inference; started?:boolean; unpaid?:boolean; voidSubmission?:{raw:string;hash:string}; recovery?:GoalPaymentRecovery; response?:{text:string;chargedRaw:string;promptTokens:number;completionTokens:number;paymentId?:string;txHash?:string;deliveryError?:string} }
export interface GoalState { version:1; lookupEnabled?:boolean; research?:ChainResearch; externalConfig?:ExternalHiringConfig; externalServices?:ExternalServiceSnapshot[]; externalHires?:Record<string,ExternalHireState>; binding:string; deadlineMs:number; route:GoalModelRoute; routes?:GoalModelRoute[]; input:{goal:string;owner:string;wallet:string;agentId:string;chainAgentId:string;chainId:string;strategy:string;reservedRaw:string}; view:GoalView; calls:GoalCall[]; result?:HostedResult; policy?:GoalCall['policy'] }
export interface GoalDependencies {
  lookup?:typeof collectChainResearch;
  discover?:typeof discoverExternalServices;
  cash?(state:GoalState):Promise<string>;
  control?(agentId:string,requestId:string):Promise<{paused:boolean;cancelled:boolean}>;
  call?(state:GoalState,call:GoalCall,input:HostedExecution,save:()=>Promise<void>):Promise<NonNullable<GoalCall['response']>>;
}
export function validateHostedGoalConfig(v:HostedGoalConfig):HostedGoalConfig {
  if(!v||v.chainLookup!==undefined&&typeof v.chainLookup!=="boolean"||!Array.isArray(v.models)||!v.models.length||v.models.length>8||new Set(v.models.map(m=>m.id)).size!==v.models.length||!Number.isInteger(v.durationMs)||v.durationMs<1000||v.durationMs>3600000)throw new HostedError("HOSTED_GOAL_CONFIG_INVALID",503);
  for(const m of v.models){taskLoopbackUrl(m.relayUrl);getAddress(m.provider);if(!/^[1-9][0-9]{0,29}$/.test(m.priceRaw)||[m.id,m.service,m.model,m.physicalModel,m.responseModel??m.physicalModel].some(x=>typeof x!=="string"||!x||x.length>120))throw new HostedError("HOSTED_GOAL_CONFIG_INVALID",503);}
  if(v.external!==undefined)validateExternalHiringConfig(v.external);
  return structuredClone(v);
}
const digest=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
/** Approved routes only, selected before a new charge. Reserve an independent
 * review and any remaining phases rather than spending the whole task on one call. */
export function selectGoalModelRoute(preferred:GoalModelRoute, routes:GoalModelRoute[], availableRaw:string, futureReserveRaw="0"):GoalModelRoute|undefined {
  const available=BigInt(availableRaw)-BigInt(futureReserveRaw);
  if(BigInt(preferred.priceRaw)<=available)return structuredClone(preferred);
  return routes.filter(r=>BigInt(r.priceRaw)<BigInt(preferred.priceRaw)&&BigInt(r.priceRaw)<=available)
    .sort((a,b)=>BigInt(a.priceRaw)<BigInt(b.priceRaw)?-1:BigInt(a.priceRaw)>BigInt(b.priceRaw)?1:a.id.localeCompare(b.id)).map(r=>structuredClone(r))[0];
}
export function goalCallRoute(state:GoalState,call:GoalCall):GoalModelRoute { return call.route??state.route; }
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
      state=saved??{version:1,lookupEnabled:this.config.chainLookup===true,...(this.config.external?{externalConfig:structuredClone(this.config.external)}:{}),binding,input:identity,route:structuredClone(route!),routes:structuredClone(this.config.models),deadlineMs:Date.now()+this.config.durationMs,view:{stage:"planning",phases:[],calls:[]},calls:[]};
      // Old journals had one route for the whole mission. Preserve it for all
      // existing calls; newly admitted calls may use only this frozen directory.
      state.routes??=[structuredClone(state.route)];
      for(const c of state.calls)c.route??=structuredClone(state.route);
      const save=()=>store.write(state);
      const activity=input.activity;
      const publish=async()=>{state.view=validateGoalView(state.view);await save();await input.progress?.(state.view);};
      const total=()=>state.view.calls.reduce((sum,c)=>sum+BigInt(c.chargedRaw),0n)+state.calls.filter(c=>!state.view.calls.some(v=>v.stage===c.stage)).reduce((sum,c)=>sum+BigInt(c.response?.chargedRaw??c.recovery?.chargedRaw??"0"),0n);
      const refunded=()=>state.calls.reduce((sum,c)=>sum+BigInt(c.recovery?.refundedRaw??"0"),0n).toString();
      const finish=async(stage:GoalView['stage'],success:boolean,reason?:string)=>{
        state.view.stage=stage;state.result={phase:stage==="completed"?"Completed":stage==="cancelled"?"Cancelled":"Stopped",terminal:true,success,chargedRaw:total().toString(),refundedRaw:refunded(),mission:validateGoalView(state.view),...(reason?{reason}:{})};await publish();return state.result;
      };
      if(state.result)return structuredClone(state.result);
      await publish();
      if(!state.view.phases.length)await activity?.({scene:"decision",state:"started",phaseId:"plan"});
      const cheapest=state.routes.reduce((price,r)=>BigInt(r.priceRaw)<price?BigInt(r.priceRaw):price,BigInt(state.route.priceRaw));
      const externalPrice=(taskType?:string)=>{const routes=state.externalServices?.map(s=>s.trust)??state.externalConfig?.services??[];return routes.filter(r=>!taskType||r.taskType===taskType).reduce((price,r)=>price===undefined||BigInt(r.priceRaw)<price?BigInt(r.priceRaw):price,undefined as bigint|undefined)??cheapest;};
      const futureReserve=(stage:string)=>stage==="plan"?cheapest+(state.externalConfig?externalPrice():cheapest):stage.startsWith("phase-")?cheapest+state.view.phases.slice(Number(stage.slice(6))+1).reduce((price,p)=>price+(state.externalConfig?externalPrice(p.taskType):cheapest),0n):stage==="revision"?cheapest:0n;
      const call=async(stage:string,system:string,user:string,maxTokens:number,specialist?:{serviceId:string;promptDigest:string})=>{
        let entry=state.calls.find(c=>c.stage===stage);
        if(entry?.recovery?.resolved)throw new Error(entry.recovery.voided?"HOSTED_GOAL_PAYMENT_VOIDED":entry.recovery.reverted?"HOSTED_GOAL_PAYMENT_REVERTED":"HOSTED_GOAL_UNDELIVERED_REFUNDED");
        const control=await this.deps.control?.(input.agent.id,input.run.requestId);
        if(!entry?.started){
          if(control?.cancelled||input.run.stopRequested)throw new Error("HOSTED_GOAL_CANCELLED");
          if(control?.paused)throw new Error("HOSTED_AGENT_PAUSED");
          if(Date.now()>=state.deadlineMs)throw new Error("HOSTED_GOAL_DEADLINE");
          if(!entry){
            const available=BigInt(input.run.reservedRaw)-total(),reserved=futureReserve(stage);
            const chosen=selectGoalModelRoute(state.route,state.routes!,available.toString(),reserved.toString());
            if(!chosen)throw new Error("HOSTED_GOAL_BUDGET_REQUIRED");
            if(Buffer.byteLength(JSON.stringify({system,user}))>112000)throw Error("HOSTED_GOAL_INPUT_TOO_LARGE");
            entry={stage,route:chosen,futureReserveRaw:reserved.toString(),...(specialist?{serviceId:specialist.serviceId,promptDigest:specialist.promptDigest}:{}),messages:[{role:"system",content:system},{role:"user",content:user}],max_completion_tokens:maxTokens};state.calls.push(entry);await save();
            if(chosen.id!==state.route.id)await activity?.({scene:"model",state:"selected",phaseId:stage,subject:{id:chosen.id,name:chosen.id,kind:"model"},reason:"HOSTED_GOAL_MODEL_DOWNGRADED",evidence:{candidateIds:[state.route.id,chosen.id],priceRaw:chosen.priceRaw,budgetRaw:available.toString()}});
          }
        }
        if(!entry)throw Error("HOSTED_GOAL_BINDING_CHANGED");
        if(!entry.response){
          // Persist dispatch intent before crossing the payment boundary. A timeout
          // remains unresolved until the same call is reconciled, including on stop.
          entry.started=true;entry.unpaid=false;await save();
          const selected=goalCallRoute(state,entry);
          await activity?.({scene:"model",state:"selected",phaseId:stage,subject:{id:selected.id,name:selected.id,kind:"model"},evidence:{priceRaw:selected.priceRaw,budgetRaw:input.run.reservedRaw}});
          await activity?.({scene:"model",state:"waiting",phaseId:stage,subject:{id:selected.id,name:selected.id,kind:"model"}});
          entry.response=await(this.deps.call?this.deps.call(state,entry,input,save):paidGoalCall(this.task,state,entry,input,save,()=>this.deps.control?.(input.agent.id,input.run.requestId)));await save();
        }
        const selected=goalCallRoute(state,entry);
        const r=entry.response;
        if(r.chargedRaw!==selected.priceRaw||![r.promptTokens,r.completionTokens].every(n=>Number.isSafeInteger(n)&&n>=0))throw new Error("HOSTED_GOAL_DELIVERY_INVALID");
        if(!state.view.calls.some(c=>c.stage===stage)){state.view.calls.push({stage,model:selected.id,chargedRaw:r.chargedRaw,promptTokens:r.promptTokens,completionTokens:r.completionTokens,...(r.paymentId?{paymentId:r.paymentId}:{}),...(r.txHash?{txHash:r.txHash}:{}),...(entry.serviceId?{serviceId:entry.serviceId,promptDigest:entry.promptDigest}:{}),...(entry.handle?{requestDigest:entry.handle.quote.requestDigest}:{})});await publish();}
        // A canonically paid but unusable response still consumed budget.
        if(r.deliveryError)throw new Error(r.deliveryError);
        if(typeof r.text!=="string"||!r.text.trim()||r.text.length>24000)throw new Error("HOSTED_GOAL_OUTPUT_INVALID");
        await activity?.({scene:"model",state:"completed",phaseId:stage,subject:{id:selected.id,name:selected.id,kind:"model"},evidence:{chargedRaw:r.chargedRaw,promptTokens:r.promptTokens,completionTokens:r.completionTokens,...(r.paymentId?{paymentId:r.paymentId}:{}),...(r.txHash?{txHash:r.txHash}:{})}});
        return r.text;
      };
      try{
        if(state.lookupEnabled&&!state.research&&!state.calls.length){
          const control=await this.deps.control?.(input.agent.id,input.run.requestId);
          if(control?.cancelled||input.run.stopRequested)return await finish('cancelled',false,'HOSTED_GOAL_CANCELLED');
          if(control?.paused)throw Error('HOSTED_AGENT_PAUSED');
          try { if(chainTargets(identity.goal).length)await activity?.({scene:"chain-lookup",state:"started",subject:{id:identity.chainId,name:identity.chainId,kind:"chain"},evidence:{chainId:identity.chainId}});state.research=await(this.deps.lookup??collectChainResearch)(identity.goal,identity.chainId,this.task); }
          catch(error){await activity?.({scene:"chain-lookup",state:"failed",reason:error instanceof Error&&/^HOSTED_GOAL_LOOKUP_[A-Z_]+$/.test(error.message)?error.message:"HOSTED_GOAL_LOOKUP_FAILED"});throw error;}
          if(state.research){state.view.research=state.research.evidence;await publish();
            await activity?.({scene:"chain-lookup",state:"confirmed",evidence:{chainId:identity.chainId,researchDigest:state.research.evidence.digest,available:state.research.evidence.records.length,...(state.research.evidence.records[0]?{blockNumber:state.research.evidence.records[0].blockNumber,blockHash:state.research.evidence.records[0].blockHash}:{})}});
            if(state.research.evidence.records.some(r=>r.source&&!r.source.codeMatched))await activity?.({scene:"chain-lookup",state:"blocked",reason:"HOSTED_GOAL_SOURCE_UNAVAILABLE",evidence:{chainId:identity.chainId}});
          }
        }
        const research=state.research?{chainResearch:JSON.parse(state.research.context),researchDigest:state.research.evidence.digest}:{};
        if(!state.view.phases.length){const plan=parseMissionPlan(await call("plan",missionSystem,state.research?JSON.stringify({originalGoal:identity.goal,...research}):identity.goal,1024));
          if(plan.needsInput){state.view.answer=plan.needsInput;return await finish("needs-input",false,"HOSTED_GOAL_NEEDS_INPUT");}
          state.view.phases=plan.phases;await publish();
          await activity?.({scene:"decision",state:"completed",phaseId:"plan"});
          await activity?.({scene:"specialists",state:"started",evidence:{candidateIds:state.externalConfig?state.externalConfig.services.map(s=>s.id):missionSpecialists.map(s=>s.id)}});}
        if(state.externalConfig&&!state.externalServices){
          const control=await this.deps.control?.(input.agent.id,input.run.requestId);
          if(control?.cancelled||input.run.stopRequested)throw Error("HOSTED_GOAL_CANCELLED");
          if(control?.paused)throw Error("HOSTED_AGENT_PAUSED");
          if(Date.now()>=state.deadlineMs)throw Error("HOSTED_GOAL_DEADLINE");
          if(this.deps.discover)state.externalServices=await this.deps.discover(state.externalConfig);
          else{
            const connection=await openHostedPlannerConnection((await taskPrivateFile(this.task.rpcUrlFile)).trim(),identity.chainId,this.task.rpcTransport);
            try{state.externalServices=await discoverExternalServices(state.externalConfig,{provider:connection.provider});}finally{connection.close();}
          }
          await publish();
          await activity?.({scene:"specialists",state:"confirmed",evidence:{candidateIds:state.externalServices.map(s=>s.service.id),available:state.externalServices.length}});
        }
        for(let index=0;index<state.view.phases.length;index++){
          const phase=state.view.phases[index];
          if(phase.output)continue;state.view.stage="executing";await publish();
          if(state.externalConfig){
            const stage=`phase-${index}`;
            let hire=state.externalHires?.[stage],entry=state.calls.find(c=>c.stage===stage);
            if(!entry?.started){
              const control=await this.deps.control?.(input.agent.id,input.run.requestId);
              if(control?.cancelled||input.run.stopRequested)throw Error("HOSTED_GOAL_CANCELLED");
              if(control?.paused)throw Error("HOSTED_AGENT_PAUSED");
              if(Date.now()>=state.deadlineMs)throw Error("HOSTED_GOAL_DEADLINE");
            }
            if(!hire){
              if(entry)throw Error("HOSTED_GOAL_BINDING_CHANGED");
              const budget=BigInt(input.run.reservedRaw)-total()-futureReserve(stage);
              const cash=BigInt(await (this.deps.cash?this.deps.cash(state):readGoalCash(this.task,state)))-futureReserve(stage);
              const capacity=budget<cash?budget:cash;
              let selected:ExternalServiceSnapshot|undefined;
              try{selected=rankExternalServices(state.externalServices??[],phase.taskType,capacity<0n?"0":capacity.toString(),state.externalConfig.minReputation??0)[0];}
              catch(error){
                if(error instanceof Error&&error.message==="HOSTED_GOAL_BUDGET_REQUIRED"&&cash<budget){
                  let affordableByBudget=false;
                  try{affordableByBudget=rankExternalServices(state.externalServices??[],phase.taskType,budget<0n?"0":budget.toString(),state.externalConfig.minReputation??0).length>0;}catch{/* Keep the original budget rejection if no approved service fits. */}
                  if(affordableByBudget)throw Error("INFERENCE_FUNDING_REQUIRED");
                }
                throw error;
              }
              if(!selected)throw Error("HOSTED_EXTERNAL_NO_AFFORDABLE_SERVICE");
              const prepared=prepareExternalHire(state,selected,{stage,taskType:phase.taskType,originalGoal:identity.goal,assignment:{name:phase.name,taskType:phase.taskType,goal:phase.goal},previous:state.view.phases.slice(0,index) as unknown as import("@agentfuel/sdk").Json[],...research});
              hire=prepared.hire;entry=prepared.call;entry.futureReserveRaw=futureReserve(stage).toString();
              state.externalHires??={};state.externalHires[stage]=hire;state.calls.push(entry);state.view.phases[index].external=structuredClone(hire.service.service);await publish();
            }
            if(!entry)throw Error("HOSTED_GOAL_BINDING_CHANGED");
            if(!entry.started){
              const control=await this.deps.control?.(input.agent.id,input.run.requestId);
              if(control?.cancelled||input.run.stopRequested)throw Error("HOSTED_GOAL_CANCELLED");
              if(control?.paused)throw Error("HOSTED_AGENT_PAUSED");
              if(Date.now()>=state.deadlineMs)throw Error("HOSTED_GOAL_DEADLINE");
              if(total()+BigInt(hire.route.priceRaw)+futureReserve(stage)>BigInt(input.run.reservedRaw))throw Error("HOSTED_GOAL_BUDGET_REQUIRED");
            }
            await activity?.({scene:"specialists",state:"selected",phaseId:stage,subject:{id:hire.service.service.id,name:hire.service.service.name,kind:"specialist"},evidence:{priceRaw:hire.route.priceRaw}});
            await activity?.({scene:"execution",state:"started",phaseId:stage,subject:{id:hire.service.service.id,name:hire.service.service.name,kind:"specialist"}});
            let external:Awaited<ReturnType<typeof executeExternalHire>>;
            try{external=await executeExternalHire(this.task,state,entry,hire,input,save,()=>this.deps.control?.(input.agent.id,input.run.requestId));}
            finally{
              // Canonically paid malformed provenance must still consume budget.
              if(entry.response&&!state.view.calls.some(c=>c.stage===stage)){const r=entry.response;state.view.calls.push({stage,model:hire.route.id,chargedRaw:r.chargedRaw,promptTokens:r.promptTokens,completionTokens:r.completionTokens,...(r.paymentId?{paymentId:r.paymentId}:{}),...(r.txHash?{txHash:r.txHash}:{}),serviceId:entry.serviceId,promptDigest:entry.promptDigest,...(entry.handle?{requestDigest:entry.handle.quote.requestDigest}:{})});await publish();}
            }
            state.view.calls.find(c=>c.stage===stage)!.external=external.proof;
            state.view.phases[index].output=external.output;state.view.answer=external.output;await publish();
            await activity?.({scene:"execution",state:"completed",phaseId:stage,subject:{id:hire.service.service.id,name:hire.service.service.name,kind:"specialist"},evidence:{paymentId:external.proof.paymentId,txHash:external.proof.txHash,chargedRaw:external.response.chargedRaw}});
            continue;
          }
          const selected=resolveSpecialist(phase.taskType);
          if(selected)await activity?.({scene:"specialists",state:"selected",phaseId:`phase-${index}`,subject:{id:selected.id,name:selected.name,kind:"specialist"}});
          else await activity?.({scene:"specialists",state:"blocked",phaseId:`phase-${index}`,reason:"HOSTED_GOAL_SPECIALIST_UNAVAILABLE"});
          await activity?.({scene:"execution",state:"started",phaseId:`phase-${index}`,...(selected?{subject:{id:selected.id,name:selected.name,kind:"specialist" as const}}:{})});
          const profile=specialistPrompt(phase.taskType,specialistSystem,identity.chainId);
          const output=normalizeSpecialistOutput(phase.taskType,await call(`phase-${index}`,profile.system,JSON.stringify({originalGoal:identity.goal,...research,assignment:phase,previous:state.view.phases.slice(0,index)}),2048,profile));
          state.view.phases[index].output=output;
          state.view.answer=output;await publish();
          await activity?.({scene:"execution",state:"completed",phaseId:`phase-${index}`,...(selected?{subject:{id:selected.id,name:selected.name,kind:"specialist" as const}}:{})});
        }
        state.view.stage="reviewing";await publish();
        const originalArtifact=state.view.phases.at(-1)!.output!;
        const reviewArtifact=async(stage:string,artifact:string)=>{
          await activity?.({scene:"review",state:"started",phaseId:stage,subject:{id:"independent-model-review",name:"Independent Model Review",kind:"artifact"}});
          const measurement=inspectGoalArtifact(identity.goal,artifact,state.research?.evidence.observedAt);
          const review=parseMissionReview(await call(stage,reviewSystem,JSON.stringify({originalGoal:identity.goal,...research,plan:state.view.phases.map(({output,...p})=>p),outputContract:specialistOutputContract(state.view.phases.at(-1)!.taskType),artifact,measuredLengths:measurement}),1536));
          if(measurement.failures.length){review.passed=false;review.summary=`验收未通过：${measurement.failures.join(" ")}`.slice(0,4000);review.checks=[...measurement.failures,...review.checks].slice(0,20).map(c=>c.slice(0,1000));}
          await activity?.({scene:"review",state:review.passed?"confirmed":"failed",phaseId:stage,evidence:{passed:review.passed}});
          return review;
        };
        const firstReview=await reviewArtifact("review",originalArtifact);state.view.review=firstReview;
        // One revision only, including its independent re-review in the budget.
        if(!state.view.review.passed&&(state.calls.some(c=>c.stage==="revision")||total()+2n*cheapest<=BigInt(input.run.reservedRaw))){
          await publish();
          await activity?.({scene:"review",state:"revising",phaseId:"revision"});
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
        if(!unresolved&&["HOSTED_GOAL_PAYMENT_VOIDED","HOSTED_GOAL_INPUT_TOO_LARGE","HOSTED_GOAL_LOOKUP_LIMIT","HOSTED_GOAL_LOOKUP_NETWORK","HOSTED_GOAL_CANCELLED","HOSTED_GOAL_DEADLINE","HOSTED_GOAL_PLAN_INVALID","HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID","HOSTED_GOAL_REVIEW_INVALID","HOSTED_GOAL_OUTPUT_INVALID","HOSTED_GOAL_MODEL_CHANGED","HOSTED_EXTERNAL_PROVENANCE_INVALID","HOSTED_GOAL_UNDELIVERED_REFUNDED","HOSTED_GOAL_PAYMENT_REVERTED"].includes(code))return await finish(code==="HOSTED_GOAL_CANCELLED"?"cancelled":"paused",false,code);
        if(unresolved&&["HOSTED_GOAL_CANCELLED","HOSTED_GOAL_DEADLINE"].includes(code))code="HOSTED_GOAL_RECONCILIATION_REQUIRED";
        state.view.stage="paused";await publish();
        await activity?.({scene:code==="INFERENCE_FUNDING_REQUIRED"?"funding":"interruption",state:unresolved?"reconciling":"paused",reason:code,...(code==="INFERENCE_FUNDING_REQUIRED"?{requiredAction:"deposit" as const}:unresolved?{requiredAction:"reconcile" as const}:{})});return{phase:"Paused",terminal:false,success:false,chargedRaw:total().toString(),refundedRaw:refunded(),reason:code,mission:state.view};
      }
    }finally{await store.close();}
  }
}
