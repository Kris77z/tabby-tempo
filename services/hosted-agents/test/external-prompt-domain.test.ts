import test from "node:test";
import assert from "node:assert/strict";
import { prepareExternalHire, externalResultBinding } from "../src/external/hiring.js";
import type { GoalState } from "../src/goals/executor.js";
import type { ExternalServiceSnapshot } from "../src/external/registry.js";
test("host and external provider bind the same Tempo prompt; another configured chain rejects it",()=>{
 const identity={chainId:"42431",registry:"0x"+"1".repeat(40),agentId:"99",wallet:"0x"+"2".repeat(40)};
 const trust={id:"gas-cheap",name:"Gas Specialist",taskType:"gas-optimization",endpoint:"http://127.0.0.1:1/v1/chat",serviceId:"tabby/external/gas-optimization",modelId:"cheap",physicalModel:"physical",priceRaw:"10000",provider:identity.wallet,identity};
 const service={trust,service:{...trust,reputation:{score:null,samples:0,source:"registry"}}} as unknown as ExternalServiceSnapshot;
 const mission={binding:"synthetic",input:{chainId:"42431",goal:"Use supplied A and B"}} as GoalState;
 const {call,hire}=prepareExternalHire(mission,service,{stage:"phase-0",taskType:"gas-optimization",originalGoal:mission.input.goal,assignment:{name:"Write",taskType:"gas-optimization",goal:"Use A and B"}});
 assert.match(call.messages[0].content,/hosted identity chain is 42431 \(Tempo Moderato, settlement and fee asset PathUSD\)/);
 assert.equal(externalResultBinding(trust,call.messages,"42431").promptDigest,hire.promptDigest);
 assert.throws(()=>externalResultBinding(trust,call.messages,"10143"),/HOSTED_EXTERNAL_PROMPT_CHANGED/);
});
