"use client";
import {networkName} from "../../lib/networks";
import {useRouter} from 'next/navigation';
import type {ReactNode} from 'react';
import {useHostedAgents} from '../../lib/hosted-agents-provider';
import {short} from '../../lib/format';
import {statusLabel} from '../../lib/hosted-client';
import {TerminalHeader} from './terminal-header';
import {AccountMenu} from './account-menu';
import styles from './terminal.module.css';
export function WorkspaceHeader({section,actions,title}:{section:'hosted'|'arena'|'finance';actions?:ReactNode;title:string}){
 const state=useHostedAgents(),router=useRouter(),agent=state.selected;
 const active=state.snapshot?.runs.find(r=>r.requestId===agent?.activeRequestId);
 const network=agent?.binding?networkName(agent.binding.chainId):'链上待就绪';
 return <TerminalHeader workspace={section==='hosted'?'dashboard':section} section={section} title={title} testId={section==='hosted'?'hosted-terminal-header':'terminal-page-header'} dotTestId={section==='hosted'?'hosted-terminal-dot':'terminal-page-dot'} actions={<>{actions}<span className={styles.network}><i data-ready={!!agent?.binding}/>{network}</span>{state.access==='authenticated'?<AccountMenu label={state.owner?short(state.owner,4):'账户'} items={[{label:'创建 Agent',disabled:state.busy||!!state.pending,action:()=>router.push('/onboarding')},{label:'刷新数据',disabled:state.busy||state.refreshing,action:()=>{void state.refresh();void state.finance.refresh();}},{label:'退出登录',disabled:state.busy,action:()=>void state.logout()}]}/>:<button className={styles.headerAction} disabled={state.busy||state.access==='loading'} onClick={()=>void state.login()}>签名登录</button>}<span className={styles.runtimeStatus}>{active?statusLabel[active.status]:agent?.status==='Paused'?'已暂停':'空闲'}</span></>}/>;
}
