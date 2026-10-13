import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { key } from "../../underwriter/test/fixture.js";
import { createHostedGameExecutor } from "../src/game-executor.js";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor, type HostedTaskDependencies } from "../src/task-executor.js";
import { modelCatalogDigest } from "../src/metered-task.js";
import { InferenceAllowanceRelay, ALLOWANCE_SERVICE, ALLOWANCE_MODEL } from "../../provider-relay/src/allowance.js";
import { RelayError } from "../../provider-relay/src/relay.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import { InferenceFundingRequired } from "../../../packages/pi-loop/src/provider.js";
import type { GatewayModel } from "../src/inference-gateway.js";

async function fixture(t: any, rewardFirst = false, maxCompletionTokens = 256) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-metered-recovery-")));
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const keyFile = join(directory, "model.key"); await writeFile(keyFile, "controlled", { mode: 0o600 });
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/kimi-k2.6", responseModel: "kimi-k2.6", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens },
    { id: "strong", model: "strong/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens },
  ];
  const relay = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  const server = createHttpServer(relay, new Refunder(relay)); await relay.initialize(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = structuredClone(f.config); config.metered = { relayUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/chat`, payTo: f.fx.f.payee,
    priceRaw: "120000", creditsRaw: "100000", catalog, keyFile };
  for (const model of config.models) for (const template of Object.values(model.templates)) { template.maxCompletionTokens = maxCompletionTokens; for (const provider of template.providers) for (const route of provider.routes) route.solve.maxCompletionTokens = maxCompletionTokens; }
  if (rewardFirst) config.models[0].id = "kimi-k2.6";
  t.after(async () => {
    await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); relay.close(); await f.close(); await rm(directory, { recursive: true, force: true });
  });
  const actor = await f.actor(5, rewardFirst ? "kimi-k2.6" : "cheap");
  const provision = async (dependencies: HostedTaskDependencies) => {
    const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, ...dependencies });
    const ready = await tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready));
    actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const input = actor.input("task"); input.run.action = "metered-task";
    return { tasks, input };
  };
  const state = async (directory: string) => JSON.parse(await readFile(join(directory, "task-executor/workflow/session.json"), "utf8"));
  return { directory, f, relay, config, actor, provision, state };
}

test("reward funds first round; credit funds repair of the same accepted task and independent settlement repays it", { timeout: 180000 }, async t => {
  const fx = await fixture(t, true); let rewardCalls = 0, paidCalls = 0, availableRewardRounds = 1;
  let originalAccept: string | undefined;
  const { tasks, input } = await fx.provision({
    reward: async () => ({ solver: {
      routes: { cheap: { name: "reward", model: "kimi-k2.6", baseUrl: "https://controlled.invalid/v1" }, strong: { name: "reward", model: "kimi-k2.6", baseUrl: "https://controlled.invalid/v1" } },
      beforeDispatch: async (body, round) => { assert.equal(body.model, "kimi-k2.6"); assert.equal(round, 0); if (!availableRewardRounds) throw new InferenceFundingRequired(); },
      invoke: async (_tier, body) => {
        rewardCalls++; availableRewardRounds--; assert.equal(body.model, "kimi-k2.6");
        const state = await fx.state(input.directory); originalAccept = state.accept.txHash;
        assert.equal((await fx.f.fx.f.manager.getFunction("getLoan").staticCall(state.decision.selected.taskId)).status, 0n);
        return modelToolResponse("print(0)", "kimi-k2.6");
      },
    }, creditsUsed: async () => rewardCalls * 30, close: async () => {} }),
    gatewayDispatch: async (model, body) => {
      paidCalls++; assert.equal(availableRewardRounds, 0); assert.equal(body.model, "strong/controlled");
      const state = await fx.state(input.directory); assert.equal(state.accept.txHash, originalAccept);
      const loan = await fx.f.fx.f.manager.getFunction("getLoan").staticCall(state.decision.selected.taskId); assert.equal(loan.status, 1n); assert.equal(loan.principal, 80000n);
      assert.ok((body.messages as any[]).some(m => m.role === "tool" && m.content.includes('"passed":false')));
      return { status: 200, body: modelToolResponse(fx.f.GOOD_CODE["sum-integers"], model.model) };
    },
  });
  const result = await tasks.execute(input); assert.equal(result.phase, "Succeeded", JSON.stringify(result));
  assert.equal(result.creditsUsed, 60); assert.equal(result.fromCreditRaw, "80000"); assert.equal(result.settlement?.repaidRaw, "92000");
  assert.equal(result.settlement?.loanStatus, "2"); assert.equal(result.acceptTxHash, originalAccept); assert.equal(rewardCalls, 1); assert.equal(paidCalls, 1);
  const state = await fx.state(input.directory), ledger = JSON.parse(await readFile(join(input.directory, "task-executor/workflow/metered/inference-ledger/session.json"), "utf8"));
  assert.deepEqual(ledger.invocations.map((r: any) => r.id), ["round:1"]); assert.equal(state.rewardChild.solve.rounds.length, 2);
  const nonce = await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address);
  assert.deepEqual(await tasks.execute({ ...input, recover: true }), result);
  assert.equal(await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address), nonce); assert.equal(rewardCalls, 1); assert.equal(paidCalls, 1);
});

test("lost allowance delivery pauses, then resumes the original payment and task without duplicate inference", { timeout: 180000 }, async t => {
  const fx = await fixture(t); let loseResponse = true, paidCalls = 0;
  const chat = fx.relay.chat.bind(fx.relay);
  fx.relay.chat = async (...args) => { const result = await chat(...args); if (loseResponse) { loseResponse = false; throw new RelayError("CONTROLLED_RESPONSE_LOST", "response lost after durable allowance", 503); } return result; };
  const { tasks, input } = await fx.provision({ gatewayDispatch: async model => { paidCalls++; return { status: 200, body: modelToolResponse(fx.f.GOOD_CODE["sum-integers"], model.responseModel ?? model.model) }; } });
  const first = await tasks.execute(input); assert.equal(first.phase, "Paused", JSON.stringify(first)); assert.equal(first.terminal, false); assert.equal(paidCalls, 0);
  const pending = await fx.state(input.directory), paymentId = pending.handle.quote.paymentId, acceptTxHash = pending.accept.txHash;
  const nonce = await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address);
  assert.equal((await fx.f.fx.f.account.getFunction("getPayment").staticCall(paymentId)).fromCredit, 80000n);
  const result = await tasks.execute({ ...input, recover: true }); assert.equal(result.phase, "Succeeded", JSON.stringify(result));
  assert.equal(result.paymentId, paymentId); assert.equal(result.acceptTxHash, acceptTxHash); assert.equal(paidCalls, 1);
  assert.equal(await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address), nonce, "accept and payment are never repeated; independent settler signs settlement");
  assert.equal(result.settlement?.repaidRaw, "92000");
  const after = await fx.state(input.directory); assert.equal(after.rewardChild.solve.rounds.length, 1);
  assert.deepEqual(await tasks.execute({ ...input, recover: true }), result); assert.equal(paidCalls, 1);
});

test("failed paid candidates are independently rejected and clear active debt before terminal release", { timeout: 180000 }, async t => {
  const fx = await fixture(t); let calls = 0;
  const { tasks, input } = await fx.provision({ gatewayDispatch: async model => { calls++; return { status: 200, body: modelToolResponse("print(0)", model.responseModel ?? model.model) }; } });
  const result = await tasks.execute(input); assert.equal(result.phase, "Failed", JSON.stringify(result)); assert.equal(result.terminal, true);
  assert.equal(result.chargedRaw, "120000"); assert.equal(result.settlement?.passed, false); assert.equal(calls, 2);
  const state = await fx.state(input.directory); assert.equal(state.reservedPrice, "120000");
  const loan = await fx.f.fx.f.manager.getFunction("getLoan").staticCall(result.taskId);
  assert.notEqual(loan.status, 1n); assert.equal(loan.principal + loan.fee, 0n);
  const nonce = await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address);
  const retry = await tasks.execute({ ...input, recover: true }); assert.equal(retry.phase, "Failed"); assert.equal(retry.terminal, true);
  assert.equal(calls, 2); assert.equal(await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address), nonce);
});


test("unknown paid model dispatch retains its budget and task; recovery never duplicates inference", { timeout: 180000 }, async t => {
  const fx = await fixture(t); let calls = 0;
  const { tasks, input } = await fx.provision({ gatewayDispatch: async () => { calls++; throw new Error("upstream outcome unknown"); } });
  const result = await tasks.execute(input); assert.equal(result.phase, "Paused", JSON.stringify(result)); assert.equal(result.terminal, false);
  assert.equal(result.chargedRaw, "120000"); assert.equal(result.settlement, undefined); assert.equal(calls, 1);
  const state = await fx.state(input.directory); assert.equal(state.reservedPrice, "120000");
  assert.equal((await fx.f.fx.f.manager.getFunction("getLoan").staticCall(result.taskId)).status, 1n);
  const nonce = await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address);
  const retry = await tasks.execute({ ...input, recover: true }); assert.equal(retry.phase, "Paused"); assert.equal(retry.terminal, false);
  assert.equal(calls, 1); assert.equal(await fx.f.fx.f.provider.getTransactionCount(fx.actor.wallet.address), nonce);
});


test("a 1024-token metered task with the real empty game-reward adapter bypasses its 512-token policy and borrows normally", { timeout: 180000 }, async t => {
  const fx = await fixture(t, true, 1024); let rewardAdmissions = 0, rewardCalls = 0, paidCalls = 0;
  const file = async (name: string, value: string) => { const path = join(fx.directory, name); await writeFile(path, value, { mode: 0o600 }); return path; };
  const games = createHostedGameExecutor({ version: 1, chainId: "31337", identity: fx.config.identity, account: fx.f.fx.config.account, token: fx.f.fx.config.asset,
    publicRpcUrl: fx.f.fx.local.rpc, rpcTransport: "direct", sponsorKeyFile: await file("sponsor.key", key(4)),
    opponent: { binding: { chainId: "31337", agentId: "1", wallet: new Wallet(key(2)).address }, keyFile: await file("bot.key", key(2)), modelId: "kimi-k2.6", strategy: "balanced" },
    models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: await file("reward-model.key", "controlled-test") }],
    creditsDirectory: join(fx.directory, "credits"), walletDirectory: fx.config.walletDirectory }, { provider: fx.f.fx.f.provider,
      upstreamFetch: async () => { rewardCalls++; throw new Error("empty rewards must never dispatch"); } });
  try {
    const { tasks, input } = await fx.provision({
      reward: async input => {
        const reward = await games.rewardTask(input), admission = reward.solver.beforeDispatch!;
        reward.solver.beforeDispatch = async (body, index) => { rewardAdmissions++; await admission(body, index); };
        return reward;
      },
      gatewayDispatch: async (model, body) => { paidCalls++; assert.equal(body.max_completion_tokens, 1024);
        return { status: 200, body: modelToolResponse(fx.f.GOOD_CODE["sum-integers"], model.responseModel ?? model.model) }; },
    });
    const result = await tasks.execute(input); assert.equal(result.phase, "Succeeded", JSON.stringify(result));
    assert.equal(rewardAdmissions, 0); assert.equal(rewardCalls, 0); assert.equal(paidCalls, 1); assert.equal(result.fromCreditRaw, "80000");
    assert.equal(result.settlement?.repaidRaw, "92000"); assert.equal(result.creditsUsed, 30);
    const rewardLedger = JSON.parse(await readFile(join(fx.directory, "credits", fx.actor.agent.id, "session.json"), "utf8"));
    assert.equal(rewardLedger.grants.length, 0); assert.equal(rewardLedger.redemptions.length, 0);
  } finally { games.close(); }
});
