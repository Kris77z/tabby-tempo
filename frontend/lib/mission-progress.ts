import { actionLabel, type HostedRun } from './hosted-client';
import {runOutcomeLabel} from './tabby-scenes';
export type MissionNode = {label:string;state:'waiting'|'active'|'done'|'blocked'};
/** Progress comes exclusively from persisted outputs/status, never elapsed time. */
export function missionProgress(run?:HostedRun) {
 const view=run?.mission??run?.result?.mission;
 const running=run?.status==='Running'&&view?.stage!=='needs-input';
 const stopped=run?.status==='Paused'||run?.status==='Failed'||!!run?.stopRequested;
 const nodes:MissionNode[]=view?[
  {label:'规划',state:view.phases.length?'done':'waiting'},
  ...view.phases.map(p=>({label:p.name,state:p.output?'done':'waiting'} as MissionNode)),
  {label:'复核',state:run?.status==='Succeeded'&&run.result?.success!==false&&view.review?.passed?'done':'waiting'},
 ]:run?[{label:actionLabel[run.action],state:run.status==='Succeeded'?'done':'waiting'}]:[];
 let target=nodes.findIndex(n=>n.state!=='done');
 if(target<0)target=Math.max(0,nodes.length-1);
 // A terminal failure must remain visible even when all execution outputs exist.
 if(nodes[target]&&stopped)nodes[target].state='blocked';
 else if(nodes[target]&&running)nodes[target].state='active';
 const done=nodes.filter(n=>n.state==='done').length;
 const label=run?(running&&!run.stopRequested?(nodes[target]?.label??'正在执行'):runOutcomeLabel(run)):undefined;
 return {nodes,target,done,label,running:!!running&&!stopped};
}
