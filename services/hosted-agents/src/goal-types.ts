import {validateChainEvidence,type ChainReadEvidence} from './chain-evidence.js';
/** Public mission data: no credentials, provider URLs or executable HTML. */
export interface ExternalServiceView {
  id: string; name: string; taskType: string; serviceId: string; modelId: string; provider: string; priceRaw: string;
  identity?: { chainId: string; registry: string; agentId: string; wallet: string };
  reputation: { score: number | null; samples: number; source: "erc8004" | "registry"; blockNumber?: number; blockHash?: string };
}
export interface ExternalHireProof {
  service: ExternalServiceView; paymentId: string; txHash: string; requestDigest: string; promptDigest: string; assignmentDigest: string;
}
/** Public service identity only. Network endpoints, keys and private routes stay server-side. */
export function validateExternalService(value: ExternalServiceView): ExternalServiceView {
  const identifier = (x: unknown) => typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(x);
  const address = (x: unknown) => typeof x === "string" && /^0x[0-9a-f]{40}$/i.test(x) && !/^0x0{40}$/i.test(x);
  const uint = (x: unknown) => typeof x === "string" && /^(0|[1-9][0-9]{0,29})$/.test(x);
  const rep = value?.reputation, identity = value?.identity;
  if (!value || ![value.id,value.taskType,value.serviceId,value.modelId].every(identifier)
    || typeof value.name !== "string" || !value.name.trim() || value.name.length > 120 || /[\x00-\x1f\x7f]/.test(value.name)
    || !address(value.provider) || !uint(value.priceRaw)
    || !rep || !(rep.score === null || typeof rep.score === "number" && Number.isFinite(rep.score) && rep.score >= 0 && rep.score <= 5)
    || !Number.isSafeInteger(rep.samples) || rep.samples < 0 || !["erc8004","registry"].includes(rep.source)
    || rep.blockNumber !== undefined && (!Number.isSafeInteger(rep.blockNumber) || rep.blockNumber < 0)
    || rep.blockHash !== undefined && !/^0x[0-9a-f]{64}$/i.test(rep.blockHash)
    || identity && (!uint(identity.chainId) || !uint(identity.agentId) || !address(identity.registry) || !address(identity.wallet))) throw new Error("HOSTED_EXTERNAL_PUBLIC_INVALID");
  return { id:value.id,name:value.name,taskType:value.taskType,serviceId:value.serviceId,modelId:value.modelId,provider:value.provider,priceRaw:value.priceRaw,
    ...(identity?{identity:{chainId:identity.chainId,registry:identity.registry,agentId:identity.agentId,wallet:identity.wallet}}:{}),
    reputation:{score:rep.score,samples:rep.samples,source:rep.source,...(rep.blockNumber===undefined?{}:{blockNumber:rep.blockNumber}),...(rep.blockHash===undefined?{}:{blockHash:rep.blockHash})} };
}
export function validateExternalHire(value: ExternalHireProof): ExternalHireProof {
  const hash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
  if (!value || ![value.paymentId,value.txHash,value.requestDigest].every(hash)
    || ![value.promptDigest,value.assignmentDigest].every(v=>typeof v === "string" && /^[a-f0-9]{64}$/i.test(v))) throw new Error("HOSTED_EXTERNAL_PROOF_INVALID");
  return {service:validateExternalService(value.service),paymentId:value.paymentId,txHash:value.txHash,requestDigest:value.requestDigest,promptDigest:value.promptDigest,assignmentDigest:value.assignmentDigest};
}
export interface GoalPhase { name: string; taskType: string; goal: string; output?: string; external?: ExternalServiceView }
export interface GoalView {
  stage: "planning" | "executing" | "reviewing" | "completed" | "needs-input" | "paused" | "cancelled";
  phases: GoalPhase[]; answer?: string; research?:ChainReadEvidence;
  review?: { passed: boolean; summary: string; checks: string[] };
  calls: { stage: string; model: string; chargedRaw: string; promptTokens: number; completionTokens: number; paymentId?: string; txHash?: string; serviceId?:string; promptDigest?:string; requestDigest?:string; external?: ExternalHireProof }[];
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
      || c.external !== undefined && (c.external.paymentId !== c.paymentId || c.external.txHash !== c.txHash || c.external.requestDigest !== c.requestDigest || c.external.promptDigest !== c.promptDigest || c.external.service.serviceId !== c.serviceId || c.external.service.modelId !== c.model || c.external.service.priceRaw !== c.chargedRaw)
      || c.paymentId!==undefined&&!/^0x[\da-f]{64}$/i.test(c.paymentId) || c.txHash!==undefined&&!/^0x[\da-f]{64}$/i.test(c.txHash))) throw new Error("HOSTED_GOAL_RESULT_INVALID");
  return {...(value.research?{research:validateChainEvidence(value.research)}:{}),stage:value.stage,phases:value.phases.map(p=>({name:p.name,taskType:p.taskType,goal:p.goal,...(p.output===undefined?{}:{output:p.output}),...(p.external?{external:validateExternalService(p.external)}:{})})),
    ...(value.answer===undefined?{}:{answer:value.answer}),...(value.review?{review:{passed:value.review.passed,summary:value.review.summary,checks:[...value.review.checks]}}:{}),
    calls:value.calls.map(c=>({stage:c.stage,model:c.model,chargedRaw:c.chargedRaw,promptTokens:c.promptTokens,completionTokens:c.completionTokens,...(c.paymentId?{paymentId:c.paymentId}:{}),...(c.txHash?{txHash:c.txHash}:{}),...(c.serviceId?{serviceId:c.serviceId}:{}),...(c.promptDigest?{promptDigest:c.promptDigest}:{}),...(c.requestDigest?{requestDigest:c.requestDigest}:{}),...(c.external?{external:validateExternalHire(c.external)}:{})}))};
}
