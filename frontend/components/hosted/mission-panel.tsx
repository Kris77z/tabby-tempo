"use client";
import { useState } from "react";
import type { HostedRun } from "../../lib/hosted-client";
import { actionLabel, reasonLabel } from "../../lib/hosted-client";
export { MagpiePanel } from "./magpie-panel";
import { TransactionEvidence } from "./task-evidence";
import { ChainEvidence } from "./chain-evidence";
import { MissionMarkdown } from "./mission-markdown";
import {settlementSymbol} from "../../lib/networks";
import styles from "./workspace.module.css";
import agora from "./agora-workspace.module.css";
export function GoalTranscript({run,chainId}:{run:HostedRun;chainId?:string}){
 const view=run.mission??run.result?.mission;
 const revised=!!view?.answer&&!!view.phases.length&&view.answer!==view.phases[view.phases.length-1].output;
 const download=()=>{const text=[`# 任务目标\n${run.goal??''}`,`# 交付物\n${view?.answer??''}`,view?.review?`## 独立模型复核\n${view.review.summary}\n${view.review.checks.join('\n')}`:''].join('\n\n');const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='tabby-mission-'+run.requestId+'.md';link.click();URL.revokeObjectURL(url);};
 const activeIndex=view?.phases.findIndex(p=>!p.output)??-1;
 return <article className={styles.goalTranscript} aria-label="目标任务结果">
 <details className={agora.missionGoal}><summary>› {run.goal?.slice(0,80)}{(run.goal?.length??0)>80?'…':''}</summary><p>{run.goal}</p></details>
 {view?.phases.map((p,i)=>{const active=run.status==='Running'&&i===activeIndex;return <details key={i} className={agora.phaseCard} data-active={active} data-done={!!p.output} open={active}><summary><span>{p.taskType==='analyst'?'🔍':p.taskType==='coder'?'⌘':'✎'} {String(i+1).padStart(2,'0')} · {p.name}</span><small>[{p.output?'✓ 已产出':active?'▸ 执行中':run.status==='Failed'?'× 未执行':'· 等待'}]</small></summary><p className={agora.phaseBody}>{p.goal}</p>{p.output&&<MissionMarkdown text={p.output}/>}</details>})}
 {view?.review&&<details className={agora.reviewCard} data-passed={view.review.passed}><summary>{view.review.passed?'✓ 独立复核通过':'! 独立复核未通过'} · {view.review.checks.length} 项</summary><p>{view.review.summary}</p><ul>{view.review.checks.map((c,i)=><li key={i}>{c}</li>)}</ul></details>}
 {view?.answer&&<section className={agora.artifact}><h3>{run.status==='Succeeded'?'🏁 任务结果':revised?'修订产出':'阶段产出'}</h3><MissionMarkdown text={view.answer}/><button type="button" className={styles.download} onClick={download}>{run.status==='Succeeded'?'下载交付物 ↓':'下载阶段产出 ↓'}</button></section>}
 {run.reason&&<p className={styles.reason}>{reasonLabel(run.reason)}</p>}
 {view?.research&&<ChainEvidence view={view} requestId={run.requestId}/>}
 {view?.calls.length?<details className={styles.receipts}><summary>费用与调用 · {view.calls.length} 次</summary>{view.calls.map(c=><p key={c.stage}>{c.serviceId??c.stage} · {c.model} · {Number(c.chargedRaw)/1e6} {settlementSymbol(chainId)} · {c.promptTokens+c.completionTokens} tokens {c.txHash&&<TransactionEvidence hash={c.txHash} chainId={chainId} label="付款凭证"/>}</p>)}</details>:null}
 </article>;
}

export function AgentTicker({runs,name,chainId}:{runs:HostedRun[];name?:string;chainId?:string}){
 const [paused,setPaused]=useState(false);const items=runs.filter(r=>r.status==='Succeeded'||r.status==='Failed').slice(0,5);
 const texts=items.length?items.map(r=>`${name??'Agent'} · ${r.action==='goal'?(r.goal??'目标任务').slice(0,36):actionLabel[r.action]} · ${r.status==='Succeeded'?'已完成':'已停止'}${r.result?.rewardRaw?' · 收入 '+Number(r.result.rewardRaw)/1e6+' '+settlementSymbol(r.result?.chainId??chainId):''}`):[name?`${name} · 等待下一项任务`:'连接钱包，开始你的 Agent 工作空间'];
 return <footer className={styles.ticker}><span className={styles.tickerDot} aria-hidden="true"/><div className={styles.tickerWindow}><div className={styles.tickerTrack} data-moving={texts.length>1&&!paused}>{texts.map((t,i)=><span key={i}>{t}</span>)}</div></div><button type="button" onClick={()=>setPaused(!paused)} aria-label={paused?'播放 Agent 动态':'暂停 Agent 动态'}>{paused?'▷':'Ⅱ'}</button></footer>;
}
