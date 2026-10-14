import type {TabbySceneView} from './tabby-scenes';
export type Interaction='approach'|'inspect'|'pounce'|'absorb'|'retreat'|'rest';
export interface CatMotion {
 x:number;y:number;direction:number;walking:boolean;clock:number;leg:number;restUntil:number;
 key:string;trail:{x:number;y:number}[];lastFoot:number;phase:Interaction;phaseAt:number;
 originX:number;originY:number;targetIndex:number;consumed:string[];cargo:string;feedback:string;
}
export function createCatMotion():CatMotion{return {x:48,y:88,direction:1,walking:false,clock:0,leg:0,restUntil:0,key:'',trail:[],lastFoot:0,phase:'approach',phaseAt:0,originX:48,originY:88,targetIndex:0,consumed:[],cargo:'',feedback:''};}
/** Only confirmed facts can turn a node into a collected capability or result. */
export function collectibleObject(scene:TabbySceneView,index:number){
 const object=scene.objects[index];if(!object||scene.history||scene.evidence.passed===false)return false;
 if(scene.scene==='specialists')return scene.state==='selected'&&!!object.selected;
 if(!['confirmed','completed'].includes(scene.state))return false;
 if(scene.scene==='execution')return object.kind==='artifact';
 if(['chain-lookup','delivery'].includes(scene.scene))return true;
 if(scene.scene==='settlement')return object.kind==='cash'?Number(scene.evidence.residualRaw??scene.evidence.rewardRaw??0)>0:object.kind==='quota'?(scene.evidence.creditsGranted??0)>0:false;
 return false;
}
export function stepCatMotion(m:CatMotion,scene:TabbySceneView,width:number,dt:number,points:{x:number;y:number}[]){
 const clamp=(x:number)=>Math.max(42,Math.min(Math.max(42,width-42),x));
 const key=[scene.scene,scene.state,scene.seq??'snapshot',...scene.objects.map(o=>`${o.id}:${!!o.selected}`)].join('|');
 const delta=Math.max(0,Math.min(dt,48));m.clock+=delta;
 if(key!==m.key){m.key=key;m.leg=0;m.phase='approach';m.phaseAt=m.clock;m.consumed=[];m.feedback='';m.trail=[];}
 m.x=clamp(m.x);
 const selected=scene.objects.findIndex(o=>o.selected),collect=scene.objects.findIndex((_,i)=>collectibleObject(scene,i)&&!m.consumed.includes(scene.objects[i].id));
 const searching=scene.scene==='specialists'&&selected<0;
 m.targetIndex=collect>=0?collect:selected>=0?selected:m.leg%Math.max(1,points.length);
 const point=points[m.targetIndex]??{x:width/2,y:72},object=scene.objects[m.targetIndex];
 const canCollect=collectibleObject(scene,m.targetIndex)&&!m.consumed.includes(object.id);
 const approachX=clamp(point.x+(point.x<width/2?-56:56));
 const move=(x:number,y:number,speed=115)=>{
  const dx=x-m.x,dy=y-m.y,d=Math.hypot(dx,dy),step=speed*delta/1000;
  m.walking=d>1;if(Math.abs(dx)>1)m.direction=Math.sign(dx);
  if(d<=step||d<1){m.x=x;m.y=y;m.walking=false;return true;}
  m.x+=dx/d*step;m.y+=dy/d*step;
  if(m.clock-m.lastFoot>140){m.trail.push({x:m.x-m.direction*23,y:m.y+17});m.trail=m.trail.slice(-8);m.lastFoot=m.clock;}return false;
 };
 const enter=(phase:Interaction)=>{m.phase=phase;m.phaseAt=m.clock;m.originX=m.x;m.originY=m.y;m.walking=false;};
 if(scene.scene==='idle'){
  if(m.clock<m.restUntil){m.walking=false;return;}
  if(move(clamp(width*(m.leg%2?.25:.75)),88,40)){m.leg++;m.restUntil=m.clock+1700;}return;
 }
 switch(m.phase){
  case 'approach':if(move(approachX,point.y+12)){m.direction=point.x>=m.x?1:-1;enter('inspect');}break;
  case 'inspect':
   m.walking=false;m.feedback=searching?'嗅探候选':canCollect?'锁定目标':scene.state==='waiting'?'等待回应':'协作中';
   if(m.clock-m.phaseAt>650){if(canCollect)enter('pounce');else if(searching){m.leg++;enter('approach');}else if(m.clock-m.phaseAt>2000){m.feedback='';enter('rest');}}break;
  case 'pounce':{
   const p=Math.min(1,(m.clock-m.phaseAt)/440),ease=p*p*(3-2*p);
   m.x=m.originX+(clamp(point.x)-m.originX)*ease;m.y=m.originY+(point.y-m.originY)*ease-Math.sin(p*Math.PI)*26;
   m.feedback='';if(p===1)enter('absorb');break;
  }
  case 'absorb':
   m.walking=false;m.feedback=scene.scene==='specialists'?'能力已接入':'已收取结果';
   if(m.clock-m.phaseAt>550){m.consumed.push(object.id);m.cargo=object.label;enter('retreat');}break;
  case 'retreat':if(move(clamp(point.x+(point.x<width/2?58:-58)),point.y+16,65))enter('rest');break;
  case 'rest':
   m.walking=false;
   if(collect>=0)enter('approach');
   else if(!m.consumed.length&&m.clock-m.phaseAt>1400)enter('inspect');
   break;
 }
}
