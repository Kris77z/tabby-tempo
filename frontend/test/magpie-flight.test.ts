import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlight,stepFlight,flightTargets} from '../lib/magpie-flight';
import type {MissionNode} from '../lib/mission-progress';
test('hunting a target cannot complete it; persisted output grows the context trail once',()=>{
 const f=createFlight(),nodes:MissionNode[]=[{label:'规划',state:'done'},{label:'专家',state:'active'},{label:'复核',state:'waiting'}];
 for(let i=0;i<200;i++)stepFlight(f,nodes,1,80,10,true);
 assert.deepEqual([...f.collected],[0]);assert.equal(f.trail.length,7);assert.equal(nodes[1].state,'active');
 nodes[1].state='done';nodes[2].state='active';for(let i=0;i<50;i++)stepFlight(f,nodes,2,80,10,true);
 assert.deepEqual([...f.collected],[0,1]);assert.equal(f.trail.length,10);
});
test('paused or failed flight rests beside the real blocked node, without growing the trail',()=>{
 const f=createFlight(),nodes:MissionNode[]=[{label:'专家',state:'blocked'}];
 stepFlight(f,nodes,0,40,10,false);const pos={...f.bird};for(let i=0;i<20;i++)stepFlight(f,nodes,0,40,10,false);
 assert.deepEqual(f.bird,pos);assert.equal(f.direction.x,-1);assert.equal(f.collected.size,0);assert.equal(f.trail.length,0);
 assert.ok(flightTargets(6,35,10).every(p=>p.x>=0&&p.x<35&&p.y>=0&&p.y<10));
});
