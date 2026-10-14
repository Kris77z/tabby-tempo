import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import type {useHostedAgentsController} from '../../lib/use-hosted-agents';
import {previewAgent,capabilities,sceneCases,sceneRun} from '../tabby-scenes/scenarios';
import type {HostedRun} from '../../lib/hosted-client';
type State=ReturnType<typeof useHostedAgentsController>;
const Context=createContext<State|null>(null);
const steps=['discovery','selected','execute','model-wait','output-confirmed','review','delivery'];
export function PreviewProvider({children}:{children:ReactNode}){
 const [startedAt]=useState(()=>new Date().toISOString());
 const [step,setStep]=useState(6),[playing,setPlaying]=useState(false),[notice,setNotice]=useState('');
 useEffect(()=>{const receive=(e:MessageEvent)=>{if(e.origin!==location.origin)return;if(e.data?.type==='stage'){setPlaying(false);setStep(Math.max(0,Math.min(6,e.data.index)));}if(e.data?.type==='play'){setStep(0);setPlaying(true);}};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[]);
 useEffect(()=>{window.parent.postMessage({type:'progress',index:step},location.origin);if(!playing||step===6)return;const t=setTimeout(()=>setStep(s=>s+1),5500);return()=>clearTimeout(t);},[step,playing]);
 const item=sceneCases.find(c=>c.id===steps[step])!,base=sceneRun(item)!;
 const output='### 分析结果\n\n已整理合约接口、权限边界和调用方式。\n\n- 读取公开接口与元数据\n- 对比管理员与普通用户权限\n- 汇总待确认项供独立复核\n\n这是界面验收用的示例内容。';
 const activities=steps.slice(0,step+1).flatMap(id=>sceneRun(sceneCases.find(c=>c.id===id)!)?.activities??[]).map((event,i)=>({...event,seq:i+1,at:startedAt}));
 const run:HostedRun={...base,activities,createdAt:startedAt,requestId:'dashboard-acceptance-mission',goal:'分析一份智能合约的接口和权限设计，并给出清晰的使用说明。',chargedRaw:step>=4?'20000':'10000',mission:{stage:step===6?'completed':step===5?'reviewing':step<2?'planning':'executing',phases:[{name:'合约接口与权限分析',taskType:'abi-interact',goal:'读取接口并整理权限关系',...(step>=4?{output}:{})}],calls:step>=4?[{stage:'phase-0',model:'kimi-k2.6',chargedRaw:'20000',promptTokens:1240,completionTokens:680,serviceId:'abi-reader-v1'}]:[],...(step===6?{answer:output,review:{passed:true,summary:'接口说明完整，未确认项已明确列出。',checks:['接口描述一致','权限边界清晰','未夸大安全结论']}}:{})}};
 const selected={...previewAgent,name:'Tabby Research',spentRaw:'180000',activeRequestId:run.requestId};
 const fake=async()=>{setNotice('验收页面：此操作仅预览，不发送交易或调用模型。');return false;};
 const value={snapshot:{agents:[selected],runs:[run],models:[{id:'kimi-k2.6',label:'Kimi K2.6'},{id:'kimi-k3',label:'Kimi K3'}],capabilities},snapshotStale:false,selected,selectedId:selected.id,select:()=>{},access:'authenticated',owner:selected.owner,error:'',notice,busy:false,refreshing:false,pending:null,
 finance:{value:{status:'confirmed',observedAt:run.updatedAt,chainId:'42431',agentId:'1',wallet:selected.wallet,block:{number:123456,hash:'0x'+'0'.repeat(64),timestamp:0},cashRaw:'2400000',debtRaw:'120000',credit:{score:'570',tier:'C',tierCapRaw:'1000000',feeBps:'1500',eligible:true,rejection:null},policy:{maxCashPerTxRaw:'120000',maxDebtPerTxRaw:'100000',maxDebtPerDayRaw:'1000000',ownerFrozen:false},counts:{repayments:'3',defaults:'0',mirrorRepayments:'3',successes:'3',mirrorDefaults:'0'},scannedTaskCount:3,ownedTaskCount:3},stale:false,error:'',loading:false,refresh:async()=>{}},refresh:async()=>{},login:fake,logout:fake,create:fake,run:fake,recover:fake,update:fake,pause:fake,cancelGoal:fake,retryPending:fake} as unknown as State;
 return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useHostedAgents(){const state=useContext(Context);if(!state)throw Error('PreviewProvider required');return state;}
