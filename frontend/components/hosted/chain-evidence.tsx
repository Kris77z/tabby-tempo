"use client";
import type {GoalView} from '../../../services/hosted-agents/src/goal-types';
import styles from './workspace.module.css';
import {networkName,hostedTransactionUrl,hostedAddressUrl} from '../../lib/networks';
export function ChainEvidence({view,requestId}:{view:GoalView;requestId:string}){
 const data=view.research;if(!data)return null;
 const download=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify({requestId,research:data,calls:view.calls},null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`tabby-chain-evidence-${requestId}.json`;link.click();URL.revokeObjectURL(url);};
 return <details className={styles.receipts}><summary>查链来源与凭证 · {data.records.length} 项 · {networkName(data.chainId)}</summary>
 <p>读取时间 {new Date(data.observedAt).toLocaleString('zh-CN')}</p>
 {data.records.map((r,i)=>{const href=r.kind==='transaction'?hostedTransactionUrl(data.chainId,r.target):hostedAddressUrl(data.chainId,r.target);return <div key={`${r.target}-${i}`} style={{margin:'12px 0',overflowWrap:'anywhere'}}><p>{r.kind==='address'?'合约 / 地址':'交易'} · {href?<a href={href} target="_blank" rel="noreferrer"><code>{r.target}</code> ↗</a>:<code>{r.target}</code>}</p><p>区块 #{r.blockNumber} · <code>{r.blockHash}</code></p>
 {r.source&&<p><a href={r.source.url} target="_blank" rel="noreferrer">Sourcify 来源 ↗</a> · {r.source.codeMatched?'已匹配链上字节码':r.source.status==='unverified'?'源码未验证':'源码暂不可用或未匹配'}{r.source.truncated?' · 分析资料有截断':''}</p>}
 <details><summary>读取结果</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:'11px'}}>{JSON.stringify(JSON.parse(r.dataJson),null,2)}</pre></details></div>;})}
 <p style={{overflowWrap:'anywhere'}}>快照摘要 <code>{data.digest}</code></p><p>只读查询，不产生付款交易；模型付款另列。源码验证不等于安全审计。</p><button className={styles.download} onClick={download}>下载查链与付款凭证 ↓</button></details>;
}
