import test from "node:test";
import assert from "node:assert/strict";
import { createTaskMagpieDispatch, meteredPurchaseTimeout } from "../src/metered-task.js";
import type { GatewayModel, GatewayRequest } from "../src/inference-gateway.js";

const model: GatewayModel = { id: "strong", model: "strong/kimi-k3", responseModel: "kimi-k3", route: "http://127.0.0.1:3426/v1/chat/completions",
  inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 };
const request: GatewayRequest = { model: model.model, messages: [{ role: "user", content: "controlled" }], max_completion_tokens: 128 };

test("trusted model timeout supports 120 seconds and shrinks against the deadline on every dispatch", async t => {
  let now = 100000, requests = 0; const timeouts: number[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    requests++; assert.ok(options.signal); return new Response(JSON.stringify({ model: "kimi-k3", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  });
  const dispatch = createTaskMagpieDispatch({ baseUrl: "http://127.0.0.1:3426/v1", apiKey: "local-test", deadlineMs: 300000, timeoutMs: 120000 });
  await dispatch(model, request); now = 250000; await dispatch(model, request);
  assert.deepEqual(timeouts, [120000, 50000]); now = 300000;
  await assert.rejects(dispatch(model, request), /Task expired before model dispatch/); assert.equal(requests, 2);
});

test("default model timeout remains 30 seconds and invalid limits fail before requests", async t => {
  const timeouts: number[] = [];
  t.mock.method(Date, "now", () => 100000);
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  t.mock.method(globalThis, "fetch", async () => new Response('{"model":"kimi-k3"}', { status: 200 }));
  await createTaskMagpieDispatch({ baseUrl: "http://127.0.0.1:3426/v1", apiKey: "local-test", deadlineMs: 999999 })(model, request);
  assert.deepEqual(timeouts, [30000]);
  for (const timeoutMs of [0, -1, 1.5, Infinity]) assert.throws(() => createTaskMagpieDispatch({ baseUrl: "http://127.0.0.1:3426/v1", apiKey: "local-test", deadlineMs: 999999, timeoutMs }), /INVALID_METERED_TIMEOUT/);
});


test("allowance SDK timeout honors 120-second runtime limit and original deadline without changing the 10-second default", t => {
  let now = 100000; t.mock.method(Date, "now", () => now);
  assert.equal(meteredPurchaseTimeout(300000, 120000), 120000);
  now = 250000; assert.equal(meteredPurchaseTimeout(300000, 120000), 50000);
  assert.equal(meteredPurchaseTimeout(300000), 10000);
  now = 299999; assert.equal(meteredPurchaseTimeout(300000, 120000), 1);
  now = 300000; assert.throws(() => meteredPurchaseTimeout(300000, 120000), /Task expired before allowance request/);
  for (const invalid of [0, -1, 1.5, Infinity]) assert.throws(() => meteredPurchaseTimeout(400000, invalid), /INVALID_METERED_TIMEOUT/);
});
