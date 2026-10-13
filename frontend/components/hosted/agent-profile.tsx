"use client";
import { networkName, settlementSymbol } from "../../lib/networks";
import {useEffect,useRef} from 'react';
import {type HostedAgent,type HostedRun,type HostedFinance,statusLabel,inputUsdc} from '../../lib/hosted-client';
import {resolveSpecialist} from '../../../services/hosted-agents/src/specialists/catalog';
import {ChainEvidence} from './chain-evidence';
import {agentEvidence,roleCalls} from '../../lib/agent-evidence';
import {TransactionEvidence} from './task-evidence';
import reputation from '../../lib/demo-expert-reputation.json';
import styles from './agent-profile.module.css';
export function AgentProfile({agent,runs,finance,role,onClose}:{agent:HostedAgent;runs:HostedRun[];finance?:HostedFinance|null;role?:{id:string;name:string};onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{dialog.current?.showModal();},[]);
 const owned=runs.filter(r=>r.agentId===agent.id),proofs=agentEvidence(owned,agent.id,agent.binding?.chainId,role?.id);
 const demo=role?reputation.profiles[role.id as keyof typeof reputation.profiles]:undefined;
 const specialist=role?resolveSpecialist(role.id):undefined;
 const calls=role?owned.flatMap(run=>roleCalls(run,role.id).map(call=>({...call,requestId:run.requestId}))):[];
 return <dialog ref={dialog} className={styles.dialog} aria-label={role?`${role.name} 信息与凭证`:`${agent.name} 信息与凭证`} onCancel={onClose} onClose={onClose}>
 <header><div><span>─ identity & evidence</span><h2>{role?.name??agent.name}</h2></div><button onClick={onClose} aria-label="关闭信息卡">×</button></header>
 <div className={styles.body}><dl><div><dt>身份</dt><dd>{role?'内置执行角色':'托管 Agent'}</dd></div>{role?<>{specialist&&<div><dt>服务 ID</dt><dd>{specialist.serviceId}</dd></div>}<div><dt>所属 Agent</dt><dd>{agent.name}</dd></div><div><dt>链上身份</dt><dd>未独立注册，调用由所属 Agent 支付</dd></div></>:<><div><dt>钱包</dt><dd><code>{agent.wallet}</code></dd></div><div><dt>Agent ID</dt><dd>{agent.binding?.agentId??'待开户'}</dd></div><div><dt>网络</dt><dd>{agent.binding?.chainId?networkName(agent.binding.chainId):'待绑定'}</dd></div><div><dt>状态</dt><dd>{statusLabel[agent.status]}</dd></div></>}</dl>
 {!role&&finance?.status==='confirmed'&&<section><h3>链上信誉</h3><dl><div><dt>InferScore / Tier</dt><dd>{finance.credit.score} / {finance.credit.tier}</dd></div><div><dt>已核验区块</dt><dd>#{finance.block.number}</dd></div><div><dt>还款 / 违约</dt><dd>{finance.counts.repayments} / {finance.counts.defaults}</dd></div></dl><code>{finance.block.hash}</code></section>}
 {role&&<section><h3>参考信誉 · 历史样本</h3>{demo?<><p>{demo.reputation.score.toFixed(1)} / 5 · {demo.reputation.count} 条评价</p><dl><div><dt>原服务</dt><dd>{demo.name} · {demo.serviceId}</dd></div><div><dt>快照日期</dt><dd>{reputation.capturedOn}</dd></div></dl><p className={styles.muted}>原目录评价快照，不是本角色在 Tempo 或其他链上的评分。</p></>:<p className={styles.muted}>暂无评价记录。</p>}</section>}
 <section><h3>链上交易 · {proofs.length}</h3>{proofs.length?proofs.map(proof=><article key={`${proof.chainId}-${proof.hash}`}><TransactionEvidence hash={proof.hash} chainId={proof.chainId} label={proof.label}/><time>{new Date(proof.at).toLocaleString('zh-CN')}</time><details><summary>完整哈希与请求 ID</summary><code>{proof.hash}</code><code>{proof.requestId}</code></details></article>):<p className={styles.muted}>当前记录尚无交易哈希。执行状态不代表已上链。</p>}<p className={styles.muted}>仅汇总当前保留请求中已返回的凭证；交易是否成功以回执为准。</p></section>
 {role&&<section><h3>调用记录 · {calls.length}</h3>{calls.map((call,index)=><article key={`${call.requestId}-${index}`}><p>{call.stage} · {call.model} · {inputUsdc(call.chargedRaw)} {settlementSymbol(agent.binding?.chainId)}</p><small>{call.promptTokens} 输入 / {call.completionTokens} 输出 tokens</small>{call.serviceId&&<code>serviceId: {call.serviceId}</code>}{call.promptDigest&&<code>prompt SHA-256: {call.promptDigest}</code>}{call.requestDigest&&<code>requestDigest: {call.requestDigest}</code>}{call.paymentId&&<code>paymentId: {call.paymentId}</code>}{!call.txHash&&<p className={styles.muted}>本条调用未返回链上交易哈希。</p>}</article>)}{!calls.length&&<p className={styles.muted}>尚未调用此角色。</p>}</section>}
 {owned.filter(r=>(r.mission??r.result?.mission)?.research&&(!role||roleCalls(r,role.id).length)).map(r=><ChainEvidence key={r.requestId} view={(r.mission??r.result?.mission)!} requestId={r.requestId}/>)}
 </div></dialog>;
}
