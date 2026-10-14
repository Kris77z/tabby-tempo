"use client";
import { useState } from "react";
import type { HostedRun } from "../../lib/hosted-client";
import { actionLabel } from "../../lib/hosted-client";
import {runOutcomeLabel} from '../../lib/tabby-scenes';
export { MagpiePanel } from "./magpie-panel";
import {settlementSymbol} from "../../lib/networks";
import styles from "./workspace.module.css";
export { MissionChat as GoalTranscript } from './mission-chat';

export function AgentTicker({runs,name,chainId}:{runs:HostedRun[];name?:string;chainId?:string}){
 const [paused,setPaused]=useState(false);const items=runs.filter(r=>r.status==='Succeeded'||r.status==='Failed').slice(0,5);
 const texts=items.length?items.map(r=>`${name??'Agent'} · ${r.action==='goal'?(r.goal??'目标任务').slice(0,36):actionLabel[r.action]} · ${runOutcomeLabel(r)}${r.result?.rewardRaw&&BigInt(r.result.rewardRaw)>0n&&r.result.txHash?' · 收入 '+Number(r.result.rewardRaw)/1e6+' '+settlementSymbol(r.result?.chainId??chainId):''}`):[name?`${name} · 等待下一项任务`:'连接钱包，开始你的 Agent 工作空间'];
 return <footer className={styles.ticker}><span className={styles.tickerDot} aria-hidden="true"/><div className={styles.tickerWindow}><div className={styles.tickerTrack} data-moving={texts.length>1&&!paused}>{texts.map((t,i)=><span key={i}>{t}</span>)}</div></div><button type="button" onClick={()=>setPaused(!paused)} aria-label={paused?'播放 Agent 动态':'暂停 Agent 动态'}>{paused?'▷':'Ⅱ'}</button></footer>;
}
