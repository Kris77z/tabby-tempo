import type { HostedActivity, HostedActivityEvidence, HostedActivityState, HostedRequiredAction, HostedScene } from '../../services/hosted-agents/src/scene-types';
import {settlementSymbol} from './networks';
import { resolveSpecialist } from '../../services/hosted-agents/src/specialists/catalog';
import type { HostedAgent, HostedCapabilities, HostedFinance, HostedRun } from './hosted-client';
import type { PlayMatchView } from './play-types';

export const sceneLabels: Record<HostedScene, string> = {
 onboarding:'就绪与开户', idle:'待命与排队', decision:'理解目标', 'chain-lookup':'查链取证', specialists:'寻找专家', task:'接取任务',
 funding:'资金检查', credit:'信用支付', model:'模型网关', execution:'执行与协作', review:'验收与修订', game:'游戏', settlement:'任务结算', delivery:'交付与下一轮', interruption:'运行中断',
};
export type SceneObject = { id:string; name:string; label:string; kind:string; selected?:boolean; detail?:string };
export type TabbyPose = 'rest'|'read'|'think'|'inspect'|'hunt'|'work'|'pay'|'hand'|'revise'|'play'|'celebrate'|'blocked';
export interface TabbySceneView {
 scene:HostedScene; state:HostedActivityState; label:string; pose:TabbyPose; animated:boolean;
 objects:SceneObject[]; evidence:HostedActivityEvidence; selectedExpert?:{id:string;name:string};
 reason?:string; requiredAction?:HostedRequiredAction; at?:string; seq?:number; source:'activity'|'snapshot'|'practice'; history:boolean;
}
export interface TabbySceneContext {
 agent?:HostedAgent; ready?:boolean; capabilities?:HostedCapabilities; finance?:HostedFinance|null;
 history?:boolean; disconnected?:boolean; activity?:HostedActivity;
}
const isUnknown=(reason?:string)=>!!reason&&/UNCERTAIN|UNKNOWN|RECONCILIATION|UNCONFIRMED|PAYMENT_EXPIRED/.test(reason);
const positive=(value?:string)=>!!value&&/^\d+$/.test(value)&&BigInt(value)>0n;
const successful=(run:HostedRun)=>run.status==='Succeeded'&&run.result?.success!==false&&(run.mission??run.result?.mission)?.review?.passed!==false;
export function runOutcomeLabel(run:HostedRun):string {
 const view=run.mission??run.result?.mission;
 if(run.stopRequested&&!['Failed','Succeeded'].includes(run.status))return '停止并对账';
 if(isUnknown(run.reason??run.result?.reason))return '结果待确认';
 if(view?.stage==='needs-input')return '需要补充信息';
 if(view?.stage==='cancelled'||run.reason==='HOSTED_GOAL_CANCELLED')return '已取消';
 if(run.result?.phase==='Refunded')return '已退款';
 if(run.action==='game'&&run.status==='Succeeded'){
  const outcome=run.activities?.findLast(event=>event.scene==='game'&&event.evidence?.outcome)?.evidence?.outcome;
  if(outcome)return ({won:'对局获胜',lost:'对局结束 · 未获奖',draw:'对局平局','no-reward':'对局结束 · 无奖励'} as const)[outcome];
 }
 if(run.status==='Succeeded')return successful(run)?'已完成':'已停止';
 return ({Queued:'排队中',Running:'运行中',Paused:'等待处理',Failed:'已失败'} as const)[run.status];
}
function fallback(run:HostedRun|undefined,context:TabbySceneContext):{scene:HostedScene;state:HostedActivityState;reason?:string;requiredAction?:HostedRequiredAction;subject?:HostedActivity['subject'];evidence?:HostedActivityEvidence} {
 const agent=context.agent;
 if(!run){
  if(!agent&&context.ready===false)return {scene:'onboarding',state:'waiting'};
  if(agent?.configurationRequired)return {scene:'onboarding',state:'blocked',requiredAction:'configure'};
  if(agent?.status==='Paused')return {scene:'interruption',state:'paused',requiredAction:'resume'};
  if(agent?.status==='Pending'||agent&&!agent.binding)return {scene:'onboarding',state:'waiting'};
  return {scene:'idle',state:'waiting'};
 }
 const view=run.mission??run.result?.mission,result=run.result,reason=run.reason??result?.reason;
 if(run.stopRequested&&!['Succeeded','Failed'].includes(run.status))return {scene:'interruption',state:'stopping',reason,requiredAction:isUnknown(reason)?'reconcile':undefined};
 if(isUnknown(reason))return {scene:'interruption',state:'reconciling',reason,requiredAction:'reconcile'};
 if(run.status==='Queued')return {scene:'idle',state:'queued'};
 if(view?.stage==='needs-input')return {scene:'decision',state:'blocked',reason,requiredAction:'provide-input'};
 if(view?.stage==='cancelled'||reason==='HOSTED_GOAL_CANCELLED')return {scene:'interruption',state:'cancelled',reason};
 if(result?.phase==='Refunded')return {scene:'interruption',state:'refunded',reason,evidence:{refundedRaw:result.refundedRaw,txHash:result.txHash}};
 if(reason?.includes('GAS_REQUIRED'))return {scene:'funding',state:'blocked',reason,requiredAction:'fund-gas'};
 if(reason?.includes('CONFIGURATION_REQUIRED'))return {scene:'onboarding',state:'blocked',reason,requiredAction:'configure'};
 if(reason&&/BUDGET_REQUIRED|BUDGET_EXHAUSTED|BUDGET_LIMIT/.test(reason))return {scene:'funding',state:'blocked',reason,requiredAction:'configure'};
 if(reason&&/ALLOWANCE_(TOO_SMALL|EXHAUSTED)/.test(reason))return {scene:'funding',state:'blocked',reason};
 if(reason&&/FUNDING_REQUIRED|CASH_REQUIRED|INSUFFICIENT_AVAILABLE_TOKENS/.test(reason))return {scene:'funding',state:'blocked',reason,requiredAction:['reward-task','credits'].includes(run.action)?'play-game':'deposit'};
 if(result?.phase==='AcceptPending')return {scene:'task',state:'waiting',reason,evidence:{taskId:result.taskId,acceptTxHash:result.acceptTxHash}};
 if(result?.phase==='SubmissionPending')return {scene:'review',state:'waiting',reason,evidence:{taskId:result.taskId,txHash:result.txHash}};
 if(result?.phase==='RefundPending')return {scene:'interruption',state:'reconciling',reason,requiredAction:'reconcile'};
 if(run.status==='Paused'||view?.stage==='paused')return {scene:'interruption',state:'paused',reason,requiredAction:run.recoverable?'resume':undefined};
 if(result?.settlement)return {scene:'settlement',state:'confirmed',evidence:{txHash:result.settlement.txHash,blockNumber:result.settlement.block.number,passed:result.settlement.passed,repaidRaw:result.settlement.repaidRaw,residualRaw:result.settlement.residualRaw,slashedRaw:result.settlement.slashedRaw}};
 if(run.status==='Failed')return {scene:reason?.includes('REVIEW')?'review':'interruption',state:'failed',reason};
 if(run.action==='provision')return {scene:'onboarding',state:successful(run)?'confirmed':'started',evidence:{txHash:result?.txHash,agentId:result?.binding?.agentId}};
 if(run.action==='deposit')return {scene:'funding',state:successful(run)?'confirmed':'waiting',evidence:{cashRaw:result?.cashRaw,txHash:result?.txHash}};
 if(run.action==='game')return {scene:'game',state:successful(run)?'completed':'waiting',evidence:{matchId:result?.matchId,...(successful(run)&&(result?.txHash&&positive(result.rewardRaw)||(result?.creditsGranted??0)>0)?{txHash:result?.txHash,rewardRaw:result?.txHash?result?.rewardRaw:undefined,creditsGranted:result?.creditsGranted}:{})}};
 if(successful(run))return {scene:'delivery',state:'completed'};
 if(run.status==='Succeeded'&&!successful(run))return {scene:'review',state:'failed',reason};
 if(view){
  if(view.stage==='planning')return {scene:'decision',state:'started'};
  if(view.stage==='reviewing')return {scene:'review',state:'started',subject:{id:'reviewer',name:'Independent Reviewer',kind:'specialist'}};
  if(view.stage==='executing'){
   const phase=view.phases.find(p=>!p.output),role=phase&&resolveSpecialist(phase.taskType);
   return {scene:'execution',state:'started',...(role?{subject:{id:role.id,name:role.name,kind:'specialist' as const}}:{})};
  }
 }
 const phase=result?.phase;
 if(run.action==='autonomous'&&phase==='Deciding')return {scene:'decision',state:'started'};
 if(phase==='Selected'||phase==='AcceptPending')return {scene:'task',state:phase==='Selected'?'selected':'waiting',evidence:{taskId:result?.taskId,acceptTxHash:result?.acceptTxHash}};
 if(phase==='SubmissionPending')return {scene:'review',state:'waiting',evidence:{taskId:result?.taskId,txHash:result?.txHash}};
 if(phase==='RefundPending')return {scene:'interruption',state:'reconciling',reason,requiredAction:'reconcile'};
 return {scene:'execution',state:'started'};
}
function labelFor(scene:HostedScene,state:HostedActivityState,evidence:HostedActivityEvidence,requiredAction?:HostedRequiredAction,run?:HostedRun) {
 const symbol=settlementSymbol(evidence.chainId);
 if(state==='stopping')return '停止新动作 · 确认已有调用';
 if(state==='reconciling')return '结果待确认 · 保留原请求';
 if(state==='refunded')return '已确认退款';
 if(state==='cancelled')return '已取消 · 保留已有产出';
 if(state==='paused')return '已暂停';
 if(state==='failed')return scene==='review'?'复核未通过 · 保留产出':'已失败 · 保留费用与凭证';
 if(requiredAction)return ({configure:scene==='funding'?'预算达到上限':'等待模型与预算配置',deposit:'资金 / 额度不足', 'fund-gas':'等待补充 Gas','provide-input':'等待你补充信息',resume:'等待恢复原请求',reconcile:'结果待确认','play-game':'奖励额度不足 · 等待补给'} as const)[requiredAction];
 if(state==='blocked')return scene==='specialists'?'没有可调用的匹配专家':scene==='chain-lookup'?'部分链上来源不可用':scene==='funding'?'原模型额度包不足':'等待处理';
 const terminal=['confirmed','completed'].includes(state);
 switch(scene){
  case 'onboarding':return terminal?'链上身份已确认':state==='queued'?'开户排队中':'等待链上开户';
  case 'idle':return state==='queued'?'请求排队 · 尚未执行':'等待下一项目标';
  case 'decision':return terminal?'决策已保存':state==='waiting'?'等待下一轮决策':'读取目标 · 规划步骤';
  case 'chain-lookup':return terminal?'链上快照已取得':'查询链上来源';
  case 'specialists':return state==='selected'?'已选中专家':state==='waiting'?'筛选可调用服务':'读取专家目录';
  case 'task':return terminal?'接单已确认':state==='selected'?'已选择报酬任务':state==='waiting'?'接单待确认':'查找托管报酬任务';
  case 'funding':return terminal?'资金状态已确认':'核对现金 / 额度 / Gas';
  case 'credit':return terminal?'信用支付已确认':state==='waiting'?'信用支付待确认':'核对本次任务授信';
  case 'model':return terminal?'本次用量已确认':state==='selected'?'模型与报价已选定':state==='waiting'?'等待原模型响应':'模型付款 / 额度预留';
  case 'execution':return terminal?'阶段产出已保存':state==='waiting'?'等待专家产出':'专家执行中';
  case 'review':return state==='revising'?'按复核意见修订':terminal?(evidence.passed===false?'复核未通过':'验收结果已确认'):state==='waiting'?'成果已提交 · 等待验收':run?.action==='goal'?'独立模型复核':'可验证任务验收';
  case 'game':return evidence.outcome==='lost'?'对局结束 · 未获奖':evidence.outcome==='draw'?(terminal&&(evidence.txHash&&positive(evidence.rewardRaw)||(evidence.creditsGranted??0)>0)?'平局 · 奖励已确认':'对局结束 · 平局'):evidence.outcome==='no-reward'?'对局结束 · 无奖励':terminal&&(evidence.txHash&&positive(evidence.rewardRaw)||(evidence.creditsGranted??0)>0)?'获奖入账已确认':terminal?'对局结果已保存':state==='selected'?'对局已入场':state==='waiting'?'等待对局 / 对手':'正在对局';
  case 'settlement':return run?.action==='game'?terminal?((evidence.creditsGranted??0)>0?'模型额度奖励已确认':evidence.txHash&&positive(evidence.rewardRaw)?`${symbol} 奖励已确认`:'奖励结果待确认'):'奖励待确认':terminal?(evidence.passed===false?'失败结算已确认':positive(evidence.repaidRaw)?'还款与收入已确认':'任务收入结算已确认'):state==='waiting'?'结算待确认':'核对结算';
  case 'delivery':return terminal?'交付物已保存':state==='waiting'?'等待下一轮授权':'整理交付物';
  default:return '等待确认状态';
 }
}
function roleObject(id:string,name?:string,selected=false):SceneObject {
 if(id==='tabby/reviewer')id='reviewer';
 const role=resolveSpecialist(id);return {id:role?.id??id,name:name??role?.name??id,label:role?.kind??(id==='reviewer'?'独立复核':id),kind:'specialist',selected,detail:role?.serviceId??(id==='reviewer'?'tabby/reviewer':'内置执行角色')};
}
function objectsFor(scene:HostedScene,activity:ReturnType<typeof fallback>|HostedActivity,e:HostedActivityEvidence,context:TabbySceneContext,run?:HostedRun):SceneObject[] {
 const subject=activity.subject,symbol=settlementSymbol(e.chainId);
 if(scene==='specialists'){
  const candidates=e.candidateIds??[];
  const rows=candidates.map(id=>roleObject(id,context.capabilities?.goals?.external?.services.find(s=>s.id===id)?.name??context.capabilities?.goals?.specialists?.find(s=>s.id===id)?.name,subject?.id===id&&activity.state==='selected'));
  if(subject&&!rows.some(r=>r.id===(resolveSpecialist(subject.id)?.id??subject.id)))rows.push(roleObject(subject.id,subject.name,activity.state==='selected'));
  return rows.slice(0,3);
 }
 if(scene==='funding')return [{id:'cash',name:`现金 ${symbol}`,label:'CASH',kind:'cash',detail:e.cashRaw!==undefined?`${Number(e.cashRaw)/1e6} ${symbol}`:undefined},{id:'quota',name:'模型额度',label:'QUOTA',kind:'quota'},{id:'gas',name:'钱包 Gas',label:'GAS',kind:'gas',selected:activity.requiredAction==='fund-gas'}];
 if(scene==='settlement'&&run?.action==='game')return (e.creditsGranted??0)>0?[{id:'reward',name:'已确认模型额度奖励',label:'CREDITS',kind:'quota',detail:`${e.creditsGranted} tokens`}]:[{id:'reward',name:e.txHash&&positive(e.rewardRaw)?`已确认 ${symbol} 奖励`:'奖励凭证',label:e.txHash&&positive(e.rewardRaw)?symbol:'RECEIPT',kind:e.txHash&&positive(e.rewardRaw)?'cash':'receipt'}];
 if(scene==='settlement'){
  const snapshot=context.finance?.status==='confirmed'&&!context.history&&!context.activity&&['task','reward-task','metered-task','autonomous'].includes(run?.action??'')&&e.blockNumber!==undefined&&context.finance.block.number>=e.blockNumber?context.finance:undefined;
  return [{id:'cash',name:'结算收入',label:'CASH',kind:'cash',detail:e.residualRaw!==undefined?`${Number(e.residualRaw)/1e6} ${symbol}`:undefined},{id:'debt',name:'实际还款',label:'DEBT',kind:'credit',detail:e.repaidRaw!==undefined?`${Number(e.repaidRaw)/1e6} ${symbol}`:undefined},...(run?.action==='goal'?[{id:'receipt',name:'结算凭证',label:'RECEIPT',kind:'receipt',detail:e.txHash}]:[{id:'reputation',name:snapshot?'已核验信誉快照':'信誉待刷新',label:snapshot?`REP ${snapshot.credit.score}`:'REP ...',kind:'reputation',detail:snapshot?`InferScore ${snapshot.credit.score} · 区块 #${snapshot.block.number} · ${snapshot.observedAt}（快照值，不表示本次增长）`:'尚未取得本次结算之后的信誉快照'}])];
 }
 if(subject?.kind==='specialist'||subject?.kind==='agent'&&['specialists','execution'].includes(scene))return [roleObject(subject.id,subject.name,true),{id:'output',name:'阶段产出',label:'OUTPUT',kind:'artifact',detail:context.history?undefined:(run?.mission??run?.result?.mission)?.phases.find(p=>resolveSpecialist(p.taskType)?.id===subject.id)?.output?.slice(0,160)}];
 const defaults:Record<HostedScene,SceneObject>={
  onboarding:{id:'identity',name:'链上身份',label:'AGENT',kind:'agent'},idle:{id:'goal',name:'目标纸条',label:'GOAL',kind:'note'},decision:{id:'goal',name:'目标与决策',label:'GOAL',kind:'note'},'chain-lookup':{id:'chain',name:'链上证据',label:'CHAIN',kind:'chain'},specialists:{id:'catalog',name:'内置专家目录',label:'ROLES',kind:'specialist'},task:{id:'task-board',name:'托管报酬任务板',label:'TASKS',kind:'task'},funding:{id:'funds',name:'资金',label:'CASH',kind:'cash'},credit:{id:'credit',name:'本次信用支付',label:'CREDIT',kind:'credit'},model:{id:'model',name:'模型网关',label:'MODEL',kind:'model'},execution:{id:'terminal',name:'执行终端',label:'EXEC',kind:'terminal'},review:{id:'review',name:'复核工作台',label:'REVIEW',kind:'review'},game:{id:'table',name:'对局桌',label:'GAME',kind:'game'},settlement:{id:'receipt',name:'结算凭证',label:'RECEIPT',kind:'receipt'},delivery:{id:'artifact',name:'交付物',label:'OUTPUT',kind:'artifact'},interruption:{id:'request',name:'原请求',label:'REQUEST',kind:'note'},
 };
 const base=defaults[scene];
 if(scene==='game'&&(e.txHash&&positive(e.rewardRaw)||(e.creditsGranted??0)>0)&&!['lost','no-reward'].includes(e.outcome??''))return [{...base,id:e.matchId??base.id},{id:'reward',name:e.creditsGranted?'已确认模型额度奖励':`已确认 ${symbol} 奖励`,label:e.creditsGranted?'CREDITS':symbol,kind:e.creditsGranted?'quota':'cash'}];
 return [{...base,...(subject?{id:subject.id,name:subject.name,kind:subject.kind,label:subject.kind==='model'?subject.name.slice(0,14):base.label}:{}),...(e.taskId?{detail:`task #${e.taskId}`}:{})}];
}
/** Latest persisted fact wins. Business state never advances with animation time. */
export function tabbyScene(run?:HostedRun,context:TabbySceneContext={}):TabbySceneView {
 const latest=context.activity??run?.activities?.at(-1);
 let activity:ReturnType<typeof fallback>|HostedActivity=latest??fallback(run,context);
 if(!context.activity&&run){
  const guarded=fallback(run,context);
  if(run.status==='Queued'||guarded.state==='stopping'||guarded.state==='reconciling'||guarded.state==='cancelled'||guarded.state==='refunded'||guarded.requiredAction==='provide-input'||['Paused','Failed'].includes(run.status)&&latest&&['started','selected','waiting'].includes(latest.state))activity={...guarded,evidence:{...(latest?.evidence??{}),...(guarded.evidence??{}),chargedRaw:run.chargedRaw,...(run.result?.refundedRaw!==undefined?{refundedRaw:run.result.refundedRaw}:{})}};
 }
 const e={...(activity.evidence??{})};
 e.chainId??=context.agent?.binding?.chainId??run?.result?.chainId;
 if(context.finance?.status==='confirmed'&&activity.scene==='funding'&&!context.history&&!context.activity){e.cashRaw??=context.finance.cashRaw;e.debtRaw??=context.finance.debtRaw;}
 // Rewards need confirmed positive value and a receipt; losses/draws cannot grow a reward node.
 if(activity.scene==='game'||activity.scene==='settlement'&&run?.action==='game'){
  if(['lost','no-reward'].includes(e.outcome??'')){delete e.rewardRaw;delete e.creditsGranted;}
  if(!e.txHash)delete e.rewardRaw;
  if(!['completed','confirmed'].includes(activity.state))delete e.creditsGranted;
 }
 const pose:TabbyPose=activity.state==='revising'?'revise':['blocked','failed','paused','reconciling','stopping','cancelled','refunded'].includes(activity.state)?'blocked':activity.state==='waiting'||activity.state==='queued'?'rest':activity.scene==='idle'?'rest':activity.scene==='decision'?'read':activity.scene==='specialists'?'hunt':activity.scene==='chain-lookup'?'inspect':activity.scene==='task'?'read':['funding','credit'].includes(activity.scene)?'pay':activity.scene==='game'?'play':activity.scene==='review'?'hand':activity.scene==='delivery'?'hand':activity.scene==='settlement'?'inspect':activity.scene==='onboarding'?'think':'work';
 const phaseId='phaseId' in activity?activity.phaseId:undefined;
 const earlier=run?.activities?.filter(event=>!latest||event.seq<=latest.seq)??[];
 const selectedFact=activity.subject&&['specialist','agent'].includes(activity.subject.kind)?activity.subject:phaseId&&['model','funding','credit'].includes(activity.scene)?earlier.findLast(event=>event.phaseId===phaseId&&event.subject&&['specialist','agent'].includes(event.subject.kind))?.subject:undefined;
 let selected=selectedFact?roleObject(selectedFact.id,selectedFact.name):undefined;
 if(phaseId==='review'||phaseId==='revision-review')selected=roleObject('reviewer');
 if(phaseId==='revision'){const phase=(run?.mission??run?.result?.mission)?.phases.at(-1);if(phase)selected=roleObject(phase.taskType);}
 const objects=objectsFor(activity.scene,activity,e,context,run);
 if(selected&&activity.scene==='model')objects.push({...selected,selected:true});
 const animated=!context.history&&!context.activity&&!context.disconnected&&((run?.status==='Running'&&['started','selected','revising','waiting'].includes(activity.state)&&activity.scene!=='idle')||(!run&&activity.scene==='idle'&&context.ready!==false));
 return {scene:activity.scene,state:activity.state,label:context.disconnected?'连接中断 · 保留最近确认状态':!run&&!context.agent&&context.ready===false?'等待创建 Agent':labelFor(activity.scene,activity.state,e,activity.requiredAction,run),pose,animated:!!animated,objects,evidence:e,...(selected?{selectedExpert:{id:selected.id,name:selected.name}}:{}),reason:activity.reason,requiredAction:activity.requiredAction,at:latest?.at??run?.updatedAt??context.agent?.updatedAt,seq:latest?.seq,source:latest?'activity':'snapshot',history:!!context.history||!!context.activity};
}
export function tabbySceneHistory(run:HostedRun,context:TabbySceneContext={}):TabbySceneView[]{return (run.activities??[]).map(activity=>tabbyScene(run,{...context,activity,history:true}));}
/** Practice events come from the referee's match snapshot; they carry no monetary reward. */
export function practiceGameScene(match:PlayMatchView|null,options:{pending?:boolean;disconnected?:boolean}={}):TabbySceneView {
 const state:HostedActivityState=options.pending?'reconciling':match?.status==='cancelled'?'cancelled':match?.status==='finished'?'completed':match?.status==='playing'&&match.yourSeat!==null&&match.actor===match.yourSeat?'started':'waiting';
 const label=options.pending?'操作结果待确认':options.disconnected?'连接中断 · 保留对局状态':!match?'等待练习入场':match.status==='finished'?(match.outcome?.kind==='draw'?'练习结束 · 平局':match.outcome?.winner===match.yourSeat?'练习获胜 · 虚拟筹码':'练习结束 · 虚拟筹码'):match.status==='cancelled'?'练习已取消':match.status==='waiting'?'等待准备 / 对手':match.actor===match.yourSeat?'轮到你的席位行动':'等待对方行动';
 return {scene:'game',state,label,pose:state==='started'?'play':'rest',animated:state==='started'&&!options.disconnected,objects:[{id:match?.id??'practice',name:match?`${match.game} · 练习对局`:'练习游戏桌',label:match?.game?.toUpperCase()??'PRACTICE',kind:'game'}],evidence:match?{matchId:match.id,outcome:match.status==='finished'?'no-reward':undefined}:{},at:match?.updatedAt,source:'practice',history:false};
}
