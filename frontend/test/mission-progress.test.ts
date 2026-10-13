import test from 'node:test';
import assert from 'node:assert/strict';
import { missionProgress } from '../lib/mission-progress';
import { expandGoalCommand } from '../lib/goal-presets';
import type { HostedRun } from '../lib/hosted-client';
const make=(values:Partial<HostedRun>):HostedRun=>({requestId:'test',agentId:'test',action:'goal',status:'Running',createdAt:'',updatedAt:'',reservedRaw:'0',chargedRaw:'0',recoverable:false,...values});
test('progress advances only with persisted outputs, then waits for review',()=>{
 const mission={stage:'executing' as const,phases:[{name:'分析',taskType:'analyst',goal:'数据',output:'产出'},{name:'写作',taskType:'writer',goal:'简报'}],calls:[]};
 const first=missionProgress(make({mission}));assert.equal(first.target,2);assert.equal(first.done,2);
 mission.phases[1].output='简报';const second=missionProgress(make({mission}));assert.equal(second.target,3);assert.equal(second.nodes[3].state,'active');
});
test('pause and failure stop animation without marking review successful',()=>{
 const mission={stage:'reviewing' as const,phases:[{name:'写作',taskType:'writer',goal:'简报',output:'产出'}],calls:[],review:{passed:false,summary:'不通过',checks:[]}};
 for(const status of ['Paused','Failed'] as const){const p=missionProgress(make({mission,status}));assert.equal(p.running,false);assert.equal(p.nodes[2].state,'blocked');assert.equal(p.done,2);}
 const p=missionProgress(make({mission:{...mission,review:{...mission.review,passed:true}},status:'Succeeded'}));assert.equal(p.done,3);
});
test('non-goal provisioning is a single real step, not a fictional goal pipeline',()=>{
 const p=missionProgress(make({action:'provision',status:'Paused'}));assert.equal(p.nodes.length,1);assert.equal(p.done,0);assert.equal(p.running,false);
});
test('commands expand supplied text and never dispatch money operations',()=>{
 assert.match(expandGoalCommand('// 分析 一月收入100元'),/一月收入100元/);
 assert.match(expandGoalCommand('// review\nconst x = 1'),/const x = 1/);
 assert.equal(expandGoalCommand('普通目标'),'普通目标');
 assert.throws(()=>expandGoalCommand('// 写作'),/补充/);
 assert.throws(()=>expandGoalCommand('// deposit 10'),/未知快捷指令/);
});
