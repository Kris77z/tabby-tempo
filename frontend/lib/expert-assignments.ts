import type { HostedRun } from './hosted-client';
import {missionSpecialists} from '../../services/hosted-agents/src/specialists/catalog';
const specialists=[...missionSpecialists,{id:'reviewer',serviceId:'tabby/reviewer',name:'Independent Reviewer',kind:'复核',detail:'acceptance · verification'}];
/** Built-in executor roles only. No synthetic reputation or independent wallet identity. */
export function expertAssignments(run?:HostedRun){
 const view=run?.mission??run?.result?.mission;
 const firstPending=view?.phases.findIndex(p=>!p.output)??-1;
 const running=run?.status==='Running'&&!run.stopRequested;
 return specialists.map(s=>{
  const indices=view?.phases.flatMap((p,i)=>p.taskType===s.id?[i]:[])??[];
  const used=s.id==='reviewer'?view?.calls.filter(c=>c.stage==='review'||c.stage==='revision-review').length??0:indices.filter(i=>!!view?.phases[i].output).length;
  const assigned=s.id==='reviewer'?view?.stage==='reviewing':view?.stage==='executing'&&firstPending>=0&&view?.phases[firstPending]?.taskType===s.id;
  const active=running&&!!assigned;
  const halted=!!view&&(!!run?.stopRequested||['Paused','Failed'].includes(run?.status??''))&&(s.id==='reviewer'?view.stage==='reviewing'||!!view.review&&!view.review.passed:firstPending>=0&&view.phases[firstPending]?.taskType===s.id);
  return {...s,used,active,halted};
 }).sort((a,b)=>Number(b.active)-Number(a.active)||Number(b.used>0)-Number(a.used>0));
}
