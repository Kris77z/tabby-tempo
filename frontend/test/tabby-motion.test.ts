import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatMotion,stepCatMotion} from '../lib/tabby-motion';
import {tabbyScene} from '../lib/tabby-scenes';
import {sceneCases,sceneRun} from '../preview/tabby-scenes/scenarios';
import {sceneObjectPositions} from '../lib/tabby-scene-canvas';
test('search patrol crosses the stage and reverses without changing business facts',()=>{
 const scene=tabbyScene(sceneRun(sceneCases.find(s=>s.id==='discovery')!)),before=JSON.stringify(scene),m=createCatMotion(),positions=sceneObjectPositions(scene.objects.length,640);
 let max=0,turned=false;for(let i=0;i<1500;i++){stepCatMotion(m,scene,640,16,positions);max=Math.max(max,m.x);turned ||= m.direction<0;assert.ok(m.x>=42&&m.x<=598);}
 assert.ok(max>500);assert.equal(turned,true);assert.equal(JSON.stringify(scene),before);assert.ok(m.trail.length<=10);
});
test('confirmed selection is contacted and consumed once, while unselected candidates stay',()=>{
 const scene=tabbyScene(sceneRun(sceneCases.find(s=>s.id==='selected')!));
 for(const width of [300,640]){const m=createCatMotion(),positions=sceneObjectPositions(scene.objects.length,width),phases=new Set<string>();for(let i=0;i<1000;i++){stepCatMotion(m,scene,width,16,positions);phases.add(m.phase);assert.ok(m.x>=42&&m.x<=width-42);}assert.deepEqual(m.consumed,[scene.objects[0].id]);assert.equal(m.cargo,scene.objects[0].label);assert.ok(phases.has('pounce'));assert.ok(phases.has('absorb'));assert.equal(m.phase,'rest');}
});
test('search and executing do not consume unconfirmed nodes; confirmed output can be collected',()=>{
 for(const id of ['discovery','execute','model-wait']){const scene=tabbyScene(sceneRun(sceneCases.find(s=>s.id===id)!)),m=createCatMotion();for(let i=0;i<1500;i++)stepCatMotion(m,scene,640,16,sceneObjectPositions(scene.objects.length,640));assert.deepEqual(m.consumed,[]);}
 const scene=tabbyScene(sceneRun({...sceneCases.find(s=>s.id==='execute')!,event:{scene:'execution',state:'completed',subject:{id:'abi-reader-v1',name:'ABI Reader',kind:'specialist'}}})),m=createCatMotion();for(let i=0;i<1000;i++)stepCatMotion(m,scene,640,16,sceneObjectPositions(scene.objects.length,640));assert.deepEqual(m.consumed,['output']);
});
