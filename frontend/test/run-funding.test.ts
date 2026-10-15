import test from "node:test";
import assert from "node:assert/strict";
import { pausedRunFunding } from "../lib/run-funding";
import type { HostedRun, HostedCapabilities } from "../lib/hosted-client";
const paused={status:"Paused",reason:"INFERENCE_FUNDING_REQUIRED",action:"autonomous"} as HostedRun;
test("legacy paused autonomous journal retains cash top-up without new funding fields or games",()=>{
  assert.equal(pausedRunFunding(paused),"cash");
  assert.equal(pausedRunFunding(paused,{autonomy:{maxTasks:3,durationMs:30000,plannerPriceRaw:"10"}}),"cash");
});
test("reward children and unresolved games-enabled autonomy never receive a cash fallback",()=>{
  assert.equal(pausedRunFunding({...paused,fundingNeed:"reward-tokens"}),"reward-tokens");
  assert.equal(pausedRunFunding({...paused,action:"reward-task"}),"reward-tokens");
  const capabilities={autonomy:{games:{maxGames:3,rewardKinds:["llm-credits"]}}} as HostedCapabilities;
  assert.equal(pausedRunFunding(paused,capabilities),undefined);
  assert.equal(pausedRunFunding({...paused,fundingNeed:"cash"},capabilities),"cash");
  assert.equal(pausedRunFunding({...paused,status:"Running"}),undefined);
});
