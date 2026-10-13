"use client";
import { settlementSymbol } from "../../lib/networks";
import { useLayoutEffect, useRef } from 'react';
import type { HostedAgent, HostedCapabilities, HostedRun } from '../../lib/hosted-client';
import { inputUsdc } from '../../lib/hosted-client';
import { expertAssignments } from '../../lib/expert-assignments';
import styles from './agora-workspace.module.css';
import demoReputation from '../../lib/demo-expert-reputation.json';
type DemoRole = keyof typeof demoReputation.profiles;
const demoForRole = (role: string) => demoReputation.profiles[role as DemoRole];

/** Agora's entry/reorder/glow/stamp effects, driven by hosted execution rather than invented hire events. */
export function ExpertMesh({ agent, run, capabilities, onProfile }: { agent?: HostedAgent; run?: HostedRun; capabilities?: HostedCapabilities; onProfile?:(role:{id:string;name:string})=>void }) {
  const list = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const view = run?.mission ?? run?.result?.mission;
  const executionModel = view?.calls[0]?.model ?? agent?.modelId;
  const model = capabilities?.goals?.models.find(m => m.id === executionModel);
  const rows = expertAssignments(run);
  const order = rows.map(row => row.id).join(',');
  const planning = run?.status === 'Running' && !run.stopRequested && view?.stage === 'planning';

  useLayoutEffect(() => {
    const elements = list.current?.querySelectorAll<HTMLElement>('[data-expert-id]');
    if (!elements) return;
    const animations: Animation[] = [], next = new Map<string, number>();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    elements.forEach(element => {
      const id = element.dataset.expertId!, top = element.offsetTop, previous = positions.current.get(id);
      next.set(id, top);
      if (reduced) return;
      if (previous === undefined) animations.push(element.animate([{ opacity: 0, transform: 'translateX(12px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1.1)' }));
      else if (previous !== top) animations.push(element.animate([{ transform: `translateY(${previous - top}px)` }, { transform: 'translateY(0)' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1.1)' }));
    });
    positions.current = next;
    return () => animations.forEach(animation => animation.cancel());
  }, [order]);

  return <div ref={list} className={styles.meshList}>
    {rows.map(s => {const supported=s.id==='reviewer'||!('directory' in s&&s.directory)||!!capabilities?.goals?.specialists?.some(role=>role.id===s.id);const demo=demoForRole(s.id),rep=demo?.reputation,filled=rep?Math.round(rep.score/5*8):0;return <div key={s.id} data-expert-id={s.id} className={styles.expertMotion}>
      <article className={styles.expertCard} data-active={s.active} data-used={s.used > 0} data-halted={s.halted} data-planning={planning} aria-label={s.name}>
        <div className={styles.expertHeading}><h3><button disabled={!agent} onClick={()=>onProfile?.({id:s.id,name:s.name})} aria-label={`${s.name} 信息与凭证`}>{s.name}</button></h3><span data-active={s.active}>[{s.active ? '▸ 执行中' : s.halted ? (run?.status === 'Failed' ? '! 已停止' : '! 已暂停') : s.used ? '✓ 已调用' : planning ? '· 规划中' : !agent ? '· 待登录' : !supported ? '· 未接入' : model ? '· 待调度' : '· 未配置'}]</span></div>
        <p className={styles.expertKind}>{s.kind}<span> · {model?.id ?? '模型待配置'}</span></p>
        <dl>
          <div><dt>调用价格</dt><dd>{model&&supported ? `${inputUsdc(model.pricePerCallRaw)} ${settlementSymbol(agent?.binding?.chainId)}` : '—'}</dd></div>
          <div><dt>历史样本评分</dt><dd className={rep?styles.reputationScore:styles.unrated} data-tier={rep?(rep.score>=3.5?'high':rep.score>=2.5?'medium':'low'):undefined} title={demo?`${demo.name} (${demo.serviceId}) · 本地快照 ${demoReputation.capturedOn} · ${rep.score}/5，不是当前角色的链上评分`:'原目录没有独立 Reviewer 的评价记录'}><span aria-hidden="true">{'█'.repeat(filled)}{'░'.repeat(8-filled)}</span> {rep?`${rep.score.toFixed(1)} / 5`:'未评级'}</dd></div>
          {rep&&<div><dt>评价样本</dt><dd className={styles.reputationTrend} data-trend={rep.trend} title={`最近评价：${new Date(rep.lastUsedAt*1000).toISOString().slice(0,10)}；趋势来自原目录记录`}>{rep.count} 条 · {rep.trend==='up'?'↑ 上升':rep.trend==='down'?'↓ 下降':'→ 持平'}{!rep.qualified?' · 积累中':''}</dd></div>}
        </dl>
        <div className={styles.expertFooter}><button disabled={!agent} className={styles.profileLink} onClick={()=>onProfile?.({id:s.id,name:s.name})}>信息与凭证 ↗</button><span>本次产出 {s.used}</span></div>
        {s.used > 0 && <span key={`${run?.requestId}-${s.used}`} className={styles.callStamp} aria-hidden="true">CALLED{s.used > 1 && <small>×{s.used}</small>}</span>}
      </article>
    </div>})}

  </div>;
}
