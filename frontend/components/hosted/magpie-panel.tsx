'use client';
import {useEffect,useRef,useState} from 'react';
import type {HostedAgent,HostedCapabilities,HostedFinance,HostedRun} from '../../lib/hosted-client';
import {tabbyScene,type TabbySceneView} from '../../lib/tabby-scenes';
import {createCatMotion,stepCatMotion,collectibleObject} from '../../lib/tabby-motion';
import {drawTabbyScene,sceneObjectPositions} from '../../lib/tabby-scene-canvas';
import styles from './magpie-panel.module.css';

export interface MagpiePanelProps {
 run?:HostedRun; ready:boolean; agent?:HostedAgent; capabilities?:HostedCapabilities; finance?:HostedFinance|null;
 history?:boolean; disconnected?:boolean; sceneView?:TabbySceneView;
 onSelectExpert?:(role:{id:string;name:string})=>void;
}
/** Historical export remains compatible with the dashboard and standalone preview. */
export function MagpiePanel({run,ready,agent,capabilities,finance,history=false,disconnected=false,sceneView,onSelectExpert}:MagpiePanelProps){
 const [reduced,setReduced]=useState(false);
 const motion=useRef(createCatMotion()),frameTime=useRef<number>(undefined);
 const canvas=useRef<HTMLCanvasElement>(null);
 const scene=sceneView??tabbyScene(run,{agent,ready,capabilities,finance,history,disconnected});
 const moving=(scene.animated||scene.objects.some((_,i)=>collectibleObject(scene,i)))&&!reduced&&!scene.history&&!disconnected;
 const signature=JSON.stringify(scene),latest=useRef({scene,moving});latest.current={scene,moving};
 useEffect(()=>{motion.current=createCatMotion();frameTime.current=undefined;},[run?.requestId]);
 useEffect(()=>{if(scene.selectedExpert)onSelectExpert?.(scene.selectedExpert);},[scene.selectedExpert?.id,scene.selectedExpert?.name,onSelectExpert]);
 useEffect(()=>{
  const el=canvas.current;if(!el)return;const ctx=el.getContext('2d');if(!ctx)return;
  const media=matchMedia('(prefers-reduced-motion: reduce)');let raf=0,w=0,h=0;
  const render=(t:number)=>{if(!w||!h)return;const state=latest.current,animate=state.moving&&!document.hidden&&!media.matches;const dt=frameTime.current===undefined?16:Math.min(48,t-frameTime.current);frameTime.current=t;if(animate)stepCatMotion(motion.current,state.scene,w,dt,sceneObjectPositions(state.scene.objects.length,w));el.dataset.catX=motion.current.x.toFixed(1);el.dataset.catWalking=String(motion.current.walking&&animate);el.dataset.catPhase=motion.current.phase;el.dataset.collected=motion.current.consumed.join(',');drawTabbyScene(ctx,w,h,state.scene,motion.current.clock,animate,!state.moving||state.scene.history?undefined:{...motion.current,walking:motion.current.walking&&animate});if(state.moving&&!document.hidden&&!media.matches)raf=requestAnimationFrame(render);};
  const start=()=>{cancelAnimationFrame(raf);frameTime.current=undefined;const rect=el.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);w=rect.width;h=rect.height;el.width=Math.round(w*dpr);el.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);setReduced(media.matches);raf=requestAnimationFrame(render);};
  const observer=new ResizeObserver(start);observer.observe(el);media.addEventListener('change',start);document.addEventListener('visibilitychange',start);start();
  return()=>{cancelAnimationFrame(raf);observer.disconnect();media.removeEventListener('change',start);document.removeEventListener('visibilitychange',start);};
 },[signature,moving]);
 return <section className={styles.panel} aria-label="Agent 任务状态" data-scene={scene.scene} data-state={scene.state} data-moving={moving} data-history={scene.history}>
  <canvas ref={canvas} className={styles.canvas} aria-hidden="true"/>
  <div className={styles.caption}><span role="status">{scene.history?'回放 · ':''}{scene.label}</span></div>
 </section>;
}
