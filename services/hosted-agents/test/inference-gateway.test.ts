import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InferenceGateway, createMagpieDispatch, type GatewayBinding, type GatewayModel, type GatewayRequest, type GatewayDispatch } from "../src/inference-gateway.js";
const binding: GatewayBinding = { agentId: "1", taskId: "1", wallet: `0x${"22".repeat(20)}` };
const catalog: GatewayModel[] = [
  { id: "cheap", model: "model-cheap", route: "https://magpie.example/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 512 },
  { id: "strong", model: "model-strong", route: "https://magpie.example/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "8", maxCompletionTokens: 512 },
];
const request = (model = "cheap"): GatewayRequest => ({ model, messages: [{ role: "user", content: "solve" }], max_completion_tokens: 100,
  tools: [{ type: "function", function: { name: "test_public_sample", parameters: { type: "object" } } }] });
function response(model: string, prompt = 10, completion = 20) {
  return { status: 200, body: { model, usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "test_public_sample", arguments: '{"code":"print(1)"}' } }] }, finish_reason: "tool_calls" }] } };
}
async function directory(t: any) { const dir = await mkdtemp(join(tmpdir(), "inference-gateway-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
test("two pinned models charge different actual usage, return tool calls, and replay once across restart", async t => {
  const dir = await directory(t); let calls = 0;
  const dispatch: GatewayDispatch = async (model, body) => { calls++; assert.equal(body.model, model.model); if (model.id === "strong") assert.equal(body.reasoning_effort, "low"); return response(model.model); };
  let gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  await gateway.grant("game-1", "10000", { kind: "game", rewardId: "game-1" });
  const a = await gateway.invoke("a", request()), b = await gateway.invoke("b", { ...request("strong"), reasoning_effort: "low" });
  assert.equal(a.chargedCredits, "50"); assert.equal(b.chargedCredits, "190");
  assert.equal((a.response as any).choices[0].message.tool_calls[0].function.name, "test_public_sample");
  assert.equal(gateway.balance().spentCredits, "240"); assert.equal(gateway.balance().reservedCredits, "0");
  assert.deepEqual(await gateway.invoke("a", request()), a); assert.equal(calls, 2);
  await assert.rejects(gateway.invoke("a", { ...request(), messages: [{ role: "user", content: "different" }] }), /GATEWAY_REQUEST_CONFLICT/);
  await gateway.close(); gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  assert.deepEqual(gateway.readResult("a", request()), a);
  assert.equal(gateway.readResult("never-dispatched", request()), undefined);
  assert.throws(() => gateway.readResult("a", request("strong")), /GATEWAY_REQUEST_CONFLICT/);
  assert.deepEqual(await gateway.invoke("a", request()), a); assert.equal(calls, 2);
  await gateway.close();
});
test("concurrent admission reserves before dispatch and cannot exceed available credits", async t => {
  const dir = await directory(t); let release!: () => void, calls = 0;
  const wait = new Promise<void>(r => { release = r; });
  const gateway = await InferenceGateway.open(dir, binding, catalog, async model => { calls++; await wait; return response(model.model); });
  const credits = gateway.quote(request()).reservedCredits;
  await gateway.grant("payment", credits, { kind: "chain-payment", paymentId: `0x${"33".repeat(32)}`, txHash: `0x${"44".repeat(32)}` });
  const first = gateway.invoke("first", request());
  await assert.rejects(gateway.invoke("second", request()), /INFERENCE_FUNDING_REQUIRED/);
  assert.equal(gateway.balance().reservedCredits, credits); assert.equal(calls, 1);
  await assert.rejects(gateway.invoke("first", request("strong")), /GATEWAY_REQUEST_CONFLICT/);
  const duplicate = gateway.invoke("first", request()); release();
  assert.deepEqual(await duplicate, await first); assert.equal(calls, 1); await gateway.close();
});
test("unknown dispatch stays reserved and frozen on restart; dispatch intent is never replayed", async t => {
  const dir = await directory(t); let calls = 0;
  const dispatch: GatewayDispatch = async () => { calls++; throw new Error("provider timeout secret"); };
  let gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  await gateway.grant("game", "10000", { kind: "game", rewardId: "game" });
  await assert.rejects(gateway.invoke("round", request()), /GATEWAY_OUTCOME_UNKNOWN/);
  const balance = gateway.balance(); assert.equal(balance.frozen, true); assert.notEqual(balance.reservedCredits, "0");
  await gateway.close(); gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  await assert.rejects(gateway.invoke("round", request()), /GATEWAY_OUTCOME_UNKNOWN/);
  await assert.rejects(gateway.invoke("new", request()), /GATEWAY_FROZEN/); assert.equal(calls, 1);
  await gateway.close();
  const path = join(dir, "session.json"), state = JSON.parse(await readFile(path, "utf8"));
  state.invocations[0].state = "DispatchIntent"; delete state.invocations[0].error; await writeFile(path, JSON.stringify(state));
  gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  assert.equal(gateway.status("round")[0].state, "Unknown"); assert.equal(calls, 1); await gateway.close();
  assert.ok(!(await readFile(path, "utf8")).includes("secret"));
});
test("recorded responses settle after restart, explicit rejection releases, invalid usage freezes", async t => {
  const dir = await directory(t); let calls = 0;
  let gateway = await InferenceGateway.open(dir, binding, catalog, async () => { calls++; return { status: 400, body: { error: "invalid" } }; });
  await gateway.grant("g", "10000", { kind: "game", rewardId: "g" });
  await assert.rejects(gateway.invoke("round", request()), /GATEWAY_REQUEST_REJECTED/);
  assert.equal(gateway.balance().reservedCredits, "0"); await gateway.close();
  const path = join(dir, "session.json"), state = JSON.parse(await readFile(path, "utf8"));
  state.invocations[0].state = "ResponseRecorded"; state.invocations[0].response = response("model-cheap"); await writeFile(path, JSON.stringify(state));
  gateway = await InferenceGateway.open(dir, binding, catalog, async model => { calls++; return response(model.model, 10, 101); });
  assert.equal((await gateway.invoke("round", request())).chargedCredits, "50"); assert.equal(calls, 1);
  await assert.rejects(gateway.invoke("overrun", request()), /GATEWAY_USAGE_OVERRUN/);
  assert.equal(gateway.balance().frozen, true); assert.equal(gateway.status("overrun")[0].state, "UsageOverrun"); await gateway.close();
});
test("binding, catalog, grants, and route are immutable; caller cannot inject endpoint or key", async t => {
  const dir = await directory(t); const gateway = await InferenceGateway.open(dir, binding, catalog, async model => response(model.model));
  await gateway.grant("g", "10000", { kind: "game", rewardId: "g" });
  await gateway.grant("g", "10000", { kind: "game", rewardId: "g" });
  assert.equal(gateway.balance().grantedCredits, "10000");
  await assert.rejects(gateway.grant("g", "10001", { kind: "game", rewardId: "g" }), /GATEWAY_GRANT_CONFLICT/);
  await assert.rejects(gateway.grant("g2", "10000", { kind: "game", rewardId: "g" }), /GATEWAY_GRANT_SOURCE_REUSED/);
  assert.throws(() => gateway.quote({ ...request(), baseUrl: "https://evil.example" }), /GATEWAY_INVALID_REQUEST/);
  await gateway.close();
  await assert.rejects(InferenceGateway.open(dir, { ...binding, agentId: "2" }, catalog, async model => response(model.model)), /GATEWAY_BINDING_OR_CATALOG_CHANGED/);
  await assert.rejects(InferenceGateway.open(dir, binding, [{ ...catalog[0], outputMicroCreditsPerToken: "9" }, catalog[1]], async model => response(model.model)), /GATEWAY_BINDING_OR_CATALOG_CHANGED/);
  await assert.rejects(InferenceGateway.open(dir, binding, catalog.slice(0, 1), async model => response(model.model)), /GATEWAY_TWO_MODELS_REQUIRED/);
});
test("Magpie adapter dispatches both fixed physical models through one endpoint without persisting credentials", async t => {
  const dir = await directory(t); const urls: string[] = [];
  const dispatch = createMagpieDispatch({ baseUrl: "https://magpie.example/v1", apiKey: "private-test-key", fetch: async (url, options) => {
    urls.push(String(url)); assert.equal((options!.headers as any).authorization, "Bearer private-test-key");
    const body = JSON.parse(options!.body as string); return new Response(JSON.stringify(response(body.model).body), { status: 200 });
  } });
  const gateway = await InferenceGateway.open(dir, binding, catalog, dispatch); await gateway.grant("g", "10000", { kind: "game", rewardId: "g" });
  await gateway.invoke("cheap", request()); await gateway.invoke("strong", request("strong"));
  assert.deepEqual(urls, [catalog[0].route, catalog[1].route]); await gateway.close();
  assert.ok(!(await readFile(join(dir, "session.json"), "utf8")).includes("private-test-key"));
});

test("provider/model aliases require the configured physical response model", async t => {
  const dir = await directory(t), models = [{ ...catalog[0], model: "moonshot/model-cheap", responseModel: "model-cheap" }, catalog[1]];
  const gateway = await InferenceGateway.open(dir, binding, models, async (model, input) => {
    assert.equal(input.model, "moonshot/model-cheap"); return response(model.responseModel!);
  });
  await gateway.grant("g", "10000", { kind: "game", rewardId: "g" });
  assert.equal((await gateway.invoke("alias", request())).chargedCredits, "50"); await gateway.close();
});

test("unknown paid allowance is permanently sealed, retaining evidence across restart and rejecting stale/conflicting compensation", async t => {
  const { randomUUID } = await import("node:crypto");
  const { unsealedLedgerDigest, validGatewayClosure } = await import("../src/inference-closure.js");
  const dir = await directory(t), paymentId = `0x${"a1".repeat(32)}`, txHash = `0x${"b2".repeat(32)}`; let calls = 0;
  const dispatch: GatewayDispatch = async () => { calls++; return { status: 503, body: { error: "unknown supplier outcome" } }; };
  let gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  await gateway.grant(paymentId, "10000", { kind: "chain-payment", paymentId, txHash });
  await assert.rejects(gateway.invoke("round:0", request()), /GATEWAY_UNVERIFIABLE_USAGE/);
  const original = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
  const input = { paymentId, resolutionId: randomUUID(), evidenceDigest: `0x${"c3".repeat(32)}`, expectedLedgerDigest: unsealedLedgerDigest(original) };
  await assert.rejects(gateway.sealUnknown({ ...input, expectedLedgerDigest: "00".repeat(32) }), /GATEWAY_LEDGER_CHANGED/);
  const closure = await gateway.sealUnknown(input);
  assert.deepEqual(await gateway.sealUnknown(input), closure);
  await assert.rejects(gateway.sealUnknown({ ...input, resolutionId: randomUUID() }), /GATEWAY_CLOSURE_CONFLICT/);
  assert.equal(gateway.balance().availableCredits, "0"); assert.equal(gateway.balance().frozen, true);
  assert.equal(gateway.status()[0].state, "Unknown");
  await gateway.close();
  const sealed = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
  assert.ok(validGatewayClosure(sealed, closure)); assert.deepEqual(sealed.invocations, original.invocations);
  gateway = await InferenceGateway.open(dir, binding, catalog, dispatch);
  assert.throws(() => gateway.invoke("round:0", request()), /GATEWAY_PERMANENTLY_SEALED/);
  assert.throws(() => gateway.readResult("round:0", request()), /GATEWAY_PERMANENTLY_SEALED/);
  await assert.rejects(gateway.grant(paymentId, "10000", { kind: "chain-payment", paymentId, txHash }), /GATEWAY_PERMANENTLY_SEALED/);
  assert.equal(calls, 1); await gateway.close();
  sealed.invocations[0].response.status = 200; await writeFile(join(dir, "session.json"), JSON.stringify(sealed));
  await assert.rejects(InferenceGateway.open(dir, binding, catalog, dispatch), /GATEWAY_CLOSURE_INVALID/);
});

test("successful or still dispatching inference cannot be sealed as unknown", async t => {
  const { randomUUID } = await import("node:crypto");
  const { unsealedLedgerDigest } = await import("../src/inference-closure.js");
  const dir = await directory(t), paymentId = `0x${"a1".repeat(32)}`; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const gateway = await InferenceGateway.open(dir, binding, catalog, async model => { await held; return response(model.model); });
  await gateway.grant(paymentId, "10000", { kind: "chain-payment", paymentId, txHash: `0x${"b2".repeat(32)}` });
  const pending = gateway.invoke("round:0", request());
  const input = { paymentId, resolutionId: randomUUID(), evidenceDigest: `0x${"c3".repeat(32)}`, expectedLedgerDigest: "00".repeat(32) };
  await assert.rejects(gateway.sealUnknown(input), /GATEWAY_DISPATCH_IN_PROGRESS/);
  release(); await pending;
  input.expectedLedgerDigest = unsealedLedgerDigest(JSON.parse(await readFile(join(dir, "session.json"), "utf8")));
  await assert.rejects(gateway.sealUnknown(input), /GATEWAY_NOT_SEALABLE/);
  await gateway.close();
});
