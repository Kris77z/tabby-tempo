import {validateChainEvidence,type ChainReadEvidence} from './chain-evidence.js';
/** Public mission data: no credentials, provider URLs or executable HTML. */
export interface GoalPhase { name: string; taskType: string; goal: string; output?: string }
export interface GoalView {
  stage: "planning" | "executing" | "reviewing" | "completed" | "needs-input" | "paused" | "cancelled";
  phases: GoalPhase[]; answer?: string; research?:ChainReadEvidence;
  review?: { passed: boolean; summary: string; checks: string[] };
  calls: { stage: string; model: string; chargedRaw: string; promptTokens: number; completionTokens: number; paymentId?: string; txHash?: string; serviceId?:string; promptDigest?:string; requestDigest?:string }[];
}
export function validGoal(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 12000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
export function validateGoalView(value: GoalView): GoalView {
  const text = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!value || !["planning","executing","reviewing","completed","needs-input","paused","cancelled"].includes(value.stage)
    || !Array.isArray(value.phases) || value.phases.length > 4 || value.phases.some(p => !p || !text(p.name,160) || !text(p.taskType,80) || !text(p.goal,12000) || p.output !== undefined && !text(p.output,24000))
    || value.answer !== undefined && !text(value.answer,24000)
    || value.review !== undefined && (!value.review || typeof value.review.passed !== "boolean" || !text(value.review.summary,4000) || !Array.isArray(value.review.checks) || value.review.checks.length>20 || value.review.checks.some(c=>!text(c,1000)))
    || !Array.isArray(value.calls) || value.calls.length > 8 || value.calls.some(c=>!c || !text(c.stage,100) || !text(c.model,120) || typeof c.chargedRaw!=="string" || !/^(0|[1-9][0-9]{0,29})$/.test(c.chargedRaw) || ![c.promptTokens,c.completionTokens].every(n=>Number.isSafeInteger(n)&&n>=0)
      || c.serviceId!==undefined&&(!text(c.serviceId,120)||!c.serviceId) || c.promptDigest!==undefined&&!/^[a-f0-9]{64}$/i.test(c.promptDigest) || c.requestDigest!==undefined&&!/^0x[a-f0-9]{64}$/i.test(c.requestDigest)
      || c.paymentId!==undefined&&!/^0x[\da-f]{64}$/i.test(c.paymentId) || c.txHash!==undefined&&!/^0x[\da-f]{64}$/i.test(c.txHash))) throw new Error("HOSTED_GOAL_RESULT_INVALID");
  return {...(value.research?{research:validateChainEvidence(value.research)}:{}),stage:value.stage,phases:value.phases.map(p=>({name:p.name,taskType:p.taskType,goal:p.goal,...(p.output===undefined?{}:{output:p.output})})),
    ...(value.answer===undefined?{}:{answer:value.answer}),...(value.review?{review:{passed:value.review.passed,summary:value.review.summary,checks:[...value.review.checks]}}:{}),
    calls:value.calls.map(c=>({stage:c.stage,model:c.model,chargedRaw:c.chargedRaw,promptTokens:c.promptTokens,completionTokens:c.completionTokens,...(c.paymentId?{paymentId:c.paymentId}:{}),...(c.txHash?{txHash:c.txHash}:{}),...(c.serviceId?{serviceId:c.serviceId}:{}),...(c.promptDigest?{promptDigest:c.promptDigest}:{}),...(c.requestDigest?{requestDigest:c.requestDigest}:{})}))};
}
