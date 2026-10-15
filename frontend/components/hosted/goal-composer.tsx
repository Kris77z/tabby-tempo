"use client";
import { settlementSymbol } from "../../lib/networks";
import type { HostedSponsorship } from "../../lib/hosted-client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { type HostedAgent, type HostedCapabilities, type HostedAction, type RunInput, usdcRaw, inputUsdc } from "../../lib/hosted-client";
import { Icon } from "../icons";
import { expandGoalCommand, goalPresets } from "../../lib/goal-presets";
import { TerminalSelect } from "./terminal-select";
import styles from "./workspace.module.css";
import agora from "./agora-workspace.module.css";
import prompt from "./prompt-bar.module.css";
export function GoalComposer({agent,capabilities,sponsorship,disabled,canDeposit,canRefuel,mode,onMode,run,onSettings}:{agent:HostedAgent;capabilities?:HostedCapabilities;sponsorship?:HostedSponsorship;disabled:boolean;canDeposit:boolean;canRefuel:boolean;mode:HostedAction;onMode:(mode:HostedAction)=>void;run:(input:Omit<RunInput,'requestId'>)=>Promise<boolean>;onSettings:()=>void}) {
 const symbol=settlementSymbol(agent.binding?.chainId);
 const [goal,setGoal]=useState(''),[value,setValue]=useState(''),[reward,setReward]=useState('usdc'),[error,setError]=useState('');
 const draftRef=useRef(goal),textarea=useRef<HTMLTextAreaElement>(null),paramInput=useRef<HTMLTextAreaElement>(null);
 const [preset,setPreset]=useState<(typeof goalPresets)[number]>(),[param,setParam]=useState('');
 useEffect(()=>{const el=textarea.current;if(el){el.style.height='22px';el.style.height=Math.min(el.scrollHeight,100)+'px';}},[goal,mode]);
 useEffect(()=>{if(preset)paramInput.current?.focus();},[preset]);
 const draftKey=`tabby.goal-draft:${agent.owner.toLowerCase()}:${agent.id}`;
 useEffect(()=>{try{const saved=sessionStorage.getItem(draftKey)??'';draftRef.current=saved;setGoal(saved);}catch{}},[draftKey]);
 function draft(value:string){draftRef.current=value;setGoal(value);try{if(value)sessionStorage.setItem(draftKey,value);else sessionStorage.removeItem(draftKey);}catch{}}
 const options=[{value:'goal',label:'ϟ 指挥模式'},{value:'task',label:'接取有报酬的任务'},...(capabilities?.inference?[{value:'metered-task',label:'接单 · 按量推理'}]:[]),...(capabilities?.autonomy?[{value:'autonomous',label:'Pi 自主运行'}]:[]),{value:'game',label:'游戏赚资金 / 额度'},...(agent.modelId==='kimi-k2.6'?[{value:'reward-task',label:'用奖励额度接单'}]:[]),{value:'deposit',label:'资金入账'}];
 const gameRemaining=sponsorship?.remaining??0, grant=sponsorship?.testAuthorization;
 const assignedReward=grant?.active?grant.actorRewards.find(a=>a.hostedAgentId===agent.id)?.rewardKind:undefined;
 const gameUnavailable=mode==='game'&&(gameRemaining===0||!!grant?.active&&!assignedReward||canRefuel&&assignedReward==='usdc');
 const gameReward=assignedReward??(canRefuel?'llm-credits':reward);
 const locked=disabled&&!(mode==='deposit'&&canDeposit)&&!(mode==='game'&&canRefuel);
 const unavailable=mode==='goal'&&!capabilities?.goals?.models.some(m=>m.id===agent.modelId);
 async function submit(e:FormEvent){e.preventDefault();if(locked||unavailable||gameUnavailable)return;setError('');try{const input:Omit<RunInput,'requestId'>={action:mode};if(mode==='goal'){if(!goal.trim())return;input.goal=expandGoalCommand(goal);if(input.goal.length>12000)throw new Error('任务太长，请缩短至 12000 字符以内。');}if(mode==='deposit')input.amountRaw=usdcRaw(value);if(mode==='game')input.rewardKind=gameReward as 'usdc'|'llm-credits';const submittedDraft=goal;if(await run(input)){if(mode==='goal'&&draftRef.current===submittedDraft)draft('');if(mode==='deposit')setValue('');}}catch(e){setError(e instanceof Error?e.message:'操作未完成');}}
 const price=capabilities?.goals?.models.find(m=>m.id===agent.modelId)?.pricePerCallRaw;
 const captions:Partial<Record<HostedAction,string>>={task:'执行 → 独立验收 → 还款与收入结算','metered-task':'现金优先；按授权申请任务授信。',autonomous:capabilities?.autonomy?.games?'Pi 自动参赛补给、接单并结算，受预算与次数约束。':'在预算与时限内，由 Pi 决定接取下一单。','reward-task':'使用游戏赢取的额度执行与验收任务。',game:'免费参赛，可信重放决定奖励。',deposit:`先向 Agent 钱包转入 ${symbol}，再确认入账金额。`};
 return <form className={`${styles.composer} ${prompt.bar}`} onSubmit={e=>void submit(e)} aria-label="任务输入">
 <div className={styles.shortcuts} aria-label="快捷指令">{goalPresets.map(p=><button key={p.id} type="button" aria-pressed={preset?.id===p.id} onClick={()=>{onMode('goal');setPreset(preset?.id===p.id?undefined:p);setParam('');setError('');}}>{p.label} …</button>)}<button type="button" data-operation="true" onClick={()=>onMode('task')}>// 接单</button><button type="button" data-operation="true" onClick={()=>onMode('game')}>// 游戏</button></div>
 {preset&&mode==='goal'&&<div className={styles.presetForm}><label htmlFor="goal-preset-param">{preset.field}</label><textarea ref={paramInput} id="goal-preset-param" value={param} maxLength={11500} placeholder={preset.placeholder} onChange={e=>setParam(e.target.value)}/><div><button type="button" onClick={()=>setPreset(undefined)}>取消</button><button type="button" disabled={!param.trim()} onClick={()=>{draft(preset.prefix+param.trim());setPreset(undefined);textarea.current?.focus();}}>填入任务 ↗</button></div></div>}
 {mode==='goal'?<div className={`${styles.composerLine} ${prompt.inputRow}`}><textarea ref={textarea} rows={1} aria-label="任务目标" placeholder="交给 Tabby 一个目标…" value={goal} maxLength={12000} onChange={e=>draft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/></div>:<div className={styles.modeFields}>
 {mode==='deposit'&&<input aria-label={`入账金额（${symbol}）`} inputMode="decimal" placeholder={`${symbol} 金额`} required value={value} onChange={e=>setValue(e.target.value)}/>}
 {mode==='game'&&<TerminalSelect label="比赛奖励" value={gameReward} onChange={setReward} disabled={canRefuel||!!assignedReward} options={[{value:'usdc',label:symbol},{value:'llm-credits',label:'LLM credits'}]}/>}
 <button className={styles.send} type="submit" aria-label="执行操作" disabled={locked||gameUnavailable}><Icon name="send" size={17}/></button><span className={styles.composerHint}>{captions[mode]}</span></div>}
 <div className={`${agora.commandModes} ${prompt.toolbar}`}><TerminalSelect label="操作类型" value={mode} onChange={v=>{onMode(v as HostedAction);setPreset(undefined);setError('');}} options={options} compact/><button className={prompt.model} type="button" onClick={onSettings} disabled={disabled} title="模型与预算设置">{agent.modelId||'选择模型'}</button><details className={agora.commandHelp}><summary title="模型、计费与能力范围">ⓘ</summary>{agent.modelId} · {inputUsdc(price??'0')} {symbol} / 调用 · 上限 {inputUsdc(agent.perRunBudgetRaw)} {symbol}。写作、分析、代码，以及 ABI 解读、Gas 优化、Token 扫描、交易解码、收益资料比较；{capabilities?.goals?.chainLookup?`支持直接输入当前链（${capabilities.goals.chainLookup.chainId}）的合约地址或交易哈希，自动读取链上资料。`:"当前服务尚未启用自动查链，需提供资料。"}{capabilities?.goals?.external?'可发现、比较并付费雇佣已接入的外部 Agent，交付需独立复核。':''}后续调用会按剩余预算切换批准的低价模型。不支持任意网页、文件或代码运行。个人目标使用现金，不产生报酬或授信。</details><span className={prompt.budget}>≤ {inputUsdc(agent.perRunBudgetRaw)} {symbol}</span>{mode==='goal'&&<button className={styles.send} type="submit" aria-label="发送任务" disabled={locked||unavailable||!goal.trim()}><Icon name="send" size={17}/></button>}</div>
 {mode==='game'&&<p className={styles.composerHint}>本 owner 已用 {sponsorship?.used??0} / {sponsorship?.limit??3} 局，剩余 {gameRemaining} 局。{grant&&!grant.active?'测试追加授权已到期。':grant?.active?'仅限指定参赛 Agent 与奖励类型。':''}</p>}
 {agent.configurationRequired?<div className={styles.composerHint}><button type="button" onClick={onSettings}>设置模型与预算 →</button></div>:unavailable?<p className={styles.composerHint}>目标执行服务暂未就绪。</p>:null}
 {error&&<p role="alert">{error}</p>}
 </form>;
}
