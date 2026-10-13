import test from "node:test";
import assert from "node:assert/strict";
import { savedGatewayCounters } from "../local-model-gateway.js";
test("gateway restart preserves paid-call counts including an interrupted dispatch", () => {
  const raw = [{attempt:1,phase:"DispatchIntent"},{attempt:1,phase:"Response",httpStatus:200},{attempt:2,phase:"DispatchIntent"}].map(x=>JSON.stringify(x)).join("\n");
  assert.deepEqual(savedGatewayCounters(raw), {nextId:2,accepted:2});
  assert.deepEqual(savedGatewayCounters(""), {nextId:0,accepted:0});
});
test("duplicate, missing, or truncated attempt journals cannot reset the paid-call baseline", () => {
  for (const raw of ['{"attempt":1,"phase":"DispatchIntent"}\n{"attempt":1,"phase":"DispatchIntent"}', '{"attempt":2,"phase":"DispatchIntent"}', '{"attempt":1,"phase":"Response"}', '{"attempt":'])
    assert.throws(()=>savedGatewayCounters(raw));
});
