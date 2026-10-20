"use client";
import { networkName, settlementSymbol } from "../../lib/networks";
import dynamic from "next/dynamic";
import "../../app/arena/arena-play.css";
import { pausedRunFunding } from "../../lib/run-funding";
import { AgentProfile } from "./agent-profile";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useHostedAgents } from "../../lib/hosted-agents-provider";
import { actionLabel, inputUsdc, reasonLabel, statusLabel, strategyLabel, type HostedAction, type HostedRun } from "../../lib/hosted-client";
import {runOutcomeLabel} from '../../lib/tabby-scenes';
import { amount } from "../../lib/format";
import { Icon } from "../icons";
import { Card, CardContent, Badge, AgentIdentityCard, CollapsibleSection, runTitle } from "./agora-primitives";
import { AgentSettingsForm } from "./agent-settings-form";
import { FinancialPanel } from "./financial-panel";
import { TaskSettlementSummary, TransactionEvidence } from "./task-evidence";
import { WorkspaceHeader } from "../terminal/workspace-header";
import { TerminalSelect } from "./terminal-select";
import { AgentTicker, GoalTranscript, MagpiePanel } from "./mission-panel";
import { GoalComposer } from "./goal-composer";
import { WorkspaceNotifications } from "./workspace-notifications";
import { ExpertMesh } from "./expert-mesh";
import { MissionHistory } from "./mission-history";
import styles from "./hosted.module.css";
import work from "./workspace.module.css";
import agora from "./agora-workspace.module.css";
const FinanceApp=dynamic(()=>import('./finance-app'));
const ArenaPlay=dynamic(()=>import('../arena-play'));
type CenterPane='mission'|'games'|'finance';
type MobilePane = 'agent'|'requests'|'resources';
const panes:{id:MobilePane;label:string}[]=[{id:'agent',label:'agent.sys'},{id:'requests',label:'mission.log'},{id:'resources',label:'mesh.net'}];
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const operationMode=(value?:string):HostedAction=>value==='task'||value==='metered-task'||value==='autonomous'||value==='game'||value==='reward-task'||value==='deposit'?value:'goal';

