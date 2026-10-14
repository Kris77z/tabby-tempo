import type {HostedAgent,HostedCapabilities,HostedRun} from '../../lib/hosted-client';
import type {HostedActivityInput} from '../../../services/hosted-agents/src/scene-types';
import {missionSpecialists} from '../../../services/hosted-agents/src/specialists/catalog';
const at='2026-10-14T03:00:00.000Z';
export const previewAgent:HostedAgent={id:'scene-preview',owner:'0x1111111111111111111111111111111111111111',wallet:'0x2222222222222222222222222222222222222222',name:'Tabby',modelId:'kimi-k2.6',strategy:'balanced',perRunBudgetRaw:'120000',totalBudgetRaw:'1000000',allowCredit:true,status:'Ready',createdAt:at,updatedAt:at,spentRaw:'0',reservedRaw:'0',binding:{chainId:'42431',agentId:'1',wallet:'0x2222222222222222222222222222222222222222'}};
export const capabilities:HostedCapabilities={goals:{maxPhases:4,models:[{id:'kimi-k2.6',pricePerCallRaw:'10000'},{id:'kimi-k3',pricePerCallRaw:'20000'}],specialists:missionSpecialists.map(s=>({id:s.id,serviceId:s.serviceId,name:s.name,output:s.output}))}};
export interface SceneCase {id:string;group:string;label:string;note:string;event?:HostedActivityInput;events?:HostedActivityInput[];run?:Partial<HostedRun>;agent?:Partial<HostedAgent>;disconnected?:boolean;idle?:boolean}
const specialist={id:'abi-reader-v1',name:'ABI Reader & Explainer',kind:'specialist'} as const;
const model={id:'kimi-k2.6',name:'Kimi K2.6',kind:'model'} as const;
export const sceneCases:SceneCase[]=[
 {id:'idle',group:'准备',label:'待命',note:'等待用户目标；猫的休息动作不代表后台有任务。',idle:true},
 {id:'onboarding',group:'准备',label:'链上开户',note:'开户等待确认。',event:{scene:'onboarding',state:'started'},run:{action:'provision'},agent:{status:'Pending',binding:undefined}},
 {id:'gas',group:'准备',label:'等待 Gas',note:'Gas 不足与模型额度不足是不同阻塞。',event:{scene:'onboarding',state:'blocked',requiredAction:'fund-gas',reason:'HOSTED_WALLET_GAS_REQUIRED'},run:{action:'provision',status:'Paused'},agent:{status:'Pending',binding:undefined}},
 {id:'configure',group:'准备',label:'待运行配置',note:'创建后再配置模型、预算和借贷权限。',idle:true,agent:{configurationRequired:true}},
 {id:'queued',group:'准备',label:'请求排队',note:'Queued 只表示已接收，不显示专家正在执行。',event:{scene:'idle',state:'queued'},run:{status:'Queued'}},
 {id:'planning',group:'目标与专家',label:'理解目标',note:'由任务规划阶段驱动。',event:{scene:'decision',state:'started'}},
 {id:'input',group:'目标与专家',label:'需要补充资料',note:'需要用户回答时保持等待，不显示成功。',event:{scene:'decision',state:'waiting',requiredAction:'provide-input',reason:'HOSTED_GOAL_NEEDS_INPUT'},run:{status:'Failed',reason:'HOSTED_GOAL_NEEDS_INPUT',mission:{stage:'needs-input',phases:[],calls:[]}}},
 {id:'lookup',group:'目标与专家',label:'查链取证',note:'只在真实查询开始后显示取证场景。',event:{scene:'chain-lookup',state:'started',subject:{kind:'chain',id:'tempo',name:'Tempo 地址与交易'}}},
 {id:'discovery',group:'目标与专家',label:'寻找专家',note:'候选来自内置专家目录，不表示全球市场发现。',event:{scene:'specialists',state:'started',evidence:{candidateIds:['abi-reader-v1','token-scanner-v1','tx-decoder-v1'],available:3}}},
 {id:'selected',group:'目标与专家',label:'选中专家',note:'选中的服务与右栏联动；未选中不等于失败。',event:{scene:'specialists',state:'selected',subject:specialist,evidence:{candidateIds:['abi-reader-v1','token-scanner-v1','tx-decoder-v1']}}},
 {id:'no-match',group:'目标与专家',label:'没有匹配专家',note:'没有候选时不能继续演成已委派。',event:{scene:'specialists',state:'blocked',reason:'HOSTED_GOAL_PLAN_INVALID',evidence:{candidateIds:[],available:0}},run:{status:'Paused'}},
 {id:'task-select',group:'任务与资金',label:'挑选托管报酬任务',note:'只适用于接单入口，个人目标不会自动产生报酬。',event:{scene:'task',state:'started'},run:{action:'task'}},
 {id:'task-accept',group:'任务与资金',label:'接单待确认',note:'接单提交与接单确认分别展示。',event:{scene:'task',state:'waiting',subject:{kind:'task',id:'42',name:'托管报酬任务 #42'}},run:{action:'task'}},
 {id:'funding',group:'任务与资金',label:'检查运行资金',note:'现金、债务和预算保持独立单位。',event:{scene:'funding',state:'started',evidence:{cashRaw:'10000',debtRaw:'0',budgetRaw:'120000'}},run:{action:'task'}},
 {id:'funding-short',group:'任务与资金',label:'资金不足',note:'不足时等待补给；不能演成已借到钱。',event:{scene:'funding',state:'blocked',requiredAction:'deposit',reason:'INFERENCE_FUNDING_REQUIRED'},run:{status:'Paused'}},
 {id:'credit',group:'任务与资金',label:'授信检查',note:'授信仅属于支持借贷的报酬托管任务。',event:{scene:'credit',state:'started',evidence:{creditAvailableRaw:'50000',fromCashRaw:'10000',fromCreditRaw:'20000',feeRaw:'1000'}},run:{action:'task'}},
 {id:'credit-confirm',group:'任务与资金',label:'信用支付确认',note:'信用支付可由同笔推理付款完成，不虚构额外放款交易。',event:{scene:'credit',state:'confirmed',evidence:{fromCashRaw:'10000',fromCreditRaw:'20000',feeRaw:'1000'}},run:{action:'task'}},
 {id:'model-select',group:'模型与执行',label:'选择模型',note:'不同模型有不同报价；展示当前选用模型。',event:{scene:'model',state:'selected',subject:model,evidence:{priceRaw:'10000'}}},
 {id:'model-wait',group:'模型与执行',label:'等待模型响应',note:'等待响应不意味着结果已交付。',event:{scene:'model',state:'waiting',subject:model}},
 {id:'execute',group:'模型与执行',label:'专家执行',note:'专家实际开始执行，猫在工作台协作。',event:{scene:'execution',state:'started',phaseId:'phase-0',subject:specialist}},
 {id:'review',group:'模型与执行',label:'独立复核',note:'模型复核与链上结算是不同环节。',event:{scene:'review',state:'started',subject:{id:'tabby/reviewer',name:'Independent Reviewer',kind:'specialist'}}},
 {id:'revision',group:'模型与执行',label:'退回修订',note:'一次修订后再次复核，不是无限自动重试。',event:{scene:'review',state:'revising',subject:specialist}},
 {id:'game',group:'游戏与结算',label:'游戏对局',note:'来自游戏请求，不代表自主决策已支持自动去玩游戏。',event:{scene:'game',state:'started',subject:{kind:'game',id:'holdem',name:'Texas Hold’em'}},run:{action:'game'}},
 {id:'game-wait',group:'游戏与结算',label:'等待对手',note:'等待阶段与自己的决策阶段分开。',event:{scene:'game',state:'waiting',subject:{kind:'game',id:'holdem',name:'Texas Hold’em'}},run:{action:'game'}},
 {id:'game-no-reward',group:'游戏与结算',label:'对局结束 · 无奖励',note:'比赛结束不等于获奖，不能播放奖励到账。',event:{scene:'game',state:'completed',evidence:{outcome:'no-reward',rewardRaw:'0',creditsGranted:0}},run:{action:'game',status:'Succeeded',result:{phase:'Completed',terminal:true,success:true,chargedRaw:'0',rewardRaw:'0'}}},
 {id:'game-credits',group:'游戏与结算',label:'模型额度奖励',note:'额度奖励与 PathUSD 收入分开显示。',event:{scene:'settlement',state:'confirmed',evidence:{creditsGranted:3000}},run:{action:'game',rewardKind:'llm-credits',status:'Succeeded',result:{phase:'Completed',terminal:true,success:true,chargedRaw:'0',creditsGranted:3000}}},
 {id:'settlement',group:'游戏与结算',label:'等待任务结算',note:'还款、收入和信誉可能在一次原子结算中完成。',event:{scene:'settlement',state:'waiting'},run:{action:'task'}},
 {id:'delivery',group:'交付与下一轮',label:'交付完成',note:'个人目标交付不播放接单收入或链上信誉增长。',event:{scene:'delivery',state:'completed'},run:{status:'Succeeded',result:{phase:'Completed',terminal:true,success:true,chargedRaw:'30000'}}},
 {id:'next',group:'交付与下一轮',label:'自主决定下一单',note:'仅在已授权的任务数、预算和时限内继续。',event:{scene:'decision',state:'started',evidence:{completedTasks:1}},run:{action:'autonomous'}},
 {id:'paused',group:'中断与恢复',label:'用户暂停',note:'暂停时不表现为仍在付款或调用模型。',event:{scene:'interruption',state:'paused',requiredAction:'resume',reason:'HOSTED_AGENT_PAUSED'},run:{status:'Paused'}},
 {id:'reconcile',group:'中断与恢复',label:'付款对账',note:'未知付款必须对账，不能直接重付。',event:{scene:'interruption',state:'reconciling',requiredAction:'reconcile',reason:'HOSTED_GOAL_RECONCILIATION_REQUIRED'},run:{status:'Paused',reason:'HOSTED_GOAL_RECONCILIATION_REQUIRED'}},
 {id:'stopping',group:'中断与恢复',label:'停止中',note:'停止新动作并完成未决付款的对账。',event:{scene:'interruption',state:'stopping'},run:{stopRequested:true,status:'Paused'}},
 {id:'cancelled',group:'中断与恢复',label:'已取消',note:'只有确定停止后才显示已取消。',event:{scene:'interruption',state:'cancelled'},run:{status:'Failed',result:{phase:'Cancelled',terminal:true,success:false,chargedRaw:'0'}}},
 {id:'failed',group:'中断与恢复',label:'最终复核失败',note:'阶段执行完也不代表最终验收通过。',event:{scene:'review',state:'failed',evidence:{passed:false}},run:{status:'Failed',reason:'HOSTED_GOAL_REVIEW_FAILED'}},
 {id:'refunded',group:'中断与恢复',label:'退款确认',note:'只有确认退款后显示退款状态。',event:{scene:'interruption',state:'refunded',evidence:{refundedRaw:'10000'}},run:{status:'Failed',result:{phase:'Refunded',terminal:true,success:false,chargedRaw:'10000',refundedRaw:'10000'}}},
 {id:'disconnected',group:'中断与恢复',label:'连接中断',note:'网络断开不等于链上任务失败；保留最近确认状态。',event:{scene:'execution',state:'started',subject:specialist},disconnected:true},
];
export function sceneRun(item:SceneCase):HostedRun|undefined{
 if(item.idle)return undefined;
 const activities=(item.events??(item.event?[item.event]:[])).map((event,i)=>({...event,seq:i+1,at:new Date(Date.parse(at)+i*5000).toISOString()}));
 return {requestId:`preview-${item.id}`,agentId:previewAgent.id,action:'goal',goal:'分析合约并产出可核对的报告',status:'Running',createdAt:at,updatedAt:at,reservedRaw:'120000',chargedRaw:item.run?.result?.chargedRaw??'0',recoverable:false,activities,...item.run};
}

