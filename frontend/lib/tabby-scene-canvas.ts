import { drawSceneCat, drawTabbyCat } from './tabby-cat';
import type { SceneObject, TabbySceneView } from './tabby-scenes';
import type {CatMotion} from './tabby-motion';
export const SCENE_HEIGHT=184;
export function sceneObjectPositions(count:number,width:number){
 // Equal-width columns keep the group centered at every object count.
 return Array.from({length:count},(_,i)=>({x:width*(i+.5)/count,y:72}));
}
export function sceneObjectGlyphs(object:SceneObject,state:TabbySceneView['state']):string[]{
 switch(object.kind){
  case 'specialist':return [' .---.',` | ${object.selected?'*':'o'} |`,' \'---\''];
  case 'agent':return [' .---.',' | @ |',' \'---\''];
  case 'note':return [' .---.',' | = |',' |___|'];
  case 'chain':return [' [#]--[#]','   \\ /','   [#]'];
  case 'task':return [' +===+',' |[] |',' | []|'];
  case 'cash':case 'funds':case 'wallet':return ['  ___',' ( $ )',' /___\\'];
  case 'quota':return [' +---+',' |:::|',' +---+'];
  case 'gas':return ['   /|','  /_|','    |'];
  case 'credit':return [' .----.',' | C: |',' \'----\''];
  case 'model':case 'terminal':return [' .----.',` |>${state==='waiting'?'..':'_ '}|`,' _|__|_'];
  case 'artifact':return ['  ___',' | = |',' |___|'];
  case 'review':return state==='revising'?[' .---.',' | / |',' |___|']:['  ___',' | ? |',' _|_|_'];
  case 'game':return ['  [] []',' /-----\\',' | o o |'];
  case 'receipt':return [' .---.',' | # |',' |___|'];
  case 'reputation':return ['  /\\',' ( * )','  \\/'];
  default:return [' [ ? ]'];
 }
}
/** Objects and poses change with facts; pulses and footsteps are only visual. */
export function drawTabbyScene(ctx:CanvasRenderingContext2D,w:number,h:number,scene:TabbySceneView,time:number,moving:boolean,motion?:CatMotion){
 ctx.clearRect(0,0,w,h);ctx.strokeStyle='#e9e7ef';ctx.lineWidth=.5;ctx.globalAlpha=.65;
 for(let x=8;x<w;x+=16){for(let y=14;y<h-22;y+=16){ctx.fillStyle='#d8d4e1';ctx.fillRect(x,y,1,1);}}ctx.globalAlpha=1;
 const points=sceneObjectPositions(scene.objects.length,w),catBase=w/2,pulse=moving?Math.sin(time/550):0;
 const catX=motion?.x??catBase,catY=motion?.y??112;
 if(motion){motion.trail.forEach((p,i)=>{ctx.globalAlpha=.12+.3*i/motion.trail.length;ctx.fillStyle='#a78bce';ctx.font='12px monospace';ctx.textAlign='center';ctx.fillText(i%2?'·':':',p.x,p.y);});ctx.globalAlpha=1;}
 scene.objects.forEach((object,i)=>{
  const p=points[i],consumed=motion?.consumed.includes(object.id),touching=motion?.targetIndex===i&&['inspect','pounce','absorb'].includes(motion.phase);
  const progress=motion?.phase==='absorb'&&motion.targetIndex===i?Math.min(1,(time-motion.phaseAt)/550):0;
  ctx.save();ctx.translate(p.x,p.y);ctx.scale(1-progress*.85,1-progress*.85);ctx.globalAlpha=consumed?0:1-progress;
  const lines=sceneObjectGlyphs(object,scene.state);ctx.font='11px "SFMono-Regular", Consolas, "Liberation Mono", monospace';ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=object.selected||touching?'#7c3aed':'#9a91ab';lines.forEach((line,j)=>ctx.fillText(line,0,(j-1)*12));ctx.restore();
  if(touching&&!consumed){ctx.strokeStyle='#b8a5d0';ctx.globalAlpha=.45+pulse*.15;ctx.setLineDash([2,4]);ctx.beginPath();ctx.arc(p.x,p.y,25+progress*20,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;}
  if(progress>0){for(let j=0;j<6;j++){const angle=j*Math.PI/3;ctx.fillStyle='#9b73d6';ctx.globalAlpha=1-progress;ctx.fillRect(p.x+Math.cos(angle)*(18+progress*25),p.y+Math.sin(angle)*(18+progress*25),2,2);}ctx.globalAlpha=1;}
  ctx.fillStyle=consumed?'#7c3aed':object.selected?'#73599c':'#8c8498';ctx.font='9px "SFMono-Regular", Consolas, monospace';ctx.textAlign='center';
  ctx.fillText((consumed?'✓ ':'')+object.label.slice(0,14),p.x,145,Math.max(36,w/Math.max(1,points.length)-24));
 });
 const interacting=motion&&['inspect','pounce','absorb'].includes(motion.phase);
 if(motion?.walking)drawTabbyCat(ctx,catX,catY,motion.direction,true,time,'active');
 else drawSceneCat(ctx,catX,catY+(moving&&!interacting?Math.sin(time/400)*2:0),motion?.phase==='pounce'?'hunt':motion?.phase==='absorb'?'celebrate':motion?.cargo?'hand':interacting?'inspect':scene.pose,time,moving);
 if(motion?.feedback){ctx.font='9px monospace';ctx.fillStyle='#8b76af';ctx.textAlign='center';ctx.fillText(motion.feedback,Math.max(48,Math.min(w-48,catX)),Math.max(14,catY-33));}
 if(motion?.cargo){ctx.font='9px monospace';ctx.fillStyle='#7c3aed';ctx.textAlign='center';ctx.fillText('[✓ '+motion.cargo+']',Math.max(65,Math.min(w-65,catX)),catY+32);}
 ctx.fillStyle='#b4a9c3';ctx.font='9px monospace';ctx.textAlign='center';if(motion&&!motion.cargo)ctx.fillText('TABBY',catX,catY+32);
}
