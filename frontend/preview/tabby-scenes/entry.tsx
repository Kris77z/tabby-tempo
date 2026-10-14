import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MagpiePanel} from '../../components/hosted/magpie-panel';
import {ExpertMesh} from '../../components/hosted/expert-mesh';
import {sceneCases,sceneRun,previewAgent,capabilities} from './scenarios';
import './gallery.css';
const groups=[...new Set(sceneCases.map(c=>c.group))];
function App(){
 const [index,setIndex]=useState(sceneCases.findIndex(c=>c.id==='discovery'));
 const [playing,setPlaying]=useState(false);
 const [story,setStory]=useState<number>();
 const storyIds=['discovery','selected','execute','output-confirmed','delivery'];
 const [profile,setProfile]=useState<{id:string;name:string}|null>(null);
 const [selectedRole,setSelectedRole]=useState<{id:string;name:string}|null>(null);
 const item=sceneCases[story===undefined?index:sceneCases.findIndex(c=>c.id===storyIds[story])],baseRun=sceneRun(item),run=baseRun&&story!==undefined?{...baseRun,requestId:'preview-expert-story'}:baseRun,agent={...previewAgent,...item.agent};
 useEffect(()=>{if(!playing)return;const timer=setTimeout(()=>setIndex(i=>(i+1)%sceneCases.length),5000);return()=>clearTimeout(timer);},[index,playing]);
 useEffect(()=>{if(story===undefined||story===storyIds.length-1)return;const timer=setTimeout(()=>setStory(s=>(s??0)+1),6000);return()=>clearTimeout(timer);},[story]);
 const select=(next:number)=>{setStory(undefined);setPlaying(false);setIndex(next);setProfile(null);setSelectedRole(null);};
 return <><header className="gallery-header"><span className="gallery-dots">● <i>●</i> <b>●</b></span><span>Tabby</span><small>/ Agent 场景预览</small><a href="http://127.0.0.1:3024/dashboard">Dashboard ↗</a></header>
 <main className="gallery"><div className="gallery-intro"><div><h1>一只猫，完整的工作旅程。</h1><p>点击场景检查动作、专家联动与中断反馈。</p></div><button onClick={()=>{setStory(0);setPlaying(false);setSelectedRole(null);}}>▷ 播放专家协作</button><button onClick={()=>{setStory(undefined);setPlaying(p=>!p);}}>{playing?'Ⅱ 暂停轮播':'▷ 自动轮播'}</button></div>
 <div className="gallery-grid"><aside className="gallery-list" aria-label="场景目录">{groups.map(group=><section className="gallery-group" key={group}><h2>{group}</h2>{sceneCases.map((s,i)=>s.group===group?<button key={s.id} aria-pressed={index===i} onClick={()=>select(i)}>{s.label}</button>:null)}</section>)}</aside>
 <section className="gallery-main"><div className="gallery-label">TABBY · {item.label}</div><MagpiePanel run={run} ready={agent.status==='Ready'} agent={agent} capabilities={capabilities} disconnected={item.disconnected} onSelectExpert={setSelectedRole}/><p className="gallery-note">{item.note}</p><p className="gallery-footer">场景样例 · 复用正式组件 · 不运行任务、不调用模型、不发送交易</p></section>
 <aside className="gallery-experts" aria-label="专家角色"><div className="gallery-label">EXPERTS · 内置专家</div>{profile&&<div className="gallery-profile"><h3>{profile.name}</h3><p>{profile.id}</p><p>这里仅预览角色联动；真实调用凭证请在 Dashboard 对应请求内查看。</p><button onClick={()=>setProfile(null)}>收起 ×</button></div>}<ExpertMesh agent={agent} run={run} capabilities={capabilities} onProfile={setProfile} selectedExpertId={selectedRole?.id}/></aside></div></main></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