/** Layout ported from monad-rebel dashboard; the hosted runtime remains the source of truth. */
export default function HostedApp({initialPanel='mission',initialOperation}:{initialPanel?:CenterPane;initialOperation?:string}){
 const state=useHostedAgents(),router=useRouter();
 const [mobilePane,setMobilePane]=useState<MobilePane>('requests'),[modal,setModal]=useState(false),[historyOpen,setHistoryOpen]=useState(false),[mode,setMode]=useState<HostedAction>('goal');
 const [center,setCenter]=useState<CenterPane>(initialPanel),[gamesOpened,setGamesOpened]=useState(initialPanel==='games'),[profile,setProfile]=useState<{id:string;name:string}|'agent'|null>(null);
 useEffect(()=>{setCenter(initialPanel);if(initialPanel==='games')setGamesOpened(true);},[initialPanel]);
 const [focusedRequest,setFocusedRequest]=useState<string>();
 const [historyMode,setHistoryMode]=useState(false),[sceneExpert,setSceneExpert]=useState<{id:string;name:string}>();
 const latestSeen=useRef<{agentId:string;requestId?:string}|undefined>(undefined);
 const missionScroll=useRef<HTMLDivElement>(null),dialog=useRef<HTMLDialogElement>(null),agent=state.selected;
 const runs=state.snapshot?.runs.filter(r=>r.agentId===agent?.id)??[],active=runs.find(r=>r.requestId===agent?.activeRequestId);
 const selectedRun=runs.find(r=>r.requestId===focusedRequest)??active??runs.find(r=>r.action!=='provision'&&r.action!=='deposit')??runs[0];
 const current=selectedRun?.action==='provision'?undefined:selectedRun;
 const provision=selectedRun?.action==='provision'?selectedRun:runs.find(r=>r.action==='provision');
 const blocked=state.busy||!!state.pending||!agent||agent.status!=='Ready'||!!agent.activeRequestId||agent.configurationRequired===true;
 const waiting=active?.status==='Paused'&&(active.reason==='INFERENCE_FUNDING_REQUIRED'||!!active.fundingNeed)&&!state.busy&&!state.pending&&agent?.status==='Ready';
 const funding=pausedRunFunding(active, state.snapshot?.capabilities);
 const canDeposit=!!waiting&&funding==="cash",canRefuel=!!waiting&&funding==="reward-tokens";
 const finance=state.finance.value?.status==='confirmed'?state.finance.value:null;
 const finished=runs.filter(r=>r.status==='Succeeded'&&!['provision','deposit'].includes(r.action));
 const view=current?.mission??current?.result?.mission;
 const sceneRun=selectedRun??(agent?.status==='Pending'?provision:undefined);
 const sceneProps={run:sceneRun,ready:!!agent&&agent.status==='Ready'&&!agent.configurationRequired,agent:agent??undefined,capabilities:state.snapshot?.capabilities,finance:state.finance.stale?null:state.finance.value,history:historyMode,disconnected:state.snapshotStale,onSelectExpert:setSceneExpert};
 useEffect(()=>{if(modal&&!dialog.current?.open)dialog.current?.showModal();else if(!modal&&dialog.current?.open)dialog.current.close();},[modal]);
 useEffect(()=>{setModal(false);setHistoryOpen(false);setProfile(null);setSceneExpert(undefined);setHistoryMode(false);setFocusedRequest(undefined);},[state.selectedId,state.access]);
 useEffect(()=>{setMode(operationMode(initialOperation));},[state.selectedId,state.access,initialOperation]);
 useEffect(()=>{if(active){setFocusedRequest(active.requestId);setHistoryMode(false);setSceneExpert(undefined);}},[active?.requestId]);
 useEffect(()=>{if(!agent)return;const latest=runs[0]?.requestId;if(latestSeen.current?.agentId===agent.id&&latest&&latestSeen.current.requestId!==latest){setFocusedRequest(latest);setHistoryMode(false);setSceneExpert(undefined);}latestSeen.current={agentId:agent.id,requestId:latest};},[agent?.id,runs[0]?.requestId]);
 useEffect(()=>{missionScroll.current?.scrollTo({top:0});},[current?.requestId]);
 const navigatePane=(pane:CenterPane,value?:HostedAction)=>{
  setCenter(pane);setMode(value??'goal');setMobilePane('requests');if(pane==='games')setGamesOpened(true);
  const url=new URL(window.location.href);url.searchParams.set('panel',pane);
  if(value&&value!=='goal')url.searchParams.set('operation',value);else url.searchParams.delete('operation');
  const href=url.pathname+url.search+url.hash;
  if(href!==window.location.pathname+window.location.search+window.location.hash)router.replace(href,{scroll:false});
 };
 const operation=(value:HostedAction)=>navigatePane(value==='game'?'games':value==='deposit'?'finance':'mission',value);
 const showPane=(pane:CenterPane)=>navigatePane(pane);
 const network=agent?.binding?.chainId?networkName(agent.binding.chainId):"链上待就绪", symbol=settlementSymbol(agent?.binding?.chainId);
 return <div className={`${styles.shell} ${agora.workspace}`} data-testid="hosted-terminal-shell">
 <a href="#hosted-content" className={styles.skipLink}>跳到工作台</a>
 <WorkspaceHeader section="hosted" title="Tabby Agent 工作台" actions={<button className={agora.headerButton} onClick={()=>setHistoryOpen(true)} title="任务历史"><Icon name="history" size={14}/><span>历史</span>{runs.length>0&&<small>{runs.length}</small>}</button>}/>
 <MissionHistory chainId={agent?.binding?.chainId} open={historyOpen} onClose={()=>setHistoryOpen(false)} runs={runs} onSelect={r=>{setFocusedRequest(r.requestId);setHistoryMode(r.requestId!==active?.requestId);setSceneExpert(undefined);showPane('mission');}}/>
 <div className={styles.mobileTabs} role="tablist" aria-label="工作台面板">{panes.map(p=><button key={p.id} id={'tab-'+p.id} role="tab" aria-selected={mobilePane===p.id} aria-controls={'panel-'+p.id} onClick={()=>setMobilePane(p.id)}>{p.label}</button>)}</div>
 <WorkspaceNotifications key={state.selectedId+state.access} error={state.error} notice={state.notice} busy={state.busy||state.refreshing} pending={state.pending?`原请求等待确认 · ${state.pending.kind==='create'?'创建 Agent':actionLabel[state.pending.input.action]}`:undefined} onRefresh={()=>void state.refresh()} onRetry={()=>void state.retryPending()}/>
 <main id="hosted-content" className={styles.main}><div className={agora.columns} data-testid="hosted-terminal-grid">
 <aside id="panel-agent" aria-labelledby="tab-agent" className={agora.side+(mobilePane!=='agent'?' '+agora.mobileHidden:'')} data-testid="hosted-panel-agent">
 <div className={styles.widgetLabel}><Icon name="bot" size={12}/> tabby.agent <i className={agora.agentOrb}/></div>
 <Card className={styles.identityPanel}><CardContent>{agent?<>
 <div className={agora.agentIdentity} data-testid={`hosted-agent-${agent.id}`}><AgentIdentityCard agent={agent} description="" balance={finance?`${inputUsdc(finance.cashRaw)} {symbol}`:undefined} nameControl={<div className={agora.agentNameRow}><h2><button type="button" className={agora.agentName} aria-haspopup="dialog" onClick={()=>setProfile('agent')}>{agent.name}</button></h2>{state.snapshot&&state.snapshot.agents.length>1&&<div className={agora.agentSwitch}><TerminalSelect label="切换 Agent" value={state.selectedId} options={state.snapshot.agents.map(a=>({value:a.id,label:a.name}))} onChange={state.select} disabled={state.busy||!!state.pending} compact identity iconOnly/></div>}</div>}/></div>
 {provision&&(!agent.binding||selectedRun?.action==='provision')&&<section className={agora.provision} aria-label="链上开户"><div><span>链上开户</span><Badge status={provision.status}>{statusLabel[provision.status]}</Badge></div>{provision.reason&&<p>{reasonLabel(provision.reason)}</p>}{provision.recoverable&&<button className={styles.textButton} disabled={state.busy||!!state.pending||!!active&&active.requestId!==provision.requestId} onClick={()=>void state.recover(provision)}>恢复开户 ↻</button>}<details><summary>开户凭证</summary><code>{provision.requestId}</code>{provision.result?.txHash&&<TransactionEvidence hash={provision.result.txHash} chainId={provision.result.chainId??agent.binding?.chainId} label="开户交易"/>}</details></section>}
 <div className={styles.panelDivider}/>
 <CollapsibleSection label="信誉概览" defaultOpen><div className={agora.overview} title="任务与调用统计基于当前保留记录"><div><span>完成任务</span><strong>{finished.length}</strong></div><div><span>InferScore</span><strong>{finance?.credit.score??'—'}</strong></div><div><span>花费 {symbol}</span><strong>{inputUsdc(agent.spentRaw)}</strong></div><div><span>目标调用</span><strong>{runs.reduce((n,r)=>n+((r.mission??r.result?.mission)?.calls.length??0),0)}</strong></div></div><p className={agora.tiny}>Tier {finance?.credit.tier??'—'} · {finance?`已核验区块 #${finance.block.number}`:'等待链上信誉'}</p></CollapsibleSection>
 <div className={styles.panelDivider}/>
 <div className={agora.liveStats}><p>当前任务</p><dl><div><dt>状态</dt><dd><Badge status={current?.status??agent.status}>{current?runOutcomeLabel(current):statusLabel[agent.status]}</Badge></dd></div><div><dt>花费</dt><dd>{inputUsdc(current?.chargedRaw??'0')} {symbol}</dd></div><div><dt>模型调用</dt><dd>{view?.calls.length??'—'}</dd></div><div><dt>单次预算</dt><dd>{inputUsdc(agent.perRunBudgetRaw)} {symbol}</dd></div></dl>{current?.goal&&<p className={agora.missionExcerpt}>{current.goal}</p>}</div>
 <div className={styles.panelDivider}/>
 <CollapsibleSection label="运行配置"><dl className={styles.factList}><div><dt>模型</dt><dd>{agent.modelId||'待设置'}</dd></div><div><dt>策略</dt><dd>{strategyLabel[agent.strategy]}</dd></div><div><dt>任务授信</dt><dd>{agent.allowCredit?'已授权':'关闭'}</dd></div><div><dt>累计预算</dt><dd>{inputUsdc(agent.totalBudgetRaw)} {symbol}</dd></div></dl></CollapsibleSection>
 <div className={agora.agentActions}><button className={styles.textButton} disabled={state.busy||!!state.pending||!!agent.activeRequestId} onClick={()=>setModal(true)}>{agent.configurationRequired?'设置模型与预算 →':'运行设置'}</button><button className={styles.textButton} disabled={state.busy||!!state.pending} onClick={()=>void state.pause(agent)}>{agent.status==='Paused'?'继续 Agent':'暂停 Agent'}</button></div>
 <div className={styles.panelDivider}/><button className={styles.textButton} onClick={()=>showPane('finance')}>资金与借贷 →</button><CollapsibleSection label="资金概览"><FinancialPanel agent={agent} finance={state.finance}/><div className={agora.agentActions}><button className={styles.textButton} onClick={()=>operation('deposit')}>资金入账 ↗</button><button className={styles.textButton} onClick={()=>operation('game')}>游戏赚额度 ↗</button></div></CollapsibleSection>
 <div className={styles.panelDivider}/><CollapsibleSection label="链上信息"><dl className={styles.factList}><div><dt>AGENT ID</dt><dd>{agent.binding?.agentId??'待开户'}</dd></div><div><dt>NETWORK</dt><dd>{network}</dd></div><div><dt>OWNER</dt><dd><code>{agent.owner}</code></dd></div><div><dt>CREATED</dt><dd>{time(agent.createdAt)}</dd></div></dl></CollapsibleSection>
 </>:<div className={agora.signedOut}><p>连接钱包，选择你的 Agent。</p>{state.access==='authenticated'&&<button className={styles.textButton} onClick={()=>router.push('/onboarding')}>创建 Agent →</button>}</div>}</CardContent></Card></aside>
 <section id="panel-requests" aria-labelledby="tab-requests" className={agora.mission+(mobilePane!=='requests'?' '+agora.mobileHidden:'')} data-testid="hosted-panel-requests">
 <div className={agora.centerTabs} role="tablist" aria-label="Dashboard 内容">{([{id:'mission',label:'任务'},{id:'games',label:'游戏'},{id:'finance',label:'资金与借贷'}] as const).map(tab=><button key={tab.id} role="tab" aria-selected={center===tab.id} onClick={()=>showPane(tab.id)}>{tab.label}</button>)}<span>{center==='mission'?'mission.log':center==='games'?'tabby.games':'funds & credit'}</span></div>
 <div className={agora.centerFrame} data-testid="hosted-center-surface" data-panel={center}>
 {center==='finance'&&<div className={agora.centerSurface}>{agent&&<MagpiePanel {...sceneProps}/>}<FinanceApp onTask={()=>operation(state.snapshot?.capabilities?.inference?'metered-task':'task')}/></div>}
 {gamesOpened&&<div className={agora.centerSurface} hidden={center!=='games'}><ArenaPlay hostedTempo={agent?.binding?.chainId === "42431"} embedded initialGame={null} initialMode="challenge" onReward={()=>navigatePane('mission','game')}/></div>}
 <div className={`${agora.centerSurface} ${agora.missionSurface}`} hidden={center!=='mission'}>
 <div ref={missionScroll} className={agora.timeline}>
 <MagpiePanel {...sceneProps}/>
 {historyMode&&active&&<button className={styles.textButton} onClick={()=>{setFocusedRequest(active.requestId);setHistoryMode(false);setSceneExpert(undefined);}}>返回当前运行 →</button>}
 {current?<>{current.action==='goal'?<><div className={work.resultActions}>{current.recoverable&&<button className={styles.textButton} disabled={state.busy||!!state.pending||!!active&&active.requestId!==current.requestId} onClick={()=>void state.recover(current)}>恢复原请求 ↻</button>}{!['Succeeded','Failed'].includes(current.status)&&agent&&<button className={styles.textButton} disabled={state.busy||!!state.pending||!!current.stopRequested} onClick={()=>void state.cancelGoal(agent,current.requestId)}>{current.stopRequested?'正在停止并对账…':'停止任务'}</button>}{canDeposit&&<button className={styles.textButton} onClick={()=>operation('deposit')}>补充资金 →</button>}{canRefuel&&<button className={styles.textButton} onClick={()=>operation('game')}>赢取额度 →</button>}</div><GoalTranscript key={current.requestId} run={current} agentName={agent?.name} chainId={agent?.binding?.chainId} history={historyMode} disconnected={state.snapshotStale}/></>:<div className={agora.operationCard}><RunHistory runs={[current]} activeRequestId={agent?.activeRequestId} chainId={agent?.binding?.chainId} busy={state.busy||!!state.pending} recover={state.recover}/>{canDeposit&&<button className={styles.textButton} onClick={()=>operation('deposit')}>补充资金 →</button>}{canRefuel&&<button className={styles.textButton} onClick={()=>operation('game')}>赢取额度 →</button>}</div>}</>:<div className={agora.awaiting}>等待任务输入<span className={styles.cursor}>_</span></div>}
 </div>
 <section className={agora.composerDock} data-testid="hosted-action-dock" aria-label="Agent 操作">{agent?<GoalComposer key={agent.id} agent={agent} capabilities={state.snapshot?.capabilities} sponsorship={state.snapshot?.sponsorship} disabled={blocked} canDeposit={canDeposit||(!state.busy&&!state.pending&&agent.status==='Ready'&&!agent.activeRequestId)} canRefuel={canRefuel} mode={mode} onMode={operation} run={input=>state.run(agent,input)} onSettings={()=>setModal(true)}/>:<div className={agora.signedOutComposer}><span>// 写作</span><span>// 分析</span><span>// 代码</span><p>❯ 登录并创建 Agent 后输入任务…</p></div>}</section>
 </div>
 </div>
 </section>
 <aside id="panel-resources" aria-labelledby="tab-resources" className={agora.side+(mobilePane!=='resources'?' '+agora.mobileHidden:'')} data-testid="hosted-panel-resources"><div className={styles.widgetLabel}>─ mesh.net</div><ExpertMesh agent={agent??undefined} run={current} history={historyMode} capabilities={state.snapshot?.capabilities} selectedExpertId={sceneExpert?.id} onSelectExpert={setSceneExpert} onProfile={setProfile}/></aside>
 </div></main>
 {profile&&agent&&<AgentProfile agent={agent} runs={runs} finance={state.finance.value} externalServices={state.snapshot?.capabilities?.goals?.external?.services} role={profile==='agent'?undefined:profile} onClose={()=>setProfile(null)}/>}
 <AgentTicker chainId={agent?.binding?.chainId} runs={runs} name={agent?.name}/>
 <dialog ref={dialog} className={styles.dialog} onClose={()=>setModal(false)} onCancel={()=>setModal(false)} aria-labelledby="settings-title"><div className={styles.dialogHeader}><h2 id="settings-title">运行设置</h2><button className={styles.iconButton} aria-label="关闭设置" disabled={state.busy} onClick={()=>setModal(false)}>×</button></div>{modal&&agent&&<AgentSettingsForm chainId={agent.binding?.chainId} key={agent.id} initial={agent} models={state.snapshot?.models??[]} busy={state.busy} serverError={state.error} onClose={()=>setModal(false)} onSubmit={settings=>state.update(agent,settings)}/>}</dialog>
 </div>;
}
function RunHistory({ runs, busy, recover, chainId, activeRequestId, embedded = false }: { embedded?: boolean; runs: HostedRun[]; activeRequestId?: string; chainId?: string; busy: boolean; recover: (run: HostedRun) => Promise<boolean> }) {
  const symbol=settlementSymbol(chainId);
  return <section className={work.runDetail} aria-label="请求记录">{!runs.length ? <div className={styles.emptyCompact}>等待第一个请求。执行状态、确认金额和交易凭证会显示在这里。</div> : runs.map(run => <article className={work.runArticle} key={run.requestId} data-testid={`hosted-run-${run.requestId}`}>{!embedded&&<div className={styles.rowBetween}><h3>{runTitle(run)}</h3><Badge status={run.status}>{runOutcomeLabel(run)}</Badge></div>}{run.reason && <p className={styles.runReason}>{reasonLabel(run.reason)}</p>}{run.result && run.action!=="provision" && <div className={work.runMetrics}><span>已确认推理费 <strong>{amount(run.result.chargedRaw, 6)} {symbol}</strong></span>{run.result.rewardRaw !== undefined && <span>奖励 <strong>{amount(run.result.rewardRaw, 6)} {symbol}</strong></span>}{run.result.creditsGranted !== undefined && <span>赠送 <strong>{run.result.creditsGranted} tokens</strong></span>}{run.result.autonomousTasks !== undefined && <span>连续完成 <strong>{run.result.autonomousTasks} 单</strong></span>}{run.result.autonomousGames !== undefined && <span>自动参赛 <strong>{run.result.autonomousGames} 局</strong></span>}{run.result.creditsUsed !== undefined && <span>消费 <strong>{run.result.creditsUsed} tokens</strong></span>}</div>}<TaskSettlementSummary run={run} chainId={chainId} />{run.recoverable && <div className={styles.recoverRow}><button className={styles.secondaryButton} disabled={busy || !!activeRequestId && activeRequestId !== run.requestId} onClick={() => void recover(run)}>恢复原请求 <Icon name="refresh" size={14} /></button></div>}<CollapsibleSection label="请求详情与凭证"><dl className={styles.factList}><div><dt>请求 ID</dt><dd><code>{run.requestId}</code></dd></div><div><dt>更新时间</dt><dd>{time(run.updatedAt)}</dd></div><div><dt>预留推理预算</dt><dd>{amount(run.reservedRaw, 6)} {symbol}</dd></div>{run.amountRaw !== undefined && <div><dt>入账金额</dt><dd>{amount(run.amountRaw, 6)} {symbol}</dd></div>}{run.result?.cashRaw !== undefined && <div><dt>当次确认 cash</dt><dd>{amount(run.result.cashRaw, 6)} {symbol}</dd></div>}{run.result?.principalRaw !== undefined && <div><dt>剩余借款本金</dt><dd>{amount(run.result.principalRaw, 6)} {symbol}</dd></div>}{run.result?.feeRaw !== undefined && <div><dt>剩余借款 fee</dt><dd>{amount(run.result.feeRaw, 6)} {symbol}</dd></div>}{run.result?.taskId && <div><dt>任务 ID</dt><dd>{run.result.taskId}</dd></div>}{run.result?.matchId && <div><dt>比赛 ID</dt><dd>{run.result.matchId}</dd></div>}{run.result?.paymentId && <div><dt>付款 ID</dt><dd><code>{run.result.paymentId}</code></dd></div>}{run.result?.acceptTxHash && <div><dt>接单交易</dt><dd><TransactionEvidence hash={run.result.acceptTxHash} chainId={run.result.chainId ?? chainId} label="查看接单交易" /></dd></div>}{run.result?.paymentTxHash && <div><dt>付款交易</dt><dd><TransactionEvidence hash={run.result.paymentTxHash} chainId={run.result.chainId ?? chainId} label="查看付款交易" /></dd></div>}{run.result?.refundedRaw !== undefined && BigInt(run.result.refundedRaw) > 0n && <div><dt>已确认退款</dt><dd>{amount(run.result.refundedRaw, 6)} {symbol}</dd></div>}{run.result?.txHash && !run.result.settlement && <div><dt>{run.action === "task" ? "历史交易（未标注用途）" : "确认交易"}</dt><dd><TransactionEvidence hash={run.result.txHash} chainId={run.result.chainId ?? chainId} label="查看交易" /></dd></div>}</dl></CollapsibleSection></article>)}</section>;
}
