"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons";
import styles from "./workspace.module.css";
import dropdown from "../terminal/dropdown.module.css";
export interface SelectOption { value:string; label:string; detail?:string; disabled?:boolean }
/** Shared terminal dropdown. Popover top layer prevents clipping inside panels/dialogs. */
export function TerminalSelect({label,value,options,onChange,disabled=false,placeholder="请选择",compact=false,identity=false,iconOnly=false}:{label:string;value:string;options:SelectOption[];onChange:(value:string)=>void;disabled?:boolean;placeholder?:string;compact?:boolean;identity?:boolean;iconOnly?:boolean}){
 const id=useId(), trigger=useRef<HTMLButtonElement>(null), panel=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false);
 const enabled=options.filter(o=>!o.disabled), current=options.find(o=>o.value===value);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!open)return;const element=panel.current,anchor=trigger.current;if(!element||!anchor)return;
   const r=anchor.getBoundingClientRect(),width=Math.min(Math.max(r.width,210),window.innerWidth-24);element.style.width=width+'px';element.style.left=Math.max(12,Math.min(r.left,window.innerWidth-width-12))+'px';
   const below=innerHeight-r.bottom-12;element.style.maxHeight=Math.max(100,Math.min(260,below>=140?below:r.top-12))+'px';element.style.top=below>=140?r.bottom+5+'px':'auto';element.style.bottom=below>=140?'auto':innerHeight-r.top+5+'px';
   element.showPopover();element.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)')?.focus();if(!element.contains(document.activeElement))element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
   const dismiss=()=>setOpen(false);window.addEventListener('resize',dismiss);return()=>{element.hidePopover();window.removeEventListener('resize',dismiss);};
 },[open]);
 return <span className={styles.selectRoot} data-compact={compact}><button ref={trigger} type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-haspopup="listbox" disabled={disabled||!enabled.length} onClick={()=>setOpen(!open)} onKeyDown={e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();setOpen(true);}}} className={identity?dropdown.trigger:styles.selectTrigger}>{!iconOnly&&<span>{current?.label??placeholder}</span>}<Icon name="chevron-down" size={13}/></button>
 <div ref={panel} id={id} popover="auto" role="listbox" aria-label={label} className={dropdown.menu} onToggle={e=>{if((e as unknown as {newState:string}).newState==='closed')setOpen(false);}} onKeyDown={e=>{
   const items=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=items.indexOf(document.activeElement as HTMLButtonElement);
   if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}
   if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab')setOpen(false);
 }}>{options.map(o=><button key={o.value} type="button" role="option" aria-selected={o.value===value} disabled={o.disabled} onClick={()=>{onChange(o.value);close();}}><span>{o.label}</span>{o.detail&&<small>{o.detail}</small>}{o.value===value&&<i aria-hidden="true">✓</i>}</button>)}</div></span>;
}
