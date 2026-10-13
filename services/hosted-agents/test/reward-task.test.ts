import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { createHostedGameExecutor } from "../src/game-executor.js";
import { key, read } from "../../underwriter/test/fixture.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import type { HostedExecution } from "../src/types.js";

test("free game tokens fund a real Pi task, independent Docker settlement and the next task without a paid relay or loan", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-reward-task-")));
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const file = async (name: string, value: string) => { const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); return path; };
  const config = structuredClone(f.config); config.initialCashRaw = "0"; config.models = [{ ...config.models[0], id: "kimi-k2.6" }];
  let modelCalls = 0; const bodies: any[] = [];
  const games = createHostedGameExecutor({ version: 1, chainId: "31337", identity: config.identity, account: f.fx.config.account, token: f.fx.config.asset,
    publicRpcUrl: f.fx.local.rpc, rpcTransport: "direct", sponsorKeyFile: await file("sponsor.key", key(4)),
    opponent: { binding: { chainId: "31337", agentId: "1", wallet: new Wallet(key(2)).address }, keyFile: await file("bot.key", key(2)), modelId: "kimi-k2.6", strategy: "balanced" },
    models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: await file("model.key", "controlled-test") }],
    creditsDirectory: join(directory, "credits"), walletDirectory: config.walletDirectory }, { provider: f.fx.f.provider, upstreamFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (body.tools) { modelCalls++; const code = modelCalls === 1 ? f.GOOD_CODE["sum-integers"] : f.GOOD_CODE["unique-sorted"];
        return Response.json(modelToolResponse(code, body.model)); }
      const view = JSON.parse(body.messages[1].content);
      return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(view.seat === 0 ? { type: "all-in" } : { type: "fold" }) } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } });
    } });
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, reward: input => games.rewardTask(input) });
  try {
    const actor = await f.actor(5, "kimi-k2.6", 0n), provision = actor.input("provision");
    const ready = await tasks.execute(provision); assert.equal(ready.success, true); actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const input = (action: "game" | "reward-task"): HostedExecution => {
      const requestId = randomUUID(); return { ...actor.input("task"), agent: structuredClone(actor.agent), directory: join(directory, "requests", requestId),
        run: { ...actor.input("task").run, requestId, action, reservedRaw: "0", ...(action === "game" ? { rewardKind: "llm-credits" as const } : {}) } };
    };
    const first = input("reward-task"), waiting = await tasks.execute(first);
    assert.equal(waiting.phase, "Paused", JSON.stringify(waiting)); assert.equal(waiting.reason, "INFERENCE_FUNDING_REQUIRED");
    assert.equal(modelCalls, 0); assert.equal(waiting.creditsUsed, 0);
    const acceptedNonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    const game = input("game"); game.run.fundingFor = first.run.requestId;
    const won = await games.execute(game); assert.equal(won.success, true); assert.equal(won.creditsGranted, 4096);
    const result = await tasks.execute({ ...first, recover: true });
    assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), acceptedNonce);
    assert.equal(result.phase, "Succeeded", JSON.stringify(result)); assert.equal(result.creditsUsed, 30);
    assert.equal(result.chargedRaw, "0"); assert.equal(result.paymentId, undefined); assert.equal(result.settlement?.passed, true);
    assert.equal(result.settlement?.loanStatus, "0"); assert.equal(result.settlement?.residualRaw, "150000");
    assert.equal(await read(f.fx.f.account, "cash", [ready.binding!.agentId]), 150000n);
    const nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await tasks.execute({ ...first, recover: true }), result); assert.equal(modelCalls, 1);
    assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    const second = await tasks.execute(input("reward-task")); assert.equal(second.phase, "Succeeded", JSON.stringify(second));
    assert.equal(second.creditsUsed, 30); assert.equal(modelCalls, 2); assert.equal(f.fx.calls.length, 0);
    assert.equal(await read(f.fx.f.account, "cash", [ready.binding!.agentId]), 300000n);
    assert.ok(bodies.filter(b => b.tools).every(b => b.model === "kimi-k2.6"));
    const gameCalls = bodies.length;
    assert.deepEqual(await games.execute({ ...game, recover: true }), won); assert.equal(bodies.length, gameCalls);
    const slot = JSON.parse(await readFile(join(config.walletDirectory, actor.wallet.address.toLowerCase(), "session.json"), "utf8"));
    assert.equal(slot.phase, "Succeeded");
    const finance = await tasks.finance(actor.agent); assert.equal(finance.status, "confirmed"); if (finance.status === "confirmed") assert.equal(finance.counts.successes, "2");
  } finally { games.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
