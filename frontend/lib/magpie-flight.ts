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
 // Connect the real execution nodes; growing feather trail carries prior context.
 ctx.setLineDash([2,5]);ctx.strokeStyle='#d0c4e5';ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x*CELL,p.y*CELL):ctx.moveTo(p.x*CELL,p.y*CELL));ctx.stroke();ctx.setLineDash([]);
 f.trail.forEach((p,i)=>{ctx.globalAlpha=.5*(1-i/Math.max(1,f.trail.length));ctx.fillStyle=violet;ctx.fillRect(p.x*CELL-2,p.y*CELL-2,4,4);});ctx.globalAlpha=1;
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
 ctx.save();ctx.translate(x,y);ctx.scale(f.direction.x<0?-1:1,1);ctx.rotate(moving?f.direction.y*.12:0);
 // Magpie silhouette: long tail, white shoulder, iridescent wing, small white eye.
 ctx.fillStyle='#25252d';ctx.beginPath();ctx.moveTo(-7,2);ctx.lineTo(-21,10);ctx.lineTo(-16,3);ctx.lineTo(-7,-1);ctx.fill();
 ctx.beginPath();ctx.ellipse(0,0,9,5,-.3,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(8,-6,5,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.moveTo(11,-7);ctx.lineTo(18,-4);ctx.lineTo(11,-3);ctx.fill();
 ctx.fillStyle='#fafafa';ctx.beginPath();ctx.ellipse(0,-1,4,5,-.5,0,Math.PI*2);ctx.fill();
 ctx.save();ctx.translate(-1,-1);ctx.rotate(moving?-.5+Math.sin(time/85)*.7:-.2);ctx.fillStyle=violet;ctx.beginPath();ctx.moveTo(4,2);ctx.lineTo(-10,-14);ctx.lineTo(-15,-12);ctx.lineTo(-7,1);ctx.closePath();ctx.fill();ctx.restore();
 ctx.fillStyle='#fff';ctx.fillRect(9,-8,1.5,1.5);ctx.strokeStyle='#25252d';ctx.beginPath();ctx.moveTo(2,4);ctx.lineTo(4,8);ctx.moveTo(6,3);ctx.lineTo(8,7);ctx.stroke();ctx.restore();
}
