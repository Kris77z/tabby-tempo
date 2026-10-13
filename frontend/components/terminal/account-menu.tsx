"use client";
import {useEffect,useId,useRef,useState} from 'react';
import {Icon} from '../icons';
import styles from './terminal.module.css';
import dropdown from './dropdown.module.css';
export function AccountMenu({label,items}:{label:string;items:{label:string;disabled?:boolean;action:()=>void}[]}){
 const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 useEffect(()=>{if(!open)return;const el=panel.current,button=trigger.current;if(!el||!button)return;const rect=button.getBoundingClientRect();el.style.left=Math.max(12,Math.min(rect.right-210,innerWidth-222))+'px';el.style.top=rect.bottom+5+'px';el.showPopover();el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();const dismiss=()=>setOpen(false);window.addEventListener('resize',dismiss);return()=>{el.hidePopover();window.removeEventListener('resize',dismiss);};},[open]);
 return <div className={styles.account}><button ref={trigger} className={dropdown.trigger} aria-label="账户菜单" aria-expanded={open} aria-haspopup="menu" aria-controls={id} onClick={()=>setOpen(!open)} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);}}}>{label}<Icon name="chevron-down" size={13}/></button><div ref={panel} id={id} className={dropdown.menu} role="menu" popover="auto" onToggle={e=>{if((e as unknown as {newState:string}).newState==='closed')setOpen(false);}} onKeyDown={e=>{const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(e.key==='Escape'){e.preventDefault();close();}if(e.key==='Tab')setOpen(false);}}>{items.map(item=><button key={item.label} role="menuitem" disabled={item.disabled} onClick={()=>{close();item.action();}}>{item.label}</button>)}</div></div>;
}
