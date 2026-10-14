"use client";
import {useEffect,useRef} from 'react';
import {type HostedRun,actionLabel,statusLabel,inputUsdc} from '../../lib/hosted-client';
import {settlementSymbol} from "../../lib/networks";
import {runOutcomeLabel} from '../../lib/tabby-scenes';
import styles from './agora-workspace.module.css';
export function MissionHistory({open,onClose,runs,onSelect,chainId}:{chainId?:string;open:boolean;onClose:()=>void;runs:HostedRun[];onSelect:(run:HostedRun)=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open&&dialog.current?.open)dialog.current.close();},[open]);
 return <dialog ref={dialog} className={styles.historyDrawer} aria-label="任务历史" onCancel={onClose} onClose={onClose} onClick={e=>{if(e.target===e.currentTarget){const r=e.currentTarget.getBoundingClientRect();if(e.clientX>r.right)onClose();}}}>
 <header><span>─ history.log</span><button type="button" onClick={onClose} aria-label="关闭历史">×</button></header>
 <div>{runs.length?runs.map(run=><button key={run.requestId} className={styles.historyItem} data-testid={`history-request-${run.requestId}`} onClick={()=>{onSelect(run);onClose();}}><span><small data-status={run.status}>{runOutcomeLabel(run)}</small><time>{new Date(run.createdAt).toLocaleDateString('zh-CN')}</time></span><p>{run.goal??actionLabel[run.action]}</p><small>{inputUsdc(run.chargedRaw)} {settlementSymbol(run.result?.chainId??chainId)}</small></button>):<p className={styles.historyEmpty}>还没有任务记录 _</p>}</div>
 </dialog>;
}
