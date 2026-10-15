import type { ExternalServiceView } from '../../services/hosted-agents/src/goal-types';
import type { HostedRun } from './hosted-client';
import {missionSpecialists} from '../../services/hosted-agents/src/specialists/catalog';
import {tabbyScene} from './tabby-scenes';
const specialists=[...missionSpecialists,{id:'reviewer',serviceId:'tabby/reviewer',name:'Independent Reviewer',kind:'复核',detail:'acceptance · verification'}];
/** Built-in executor roles only. No synthetic reputation or independent wallet identity. */
export function expertAssignments(run?:HostedRun,externalServices:ExternalServiceView[]=[]){
 const view=run?.mission??run?.result?.mission;
 const firstPending=view?.phases.findIndex(p=>!p.output)??-1;
 const running=run?.status==='Running'&&!run.stopRequested;
 const activity=run?.activities?.length?tabbyScene(run):undefined;
 const internal=specialists.map(s=>{
  const indices=view?.phases.flatMap((p,i)=>p.taskType===s.id&&!p.external?[i]:[])??[];
  const used=s.id==='reviewer'?view?.calls.filter(c=>c.stage==='review'||c.stage==='revision-review').length??0:indices.filter(i=>!!view?.phases[i].output).length;
  const assigned=activity?activity.selectedExpert?.id===s.id&&['model','execution','review'].includes(activity.scene):s.id==='reviewer'?view?.stage==='reviewing':view?.stage==='executing'&&firstPending>=0&&!view?.phases[firstPending]?.external&&view?.phases[firstPending]?.taskType===s.id;
  const waiting=running&&!!assigned&&activity?.state==='waiting';
  const active=running&&!!assigned&&!waiting;
  const halted=!!view&&(!!run?.stopRequested||['Paused','Failed'].includes(run?.status??''))&&(s.id==='reviewer'?view.stage==='reviewing'||!!view.review&&!view.review.passed:firstPending>=0&&view.phases[firstPending]?.taskType===s.id);
  return {...s,used,active,waiting,halted,external:undefined as ExternalServiceView|undefined};
 });
 const selected=new Map(externalServices.map(s=>[s.id,s]));
 for(const phase of view?.phases??[])if(phase.external)selected.set(phase.external.id,phase.external);
 const external=[...selected.values()].map(service=>{
  const indices=view?.phases.flatMap((p,i)=>p.external?.id===service.id?[i]:[])??[];
  const assigned=activity?.selectedExpert?.id===service.id||view?.stage==='executing'&&indices.includes(firstPending);
  return {id:service.id,serviceId:service.serviceId,name:service.name,kind:'外部 Agent',detail:service.taskType,external:service,
    used:indices.filter(i=>!!view?.phases[i].output).length,active:running&&!!assigned&&activity?.state!=='waiting',waiting:running&&!!assigned&&activity?.state==='waiting',halted:!!assigned&&['Paused','Failed'].includes(run?.status??'')};
 });
 return [...external,...internal.filter(s=>!(externalServices.length||view?.phases.some(p=>p.external))||s.id==='reviewer'||s.used||s.active||s.halted)].sort((a,b)=>Number(b.active)-Number(a.active)||Number(b.used>0)-Number(a.used>0));
}
