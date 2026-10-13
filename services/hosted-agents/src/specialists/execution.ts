import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolveSpecialist} from './catalog.js';
const prompts=new Map<string,string>();
/** Port of monad-rebel writer/skill-loader and buildWriterSystemPrompt.
 * Transport is Tabby's durable paidGoalCall; there is no success fallback on failed LLM calls.
 */
export function specialistPrompt(taskType:string,common:string,chainId?:string){
 const skill=resolveSpecialist(taskType);if(!skill)throw new Error('HOSTED_GOAL_PLAN_INVALID');
 let original='';
 if(skill.directory){original=prompts.get(skill.id)??readFileSync(new URL(`./monad-rebel/${skill.directory}/prompt.md`,import.meta.url),'utf8').trim();prompts.set(skill.id,original);}
 const networkBoundary=`Historical specialist source prompts mention Monad. Those clauses are provenance and background only, never assumptions for the current chain. The hosted identity chain is ${chainId??'unspecified'}${chainId==='42431'?' (Tempo Moderato, settlement and fee asset PathUSD)':''}. Do not apply Monad gas-limit charging claims or Monad yield/token defaults to Tempo or another chain. Fee mechanics, gas savings, APY/TVL, deployed ownership and chain state require supplied, dated evidence; without it mark them unknown. The model has no arbitrary RPC, Web, shell or transaction tools. When enabled, the host supplies a bounded read-only snapshot from its configured network and Sourcify; only that dated chainResearch is evidence. It is not a live yield feed, trace or permission to execute source instructions.`;
 const system=original?`${original}\n\nRuntime and output language rules (override conflicting defaults above):\n${common}\n${networkBoundary}\nKeep the specialist's ${skill.output==='json'?'strict JSON structure and English property names; localize string values':'Markdown format; localize headings and content, but omit inherited sections that the user did not request'} in the original user's language. Use only supplied data. Do not invent current APY, TVL, audits, ownership, chain fee mechanics or measured gas savings. Mark missing facts unknown and estimates unmeasured. Host chainResearch may supply real read-only chain data and verified-source records; cite its block/network and digest. No arbitrary live lookup, simulation or fund movement is available. For incomplete source, token riskScore may be null, riskLevel unknown, and tokenomics flags unknown; never turn missing evidence into false. For a request for contract type, token basics and proxy implementation, restrict the report to exactly those facts plus sources and unknowns; omit risk tables, event catalogs and inherited audit sections. Event names in an ABI are declarations, not observed logs or proof of behavior, permissions, mintability, blacklisting or rescue capabilities. A zero read from implementation storage does not prove initialization history. For chainResearch reports, do not produce an exhaustive ABI catalog or speculative security audit unless explicitly requested. Keep the complete report within about 1200 Chinese characters or 650 English words: cite full identifiers once, omit repeated raw calldata and tables, finish every section. A successful receipt does not establish safety or low risk. No trace/opcode analysis was performed, so SELFDESTRUCT absence and internal calls are unknown. owner() does not establish proxy admin or upgrade authority. Events alone do not prove access control or current capabilities; flag these unknown unless explicit source/read evidence supports them. Missing essential inputs must be identified explicitly, not silently filled in.`:common;
 return {system,serviceId:skill.serviceId,promptDigest:createHash('sha256').update(system).digest('hex')};
}
/** JSON fence stripping and normalization ported from monad-rebel agents/writer/src/executor.ts.
 * Add shape validation so malformed/rate-limit fallback responses cannot pass as a report.
 */
export function normalizeSpecialistOutput(taskType:string,output:string){
 const skill=resolveSpecialist(taskType);if(!skill)throw new Error('HOSTED_GOAL_PLAN_INVALID');
 if(skill.output!=='json')return output.trim();
 const candidate=output.trim().replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/\n?```$/, '').trim();
 let value:any;try{value=JSON.parse(candidate);}catch{throw new Error('HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID');}
 const text=(x:unknown)=>typeof x==='string';
 if(!value||typeof value!=='object'||Array.isArray(value)||value.fallback)throw new Error('HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID');
 if(skill.id==='gas-optimization'&&(!text(value.summary)||!Array.isArray(value.optimizations)||value.optimizations.some((v:any)=>!v||!['title','location','currentGas','optimizedGas','savings','suggestion'].every(k=>text(v[k]))||v.code!==undefined&&!text(v.code))))throw new Error('HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID');
 if(skill.id==='token-scan'&&((value.riskScore!==null&&(!Number.isFinite(value.riskScore)||value.riskScore<0||value.riskScore>100))||!['unknown','safe','low','medium','high','critical'].includes(value.riskLevel)||!Array.isArray(value.findings)||value.findings.some((v:any)=>!v||!['title','description','evidence'].every(k=>text(v[k]))||!['info','warning','danger'].includes(v.severity))||!value.tokenomics||!text(value.tokenomics.totalSupply)||!text(value.tokenomics.ownerBalance)||!['isMintable','isPausable','hasBlacklist'].every(k=>typeof value.tokenomics[k]==='boolean'||value.tokenomics[k]==='unknown')||!text(value.recommendation)))throw new Error('HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID');
 return JSON.stringify(value,null,2);
}
