"use client";
import { pausedRunFunding } from "../../lib/run-funding";
import { settlementSymbol, networkFeeSymbol } from "../../lib/networks";
import Link from 'next/link';
import {useEffect,useState,type FormEvent} from 'react';
import {useHostedAgents} from '../../lib/hosted-agents-provider';
import {usdcRaw,inputUsdc,reasonLabel,statusLabel} from '../../lib/hosted-client';
import {FinancialPanel} from './financial-panel';
import {AgentSettingsForm} from './agent-settings-form';
import {TransactionEvidence} from './task-evidence';
import styles from './finance.module.css';
import shared from './hosted.module.css';
export default function FinanceApp({onTask}:{onTask:()=>void}){
 const state=useHostedAgents(),agent=state.selected;
 const [amount,setAmount]=useState(''),[error,setError]=useState(''),[settings,setSettings]=useState(false);
 useEffect(()=>{setSettings(false);setError('');setAmount('');},[agent?.id]);
 const active=state.snapshot?.runs.find(r=>r.requestId===agent?.activeRequestId);
 const funding=pausedRunFunding(active,state.snapshot?.capabilities)==="cash";
 const locked=state.busy||!!state.pending||!agent||agent.status!=='Ready'||!agent.binding||!!agent.activeRequestId&&!funding;
 const deposits=state.snapshot?.runs.filter(r=>r.agentId===agent?.id&&r.action==='deposit')??[];
 const latestDeposit=deposits[0];
 useEffect(()=>{if(latestDeposit?.status==='Succeeded')setAmount('');},[latestDeposit?.requestId,latestDeposit?.status,agent?.id]);
 async function deposit(event:FormEvent){event.preventDefault();if(locked||!agent)return;setError('');try{const amountRaw=usdcRaw(amount);if(BigInt(amountRaw)<=0n)throw new Error('请输入大于 0 的金额。');if(await state.run(agent,{action:'deposit',amountRaw}))setAmount('');}catch(e){setError(e instanceof Error?e.message:'金额无效');}}
 const symbol=settlementSymbol(agent?.binding?.chainId), gasSymbol=networkFeeSymbol(agent?.binding?.chainId);
 return <div className={styles.main} aria-label="Agent 资金与借贷">{agent?<>
 <div className={styles.grid}><FinancialPanel agent={agent} finance={state.finance}/><section className={styles.panel}><h2>任务授信</h2><div className={styles.creditState}><span>允许借贷</span><strong>{agent.allowCredit?'已开启':'已关闭'}</strong></div><p>有报酬托管的任务可申请推理资金，验收结算后优先还款；自由目标和游戏不借贷。</p><div className={styles.actions}><button className={shared.textButton} disabled={state.busy||!!state.pending||!!agent.activeRequestId} onClick={()=>setSettings(!settings)}>调整授权与预算</button><button className={shared.textButton} onClick={onTask}>去接单 →</button></div>{agent.activeRequestId&&<p className={styles.hint}>当前请求处理完毕后可调整授权。</p>}</section></div>
 {settings&&<section className={styles.settings}><h2>运行与授信设置</h2><AgentSettingsForm chainId={agent.binding?.chainId} key={agent.id} initial={agent} models={state.snapshot?.models??[]} busy={state.busy||!!state.pending||!!agent.activeRequestId} serverError={state.error} onClose={()=>setSettings(false)} onSubmit={input=>state.update(agent,input)}/></section>}
 <section className={styles.panel}><h2>{symbol} 入账</h2><p>先将 {symbol} 转入上方 Agent 钱包，再确认入账金额。{gasSymbol} 手续费 需单独准备。</p><form onSubmit={e=>void deposit(e)} className={styles.deposit}><label>入账金额（{symbol}）<input aria-label={`入账金额（${symbol}）`} inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" disabled={locked} required/></label><button className={shared.primaryButton} disabled={locked||!amount.trim()}>确认入账</button></form>{error&&<p role="alert">{error}</p>}{!agent.binding&&<p className={styles.hint}>请先在工作台完成链上开户。</p>}{active&&!funding&&<Link href="/dashboard">查看待处理请求 →</Link>}</section>
 {deposits.length>0&&<section className={styles.panel}><h2>入账记录</h2>{deposits.slice(0,10).map(run=><div className={styles.record} key={run.requestId}><span>{inputUsdc(run.amountRaw??'0')} {symbol} · {statusLabel[run.status]}</span><time>{new Date(run.createdAt).toLocaleString('zh-CN')}</time>{run.reason&&<span>{reasonLabel(run.reason)}</span>}{run.recoverable&&<button className={shared.textButton} disabled={state.busy||!!state.pending||!!active&&active.requestId!==run.requestId} onClick={()=>void state.recover(run)}>恢复原请求 ↻</button>}{run.result?.txHash&&<TransactionEvidence hash={run.result.txHash} chainId={agent.binding?.chainId} label="入账交易"/>}</div>)}</section>}
 </>:<section className={styles.panel}><p>{state.access==='authenticated'?'先创建 Agent，再管理它的资金与授信。':'登录后查看你的 Agent 余额、债务与授信。'}</p>{state.access==='authenticated'?<Link href="/onboarding">创建 Agent →</Link>:<button className={shared.textButton} disabled={state.busy} onClick={()=>void state.login()}>签名登录 →</button>}</section>}</div>;
}