sceneCases.push({id:'history',group:'交付与下一轮',label:'完整过程回看',note:'样例事件按顺序保留；不把历史节点当作当前正在运行；画布不提供交互控件。',events:['planning','lookup','discovery','selected','model-select','model-wait','execute','review','delivery'].map(id=>sceneCases.find(s=>s.id===id)!.event!),run:{status:'Succeeded',result:{phase:'Completed',terminal:true,success:true,chargedRaw:'30000'}}});

sceneCases.push({id:'budget',group:'任务与资金',label:'预算达到上限',note:'预算不足需要调整运行限制，不能简单提示重复充值。',event:{scene:'funding',state:'blocked',requiredAction:'configure',reason:'HOSTED_GOAL_BUDGET_REQUIRED'},run:{status:'Failed',reason:'HOSTED_GOAL_BUDGET_REQUIRED'}});

sceneCases.push({id:'partial-refund',group:'中断与恢复',label:'部分退款 · 仍在对账',note:'一个调用退款不代表整个任务已退款；其它付款未决时仍保持对账状态。',event:{scene:'interruption',state:'reconciling',requiredAction:'reconcile',reason:'HOSTED_GOAL_RECONCILIATION_REQUIRED',evidence:{chargedRaw:'20000',refundedRaw:'10000'}},run:{status:'Paused',reason:'HOSTED_GOAL_RECONCILIATION_REQUIRED',result:{phase:'Paused',terminal:false,success:false,chargedRaw:'20000',refundedRaw:'10000',reason:'HOSTED_GOAL_RECONCILIATION_REQUIRED'}}});

sceneCases.push({id:'output-confirmed',group:'模型与执行',label:'阶段结果确认',note:'只有活动确认阶段产出，猫才收取结果；专家仍保留。',event:{scene:'execution',state:'completed',subject:{id:'abi-reader-v1',name:'ABI Reader & Explainer',kind:'specialist'}}});
