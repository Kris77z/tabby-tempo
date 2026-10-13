'use client';
import {useEffect,useRef,useState} from 'react';
import type {HostedRun} from '../../lib/hosted-client';
import {missionProgress} from '../../lib/mission-progress';
import {CELL,FLIGHT_TICK,createFlight,stepFlight,drawFlight,type Flight} from '../../lib/magpie-flight';
import styles from './magpie-panel.module.css';

export function MagpiePanel({run,ready}:{run?:HostedRun;ready:boolean}){
 const [quiet,setQuiet]=useState(false),canvas=useRef<HTMLCanvasElement>(null),runtime=useRef<Flight>(createFlight());
 const progress=missionProgress(run),latest=useRef({progress,quiet});
 const signature=JSON.stringify(progress);
 useEffect(()=>{runtime.current=createFlight();},[run?.requestId]);
 useEffect(()=>{latest.current={progress,quiet};},[signature,quiet]); // The draw loop reads state without rendering React every frame.
 useEffect(()=>{
  const el=canvas.current;if(!el)return;const ctx=el.getContext('2d');if(!ctx)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');let raf=0,lastTick=0,w=0,h=0;
  const size=()=>{const r=el.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);w=r.width;h=r.height;el.width=Math.round(w*dpr);el.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);lastTick=0;};
  const render=(t:number)=>{const {progress:p,quiet:q}=latest.current,moving=p.running&&!q&&!media.matches&&!document.hidden;
   if(!w||!h)return;
   const cols=Math.max(8,Math.floor(w/CELL)),rows=Math.max(6,Math.floor(h/CELL));
   if(t-lastTick>=FLIGHT_TICK||!moving){stepFlight(runtime.current,p.nodes,p.target,cols,rows,moving);lastTick=t;}
   drawFlight(ctx,w,h,runtime.current,p.nodes,p.target,moving?Math.min(1,(t-lastTick)/FLIGHT_TICK):1,moving,t);
   if(moving)raf=requestAnimationFrame(render);
  };
  const start=()=>{cancelAnimationFrame(raf);size();raf=requestAnimationFrame(render);};
  const observer=new ResizeObserver(start);observer.observe(el);media.addEventListener('change',start);document.addEventListener('visibilitychange',start);start();
  return()=>{cancelAnimationFrame(raf);observer.disconnect();media.removeEventListener('change',start);document.removeEventListener('visibilitychange',start);};
 },[signature,quiet,run?.requestId]);
 return <section className={styles.panel} aria-label="Agent 任务状态" data-moving={progress.running&&!quiet}>
  <canvas ref={canvas} className={styles.canvas} aria-hidden="true"/>
  <div className={styles.caption}><span>MAGPIE · {progress.nodes.length?`${progress.done} / ${progress.nodes.length}`:'MISSION'}</span><strong role="status">{progress.label??(ready?'等待你的目标':'等待 Agent 就绪')}</strong></div>
  <ol className={styles.accessible}>{progress.nodes.map((n,i)=><li key={i}>{n.label} · {n.state==='done'?'已产出':n.state==='active'?'进行中':n.state==='blocked'?'已停止':'待执行'}</li>)}</ol>
  <button type="button" className={styles.motion} onClick={()=>setQuiet(!quiet)} aria-pressed={quiet} aria-label={quiet?'开启动画':'暂停动画'}>{quiet?'▷':'Ⅱ'}</button>
 </section>;
}
