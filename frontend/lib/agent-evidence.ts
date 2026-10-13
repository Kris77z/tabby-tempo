import {actionLabel,type HostedRun} from './hosted-client';
export function roleCalls(run:HostedRun,role:string){
 const view=run.mission??run.result?.mission;
 return view?.calls.filter(call=>{
  if(role==='reviewer')return ['review','revision-review'].includes(call.stage);
  const phase=/^phase-(\d+)$/.exec(call.stage);
  return phase?view.phases[Number(phase[1])]?.taskType===role:call.stage==='revision'&&view.phases.at(-1)?.taskType===role;
 })??[];
}
export function agentEvidence(runs:HostedRun[],agentId:string,chainId?:string,role?:string){
 const entries:{hash:string;chainId?:string;label:string;requestId:string;at:string}[]=[];
 for(const run of runs.filter(r=>r.agentId===agentId)){
  const network=run.result?.chainId??chainId;
  const add=(hash:string|undefined,label:string)=>{if(hash&&/^0x[0-9a-f]{64}$/i.test(hash)&&!entries.some(e=>e.hash.toLowerCase()===hash.toLowerCase()&&e.chainId===network))entries.push({hash,chainId:network,label,requestId:run.requestId,at:run.updatedAt});};
  if(!role){add(run.result?.acceptTxHash,'接单');add(run.result?.paymentTxHash,'推理付款');add(run.result?.settlement?.txHash,'任务结算');add(run.result?.txHash,actionLabel[run.action]);}
  const calls=role?roleCalls(run,role):(run.mission??run.result?.mission)?.calls??[];
  for(const call of calls)add(call.txHash,`${call.stage} · ${call.model} 付款`);
 }
 return entries;
}
