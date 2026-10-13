"use client";
import { useEffect, useState } from "react";
import styles from "./workspace.module.css";
export function WorkspaceNotifications({error,notice,pending,busy,onRefresh,onRetry}:{error?:string;notice?:string;pending?:string;busy:boolean;onRefresh:()=>void;onRetry:()=>void}) {
 const [dismissed,setDismissed]=useState<string[]>([]);
 useEffect(()=>{setDismissed([]);if(!notice)return;const timer=setTimeout(()=>setDismissed(values=>[...values,notice]),6000);return()=>clearTimeout(timer);},[notice,error,pending]);
 const items=[...(error?[{text:error,kind:'error',action:onRefresh,label:'重新读取'}]:[]),...(pending?[{text:pending,kind:'pending',action:onRetry,label:'继续确认原请求'}]:notice&&!error?[{text:notice,kind:'notice'}]:[])];
 return <aside className={styles.notifications} aria-label="通知">{items.filter(item=>item.kind==='pending'||!dismissed.includes(item.text)).map(item=><div key={item.kind+item.text} className={styles.toast} data-kind={item.kind} role={item.kind==='error'?'alert':'status'}><span>{item.text}</span>{item.action&&<button type="button" disabled={busy} onClick={item.action}>{item.label}</button>}{item.kind!=='pending'&&<button type="button" aria-label="关闭通知" className={styles.toastClose} onClick={()=>setDismissed(values=>[...values,item.text])}>×</button>}</div>)}</aside>;
}
