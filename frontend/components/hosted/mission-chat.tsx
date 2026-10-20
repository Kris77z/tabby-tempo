"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { HostedRun, HostedActivityState } from '../../lib/hosted-client';
import {settlementSymbol} from '../../lib/networks';
import { reasonLabel } from '../../lib/hosted-client';
import { missionChatState } from '../../lib/mission-chat';
import { sceneLabels, tabbySceneHistory } from '../../lib/tabby-scenes';
import { MissionMarkdown } from './mission-markdown';
import { ChainEvidence } from './chain-evidence';
import { TransactionEvidence } from './task-evidence';
import { Icon } from '../icons';
import chat from './mission-chat.module.css';

const marks: Partial<Record<HostedActivityState,string>> = {completed:'✓', confirmed:'✓', selected:'↗', failed:'×', blocked:'!', paused:'Ⅱ', refunded:'↩', cancelled:'−'};
function LoadingState({label,startedAt}:{label:string;startedAt:string}) {
  const [seconds,setSeconds]=useState(0);
  useEffect(()=>{const tick=()=>setSeconds(Math.max(0,Math.floor((Date.now()-Date.parse(startedAt))/1000)) || 0);tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[startedAt]);
  return <span className={chat.loading} role="status"><span className={chat.pixelLoader} aria-hidden="true">{Array.from({length:9},(_,i)=><i key={i} style={{animationDelay:`${i*90}ms`}}/>)}</span><span className={chat.shimmer}>{label}</span><time>{seconds<60?`${seconds}s`:`${Math.floor(seconds/60)}m ${seconds%60}s`}</time></span>;
}
/** Reveal newly received text only. This does not simulate upstream token events. */
function ReceivedText({text,animate}:{text:string;animate:boolean}) {
  const previous=useRef(text),skip=useRef(false),[visible,setVisible]=useState(text);
  useLayoutEffect(()=>{
    const old=previous.current;previous.current=text;skip.current=false;
    if(!animate||!text||old===text||window.matchMedia('(prefers-reduced-motion: reduce)').matches){setVisible(text);return;}
    const chars=Array.from(text),start=text.startsWith(old)?Array.from(old).length:0;
    setVisible(chars.slice(0,start).join(''));
    const began=performance.now();let frame=0,last=-1;
    const tick=(now:number)=>{if(skip.current){setVisible(text);return;}const progress=Math.min(1,(now-began)/900),count=Math.floor(start+(chars.length-start)*progress);if(count!==last){last=count;setVisible(chars.slice(0,count).join(''));}if(progress<1)frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[text,animate]);
  const revealing=visible!==text;
  return text?<div className={chat.answer} data-revealing={revealing}><div aria-hidden={revealing||undefined}><MissionMarkdown text={visible}/></div>{revealing&&<><span className={chat.cursor} aria-hidden="true"/><span className={chat.srOnly}>{text}</span><button className={chat.revealAll} onClick={()=>{skip.current=true;setVisible(text);}}>显示全文</button></>}</div>:null;
}
export function MissionChat({run,agentName,chainId,history=false,disconnected=false}:{run:HostedRun;agentName?:string;chainId?:string;history?:boolean;disconnected?:boolean}) {
  const {view,delivered,live,label,completedPhases}=missionChatState(run,history,disconnected);
  const trace=tabbySceneHistory(run),[expanded,setExpanded]=useState<boolean|undefined>(),[copyState,setCopyState]=useState('');
  const copyTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(copyTimer.current),[]);
  const answer=view?.answer??'';
  async function copy(){try{await navigator.clipboard.writeText(answer);setCopyState('已复制');}catch{setCopyState('复制失败');}clearTimeout(copyTimer.current);copyTimer.current=setTimeout(()=>setCopyState(''),2000);}
  const traceId=useId(),open=expanded??live;
  const sender=agentName||'我的 Agent';
  return <article className={chat.conversation} aria-label="目标任务结果">
    <section className={chat.userMessage} aria-label={`${sender} 的任务`}><span>{sender}</span><p>{run.goal??'执行任务'}</p></section>
    <section className={chat.assistant} aria-label="Tabby 回复">
      <header className={chat.author}><span className={chat.avatar} aria-hidden="true">/ᐠ. .ᐟ\</span><strong>Tabby</strong>{history&&<small>历史记录</small>}</header>
      <div className={chat.assistantBody}>
        <div className={chat.thinking}>
          {/* Controlled adaptation of Beautiful UI Thinking State; see THIRD_PARTY_NOTICES.md. */}
          <button type="button" className={chat.traceToggle} aria-expanded={open} aria-controls={traceId} onClick={()=>setExpanded(!open)}>
            {live?<LoadingState label={label} startedAt={run.createdAt}/>:<><Icon name={delivered?'check':'history'} size={14}/><span>{delivered?'已完成':label}</span>{!!view?.calls.length&&<small>· {view.calls.length} 次调用</small>}</>}
            <span className={chat.chevron} data-open={open}><Icon name="chevron-down" size={13}/></span>
          </button>
          <div id={traceId} className={chat.traceCollapse} data-open={open} aria-hidden={!open} inert={!open}>
            <div className={chat.traceClip}><div className={chat.traceBody}>
            {trace.length>0&&<ol className={chat.trace}>{trace.map((event,i)=>{
              const model=event.objects.find(object=>object.kind==='model'&&object.id!=='model');
              const downgradeReason=event.reason==='HOSTED_GOAL_MODEL_DOWNGRADED'||event.reason==='GATEWAY_MODEL_DOWNGRADED'?event.reason:undefined;
              return <li key={event.seq??i} data-state={event.state}><span aria-hidden="true">{marks[event.state]??'·'}</span><div><strong>{sceneLabels[event.scene]}</strong><p>{event.label}{model&&<> · {model.name}</>}</p>{downgradeReason&&<p>{reasonLabel(downgradeReason)}</p>}{event.selectedExpert&&<small>{event.selectedExpert.name}</small>}</div>{event.evidence.txHash&&<TransactionEvidence hash={event.evidence.txHash} chainId={event.evidence.chainId??chainId} label="凭证"/>}</li>;
            })}</ol>}
            {view?.phases.map((phase,i)=><details className={chat.phase} key={i}><summary><span>{phase.output?'✓':live&&view.stage==='executing'&&i===completedPhases?'◌':'·'} {phase.name}</span><small>{phase.output?'已产出':live&&view.stage==='executing'&&i===completedPhases?'执行中':'待执行'}</small></summary><p>{phase.goal}</p>{phase.output&&<MissionMarkdown text={phase.output}/>}</details>)}
            {!trace.length&&!view?.phases.length&&<p className={chat.quiet}>等待执行计划。</p>}
        {view?.review&&<details className={chat.review} data-passed={view.review.passed}><summary>{view.review.passed?'✓ 独立复核通过':'! 独立复核未通过'} · {view.review.checks.length} 项</summary><p>{view.review.summary}</p><ul>{view.review.checks.map((c,i)=><li key={i}>{c}</li>)}</ul></details>}
            {view?.research&&<ChainEvidence view={view} requestId={run.requestId}/>}
            {!!view?.calls.length&&<details className={chat.receipts}><summary>费用与凭证 · {view.calls.length} 次调用</summary>{view.calls.map((c,i)=><p key={`${c.stage}-${i}`}>{c.serviceId??c.stage} · {c.model} · {Number(c.chargedRaw)/1e6} {settlementSymbol(chainId)} · {c.promptTokens+c.completionTokens} tokens {c.txHash&&<TransactionEvidence hash={c.txHash} chainId={chainId} label="付款凭证"/>}</p>)}</details>}
            </div></div>
          </div>
        </div>
        {answer&&!delivered&&<p className={chat.draftLabel}>{view?.stage==='needs-input'?'需要补充信息':'当前产出 · 等待完成验收'}</p>}
        <ReceivedText text={answer} animate={!history&&!disconnected&&!['Paused','Failed'].includes(run.status)&&!run.stopRequested}/>
        {answer&&<div className={chat.answerActions}><button type="button" onClick={()=>void copy()} aria-label={copyState||'复制回复'} title={copyState||'复制回复'}><Icon name={copyState==='已复制'?'check':'copy'} size={15}/></button><span className={chat.srOnly} role="status">{copyState}</span></div>}
        {run.reason&&<p className={chat.reason}>{reasonLabel(run.reason)}</p>}
      </div>
    </section>
  </article>;
}
