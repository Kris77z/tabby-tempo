/** Character-only mascot: frames stay legible when changing direction. */
import type { TabbyPose } from './tabby-scenes';
export function tabbyPoseLines(pose:TabbyPose,frame=0):string[]{
 const paw=frame%2?' / >':' / /';
 switch(pose){
  case 'rest':return [' /\\_/\\','( -.- )___',' \\_______)~'];
  case 'read':return [' /\\_/\\','( o.o )',' /|_[]|\\~'];
  case 'think':return [' /\\_/\\  ?','( o.o )',' /|__|\\~'];
  case 'inspect':return [' /\\_/\\','( >.o )--o',' /|__|\\~'];
  case 'hunt':return [' /\\_/\\',`( ${frame%2?'<.<':'>.>'} )__~`,paw+' > >'];
  case 'work':return [' /\\_/\\','( >.< )',` /|_${frame%2?'//':'__'}|~`];
  case 'pay':return [' /\\_/\\','( o.o )',' /|_$|\\~'];
  case 'hand':return [' /\\_/\\','( ^.^ )--[]',' /|__|\\~'];
  case 'revise':return [' /\\_/\\','( >.< )--/',' /|_[]|\\~'];
  case 'play':return [' /\\_/\\','( >.> )',` /|_${frame%2?'[]':'o '}|\\~`];
  case 'celebrate':return [' \\ /\\_/\\ /','  ( ^.^ )','  /|__|\\~'];
  case 'blocked':return [' /\\_/\\','( !.! )',' /|__|\\)'];
 }
}
export function drawSceneCat(ctx:CanvasRenderingContext2D,x:number,y:number,pose:TabbyPose,time:number,moving:boolean){
 const frame=moving?Math.floor(time/420)%2:0,lines=tabbyPoseLines(pose,frame);
 if(pose==='rest'&&moving)lines[2]=frame?' \\_______)^':' \\_______)~';
 ctx.save();ctx.font='bold 12px "SFMono-Regular", Consolas, "Liberation Mono", monospace';ctx.textAlign='left';ctx.textBaseline='middle';
 const width=Math.max(...lines.map(line=>ctx.measureText(line).width));ctx.strokeStyle='rgba(250,250,253,.96)';ctx.lineWidth=3;
 lines.forEach((line,i)=>{ctx.strokeText(line,x-width/2,y+(i-1)*14);ctx.fillStyle=i===1?'#5b4c78':'#8b76af';ctx.fillText(line,x-width/2,y+(i-1)*14);});ctx.restore();
}
export function drawTabbyCat(
 ctx:CanvasRenderingContext2D,x:number,y:number,direction:number,
 moving:boolean,time:number,state:'waiting'|'active'|'done'|'blocked'|undefined,
){
 const frame=moving?Math.floor(time/150)%4:0;
 const blink=moving&&Math.floor(time/160)%29===0;
 const eyes=state==='blocked'?'!.!':state==='done'?'^.^':blink?'-.-':direction<0?'<.<':'>.>';
 const tail=frame<2?'~':'^';
 const feet=[' / /  > >',' / >  / >',' > >  / /',' > /  > /'];
 const right=['     /\\_/\\',` ${tail}__( ${eyes} )`,feet[frame]];
 const left=[' /\\_/\\',`( ${eyes} )__${tail}`,feet[(frame+2)%4]];
 const resting=[' /\\_/\\ ',`( ${eyes} )`,` /|_|\\${state==='done'?'~':')'}`];
 const lines=moving?(direction<0?left:right):resting;
 ctx.save();ctx.translate(x,y+(moving&&frame%2===1?-1:0));
 ctx.font='bold 11px "SFMono-Regular", Consolas, "Liberation Mono", monospace';
 ctx.textAlign='left';ctx.textBaseline='middle';
 const width=Math.max(...lines.map(line=>ctx.measureText(line).width));
 // A faint paper halo separates glyphs from the grid without enclosing the cat.
 ctx.strokeStyle='rgba(255,255,255,.94)';ctx.lineWidth=3;
 lines.forEach((line,i)=>{const ly=(i-1)*12;ctx.strokeText(line,-width/2,ly);ctx.fillStyle=i===1?'#4c1d95':'#7c3aed';ctx.fillText(line,-width/2,ly);});
 ctx.restore();
}
