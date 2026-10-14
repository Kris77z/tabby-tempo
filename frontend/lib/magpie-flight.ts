import { drawTabbyCat } from './tabby-cat';
import type { MissionNode } from './mission-progress';

// Adapted from monad-rebel's snake-engine: grid navigation, persistent trail,
// phase targets and selection locking. A target is collected only on real output.
export type Point = { x:number; y:number };
export type Flight = { bird:Point; previous:Point; direction:Point; trail:Point[]; tick:number; collected:Set<number>; flashes:{index:number;tick:number}[] };
export const CELL=8;
export const FLIGHT_TICK=90;
export const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
export function createFlight():Flight { return {bird:{x:3,y:4},previous:{x:3,y:4},direction:{x:1,y:0},trail:[],tick:0,collected:new Set(),flashes:[]}; }
export function flightTargets(count:number,cols:number,rows:number):Point[]{
 return Array.from({length:count},(_,i)=>({x:count===1?Math.floor(cols/2):Math.round(4+i*Math.max(0,cols-9)/Math.max(1,count-1)),y:clamp(Math.floor(rows/2)+(i%3-1),2,Math.max(2,rows-3))}));
}
export function stepFlight(f:Flight,nodes:MissionNode[],target:number,cols:number,rows:number,moving:boolean){
 f.tick++;
 const points=flightTargets(nodes.length,cols,rows);
 nodes.forEach((n,i)=>{if(n.state==='done'&&!f.collected.has(i)){f.collected.add(i);f.flashes.push({index:i,tick:f.tick});}});
 f.flashes=f.flashes.filter(p=>f.tick-p.tick<12);
 const anchor=points[target]??{x:Math.floor(cols/2),y:Math.floor(rows/2)};
 if(!moving){f.bird={x:clamp(anchor.x-2,2,cols-3),y:anchor.y};f.previous={...f.bird};f.direction={x:nodes[target]?.state==='blocked'?-1:1,y:0};return;}
 // Orbit the current target while waiting. Reaching it never invents completion.
 const orbit=[{x:-3,y:-1},{x:0,y:-2},{x:3,y:-1},{x:3,y:1},{x:0,y:2},{x:-3,y:1}][Math.floor(f.tick/6)%6];
 const destination={x:clamp(anchor.x+orbit.x,2,cols-3),y:clamp(anchor.y+orbit.y,2,rows-2)};
 const dx=destination.x-f.bird.x,dy=destination.y-f.bird.y;
 f.previous={...f.bird};
 if(dx||dy){f.direction=Math.abs(dx)>=Math.abs(dy)?{x:Math.sign(dx),y:0}:{x:0,y:Math.sign(dy)};f.bird={x:clamp(f.bird.x+f.direction.x,2,cols-3),y:clamp(f.bird.y+f.direction.y,2,rows-2)};}
 f.trail.unshift({...f.previous});f.trail.length=Math.min(f.trail.length,4+f.collected.size*3);
}
export function drawFlight(ctx:CanvasRenderingContext2D,w:number,h:number,f:Flight,nodes:MissionNode[],target:number,interpolation:number,moving:boolean,time:number){
 const cols=Math.floor(w/CELL),rows=Math.floor(h/CELL),points=flightTargets(nodes.length,cols,rows);
 const violet='#7c3aed',muted='#94949f';
 ctx.clearRect(0,0,w,h);
 ctx.strokeStyle='#dcdce5';ctx.lineWidth=.5;ctx.globalAlpha=.4;
 for(let x=0;x<w;x+=CELL){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
 for(let y=0;y<h;y+=CELL){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
 ctx.globalAlpha=1;
 // Connect the real execution nodes; growing paw trail carries prior context.
 ctx.setLineDash([2,5]);ctx.strokeStyle='#d0c4e5';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x*CELL,p.y*CELL):ctx.moveTo(p.x*CELL,p.y*CELL));ctx.stroke();ctx.setLineDash([]);
 f.trail.forEach((p,i)=>{ctx.globalAlpha=.5*(1-i/Math.max(1,f.trail.length));ctx.fillStyle=violet;ctx.font='9px monospace';ctx.textAlign='center';ctx.fillText(i%2?'·':':',p.x*CELL,p.y*CELL);});ctx.globalAlpha=1;
 nodes.forEach((n,i)=>{const p=points[i],x=p.x*CELL,y=p.y*CELL;
  const color=n.state==='blocked'?'#bd6541':n.state==='done'?'#19885d':i===target?violet:muted;
  if(n.state==='active'){ctx.strokeStyle=color;ctx.globalAlpha=moving?.25+.2*Math.sin(time/250):.4;ctx.beginPath();ctx.arc(x,y,moving?10+2*Math.sin(time/300):10,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}
  ctx.fillStyle=color;ctx.fillRect(x-3,y-3,6,6);
  ctx.font='8px monospace';ctx.textAlign='center';ctx.fillText(n.state==='done'?'✓':n.state==='blocked'?'!':String(i+1).padStart(2,'0'),x,y-10);
  // A bounded short label; the full accessible stage list remains in the DOM.
  ctx.fillStyle=n.state==='active'?violet:'#777782';ctx.fillText(n.label.slice(0,Math.max(3,Math.min(12,Math.floor(w/Math.max(1,nodes.length)/9)))),x,y+16);
 });
 if(moving)f.flashes.forEach(p=>{const point=points[p.index];if(!point)return;const age=f.tick-p.tick;ctx.strokeStyle='#19885d';ctx.globalAlpha=1-age/12;ctx.beginPath();ctx.arc(point.x*CELL,point.y*CELL,6+age*2,0,Math.PI*2);ctx.stroke();});ctx.globalAlpha=1;
 const x=(f.previous.x+(f.bird.x-f.previous.x)*interpolation)*CELL,y=(f.previous.y+(f.bird.y-f.previous.y)*interpolation)*CELL;
 // Keep the full ASCII silhouette inside narrow and end-of-track viewports.
 drawTabbyCat(ctx,clamp(x,40,Math.max(40,w-40)),clamp(y,20,h-20),f.direction.x,moving,time,nodes[target]?.state);
}
