import assert from "node:assert/strict";
import {validateHostedActivity,type HostedActivityInput} from "../src/scene-types.js";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceManager, Transaction, Wallet } from "ethers";
import { createHoldemFixture } from "../../../scripts/holdem-fixture.js";
import { key, tx, read } from "../../underwriter/test/fixture.js";
import { InferenceRewardLedger } from "../../arena/src/inference-rewards/index.js";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { replayHand, type PlayerView } from "../../arena/src/holdem/engine.js";
import { createHostedGameExecutor, loadHostedGameExecutorConfig, validateHostedGameExecutorConfig, type HostedGameExecutorConfig } from "../src/game-executor.js";
import type { HostedAgent, HostedExecution } from "../src/types.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-hosted-game-"))), local = await createHoldemFixture(join(directory, "chain"));
  const calls: any[] = []; let failNext = false, wrongModel = false, loseNext = false, authorizationDeadline: number | undefined;
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    if (failNext) { failNext = false; req.socket.destroy(); return; }
    let content = "Controlled reward inference completed.";
    if (body.messages.length === 2) {
      const view = JSON.parse(body.messages[1].content) as PlayerView;
      // Controlled actions for this fixture only. Production dispatch uses the model's legal choice.
      const raise = view.legalActions.find(action => action.type === "raise");
      content = JSON.stringify(view.seat === 0 && loseNext ? {type:"fold"} : view.seat === 0 ? body.messages[0].content.includes("Strategy preset: conservative") && raise?.type === "raise"
        ? { type: "raise", to: raise.minTo } : { type: "all-in" } : { type: "fold" });
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: wrongModel ? "wrong-model" : body.model,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }));
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening"); const url = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1/chat/completions`;
  const file = async (name: string, value: string) => { const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); return path; };
  const actorKeys = [await file("actor-0.key", key(11)), await file("actor-1.key", key(12))];
  const agents: HostedAgent[] = [];
  for (const n of [0, 1]) {
    const wallet = new Wallet(key(n + 11), local.f.provider);
    await local.f.provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    await tx(local.f.identity, local.f.admin, "registerFor", [wallet.address, wallet.address]);
    const agentId = String(n + 3); await tx(local.f.manager, local.f.admin, "enrollAgent", [agentId]);
    await tx(local.f.account, new NonceManager(wallet), "setPolicy", [agentId, { maxCashPerTx: 1000000n, maxDebtPerTx: 0n, maxDebtPerDay: 0n, ownerFrozen: false }]);
    const at = new Date().toISOString(); agents.push({ id: randomUUID(), owner: new Wallet(key(n + 21)).address, wallet: wallet.address, name: `Hosted ${n}`,
      modelId: n === 0 ? "kimi-k2.6" : "kimi-k2.5", strategy: n === 0 ? "aggressive" : "conservative", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true,
      createdAt: at, updatedAt: at, status: "Ready", spentRaw: "0", reservedRaw: "0", binding: { chainId: "31337", agentId, wallet: wallet.address } });
  }
  const config: HostedGameExecutorConfig = { version: 1, chainId: "31337", identity: await local.f.identity.getAddress(), account: await local.f.account.getAddress(), token: await local.f.token!.getAddress(),
    publicRpcUrl: local.local.rpc, rpcTransport: "direct", sponsorKeyFile: await file("sponsor.key", key(1)),
    opponent: { binding: { chainId: "31337", agentId: "2", wallet: local.signers[1].address }, keyFile: await file("bot.key", key(5)), modelId: "kimi-k2.6", strategy: "balanced" },
    models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: await file("model.key", "controlled-private-key") },
      { id: "kimi-k2.5", baseUrl: "https://api.moonshot.cn/v1", keyFile: join(directory, "model.key") }], creditsDirectory: join(directory, "credits"), walletDirectory: join(directory, "wallets") };
  const executor = createHostedGameExecutor(config, { provider: local.f.provider, upstreamFetch: async (_input, init) => fetch(url, init), gameDeadline: () => authorizationDeadline });
  const input = async (index: number, action: "game" | "credits", rewardKind?: "usdc" | "llm-credits"): Promise<HostedExecution> => {
    const agent = agents[index], requestId = randomUUID(), at = new Date().toISOString(), runDirectory = join(directory, agent.id, requestId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    return { agent: structuredClone(agent), run: { agentId: agent.id, requestId, action, ...(rewardKind ? { rewardKind } : {}), status: "Running", createdAt: at, updatedAt: at, reservedRaw: "0", chargedRaw: "0", recoverable: false }, directory: runDirectory, keyFile: actorKeys[index], recover: false };
  };
  const balance = async (index: number) => {
    const ledger = await InferenceRewardLedger.open(join(config.creditsDirectory, agents[index].id), { accounts: [agents[index].binding!, config.opponent.binding] });
    try { return await ledger.balance(agents[index].binding!); } finally { await ledger.close(); }
  };
  const close = async () => { executor.close(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); await local.close(); await rm(directory, { recursive: true, force: true }); };
  return { directory, local, agents, config, executor, input, balance, calls, lose:()=>{loseNext=true;}, fail: () => { failNext = true; }, wrong: () => { wrongModel = true; }, deadline: (value: number) => { authorizationDeadline = value; }, close, file };
}

test("hosted actor receives canonical sponsored USDC cash, selected model/strategy execute, original recovery has no new request or nonce", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.input(1, "game", "usdc"), other = f.agents[0],activities:HostedActivityInput[]=[];input.activity=async e=>{activities.push(validateHostedActivity(e));};
    const outstanding = await read(f.local.f.manager, "totalOutstanding"), sponsorBefore = await read(f.local.f.token!, "balanceOf", [f.local.sponsor.address]);
    const result = await f.executor.execute(input);
    assert.equal(result.success, true); assert.equal(result.terminal, true); assert.equal(result.rewardRaw, "100000");assert.ok(activities.some(e=>e.scene==="game"&&e.evidence?.outcome==="won"));assert.ok(activities.some(e=>e.scene==="settlement"&&e.state==="confirmed"&&e.evidence?.rewardRaw==="100000"&&e.evidence?.txHash===result.txHash)); assert.equal(result.cashRaw, "100000");
    assert.equal(result.chargedRaw, "0"); assert.equal(result.principalRaw, "0"); assert.equal(result.feeRaw, "0");
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].model, "kimi-k2.5"); assert.match(f.calls[0].messages[0].content, /Strategy preset: conservative/);
    assert.equal(f.calls[1].model, "kimi-k2.6"); assert.match(f.calls[1].messages[0].content, /Strategy preset: balanced/);
    assert.equal(await read(f.local.f.account, "cash", [other.binding!.agentId]), 0n);
    assert.equal(sponsorBefore - await read(f.local.f.token!, "balanceOf", [f.local.sponsor.address]), 100000n);
    assert.equal(await read(f.local.f.manager, "totalOutstanding"), outstanding);
    const entries = JSON.parse(await readFile(join(input.directory, "reward-transactions.json"), "utf8")); assert.equal(Object.keys(entries).length, 3);
    for (const entry of Object.values(entries) as any[]) {
      const original = Transaction.from(entry.rawTransaction), receipt = await f.local.f.provider.getTransactionReceipt(entry.txHash);
      assert.equal(original.hash, entry.txHash); assert.equal(receipt!.status, 1); assert.equal((await f.local.f.provider.getBlock(receipt!.blockNumber))!.hash, receipt!.blockHash);
    }
    const nonces = await Promise.all([input.agent.wallet, f.local.sponsor.address].map(w => f.local.f.provider.getTransactionCount(w)));
    assert.deepEqual(await f.executor.execute({ ...input, recover: true }), result);
    assert.deepEqual(await Promise.all([input.agent.wallet, f.local.sponsor.address].map(w => f.local.f.provider.getTransactionCount(w))), nonces); assert.equal(f.calls.length, 2);
    const saved = JSON.parse(await readFile(join(input.directory, "game/session.json"), "utf8")); assert.deepEqual(replayHand(saved.replay).view(0).result!.winners, [0]);
    assert.equal(saved.replay.actions[0].action.type, "raise");
    for (const hidden of ["rawTransaction", "messages", "deck", "controlled-private-key", input.keyFile, "api.moonshot"]) assert.equal(JSON.stringify(result).includes(hidden), false);
    await assert.rejects(f.executor.execute({ ...input, recover: true, agent: { ...input.agent, strategy: "aggressive" } }), /HOSTED_GAME_RUN_BINDING_CHANGED/);
    assert.deepEqual(await f.executor.execute({ ...input, recover: true }), result); assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test("two owners have separate credit awards and redemptions; same ID is cached, empty other account does not invoke model", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const empty = await f.input(1, "credits"); const declined = await f.executor.execute(empty);
    assert.equal(declined.terminal, true); assert.equal(declined.reason, "REWARD_INSUFFICIENT_AVAILABLE_TOKENS"); assert.equal(f.calls.length, 0);
    const first = await f.input(0, "game", "llm-credits"), grant0 = await f.executor.execute(first); assert.equal(grant0.creditsGranted, 4096);
    assert.match(f.calls[0].messages[0].content, /Strategy preset: aggressive/);
    const hand = JSON.parse(await readFile(join(first.directory, "game/session.json"), "utf8")); assert.equal(hand.replay.actions[0].action.type, "all-in");
    assert.equal((await f.balance(0)).availableTokens, 4096); assert.equal((await f.balance(1)).availableTokens, 0);
    const second = await f.input(1, "game", "llm-credits"), grant1 = await f.executor.execute(second); assert.equal(grant1.creditsGranted, 4096);
    const redemption = await f.input(0, "credits"), consumed = await f.executor.execute(redemption); assert.equal(consumed.success, true); assert.equal(consumed.creditsUsed, 18);
    assert.equal(f.calls.length, 5); assert.equal((await f.balance(0)).availableTokens, 4078); assert.equal((await f.balance(1)).availableTokens, 4096);
    assert.deepEqual(await f.executor.execute({ ...redemption, recover: true }), consumed); assert.deepEqual(await f.executor.execute({ ...first, recover: true }), grant0); assert.equal(f.calls.length, 5);
    const swap = { ...redemption, agent: f.agents[1], keyFile: (await f.input(1, "credits")).keyFile };
    await assert.rejects(f.executor.execute(swap), /HOSTED_GAME_INPUT_INVALID/); assert.equal(f.calls.length, 5);
    assert.equal(await read(f.local.f.account, "cash", [f.agents[0].binding!.agentId]), 0n);
    assert.equal(await read(f.local.f.account, "cash", [f.agents[1].binding!.agentId]), 0n);
  } finally { await f.close(); }
});

test("unknown decisions retain original wallet slot and never redispatch or grant a winner; wrong returned model cannot award", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.input(0, "game", "usdc"); f.fail(); const paused = await f.executor.execute(input);
    assert.equal(paused.terminal, false); assert.equal(paused.reason, "UNKNOWN_HTTP_RESULT_NO_REDISPATCH"); assert.equal(f.calls.length, 1);
    assert.deepEqual(await f.executor.execute({ ...input, recover: true }), paused); assert.equal(f.calls.length, 1);
    await assert.rejects(f.executor.execute(await f.input(0, "game", "usdc")), /HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED/);
    assert.equal(await read(f.local.f.account, "cash", [f.agents[0].binding!.agentId]), 0n);
    const invalid = await f.input(1, "game", "usdc"); f.wrong(); const rejected = await f.executor.execute(invalid);
    assert.equal(rejected.terminal, true); assert.equal(rejected.success, false); assert.equal(rejected.reason, "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE");
    assert.equal(f.calls.length, 2); assert.equal(await read(f.local.f.account, "cash", [f.agents[1].binding!.agentId]), 0n);
  } finally { await f.close(); }
});

test("private configuration is closed, read-only and rejects browser recipients, remote local RPC and permissive key files", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const configFile = await f.file("game-config.json", JSON.stringify(f.config)); assert.deepEqual(await loadHostedGameExecutorConfig(configFile), f.config);
    assert.throws(() => validateHostedGameExecutorConfig({ ...f.config, recipient: f.agents[0].wallet }), /HOSTED_GAME_CONFIG_INVALID/);
    assert.throws(() => validateHostedGameExecutorConfig({ ...f.config, publicRpcUrl: "http://example.com/" }), /HOSTED_GAME_RPC_INVALID/);
    assert.throws(() => validateHostedGameExecutorConfig({ ...f.config, models: [{ ...f.config.models[0], baseUrl: "https://evil.invalid/v1" }] }), /REWARD_OFFICIAL_KIMI_CONFIGURATION_REQUIRED/);
    const unsafe = join(f.directory, "unsafe.key"); await writeFile(unsafe, key(1), { mode: 0o644 });
    const unsafeConfig = await f.file("unsafe.json", JSON.stringify({ ...f.config, sponsorKeyFile: unsafe })); await assert.rejects(loadHostedGameExecutorConfig(unsafeConfig), /HOSTED_GAME_PRIVATE_FILE_REQUIRED/);
    const linked = join(f.directory, "linked.key"); await symlink(f.config.sponsorKeyFile, linked);
    const linkedConfig = await f.file("linked.json", JSON.stringify({ ...f.config, sponsorKeyFile: linked })); await assert.rejects(loadHostedGameExecutorConfig(linkedConfig), /HOSTED_GAME_PRIVATE_FILE_REQUIRED/);
    const mismatch = await f.file("wrong-bot.json", JSON.stringify({ ...f.config, opponent: { ...f.config.opponent, keyFile: f.config.sponsorKeyFile } }));
    await assert.rejects(loadHostedGameExecutorConfig(mismatch), /HOSTED_GAME_KEY_BINDING_MISMATCH/);
    const actor = f.agents[0], locked = new SessionStore<any>(join(f.config.walletDirectory, actor.wallet.toLowerCase())); await locked.start();
    try { await assert.rejects(f.executor.execute(await f.input(0, "game", "usdc")), /SESSION_BUSY/); } finally { await locked.close(); }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("Queued recovery with no adapter journal freezes first, and an already broadcast deposit resumes using the same signature", { timeout: 90000 }, async () => {
  const f = await fixture(), rpc = f.local.f.provider;
  const original = rpc.getTransactionReceipt.bind(rpc); let drop = true;
  try {
    const input = { ...await f.input(0, "game", "usdc"), recover: true };
    rpc.getTransactionReceipt = async hash => {
      const receipt = await original(hash);
      const deposit = receipt?.logs.some(log => {
        try { const event = f.local.f.account.interface.parseLog(log); return event?.name === "CashCredited" && event.args.agentId === 3n; } catch { return false; }
      });
      if (drop && deposit) { drop = false; throw Object.assign(new Error("private RPC credential must not escape"), { code: "TIMEOUT" }); }
      return receipt;
    };
    const paused = await f.executor.execute(input); assert.equal(paused.terminal, false); assert.equal(paused.phase, "RewardPending");
    assert.equal(paused.reason, "RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT"); assert.equal(f.calls.length, 2);
    const entries = await readFile(join(input.directory, "reward-transactions.json"), "utf8"); assert.equal(Object.keys(JSON.parse(entries)).length, 3);
    const nonces = await Promise.all([input.agent.wallet, f.local.sponsor.address].map(w => rpc.getTransactionCount(w)));
    rpc.getTransactionReceipt = original;
    const completed = await f.executor.execute(input); assert.equal(completed.terminal, true); assert.equal(completed.success, true); assert.equal(completed.cashRaw, "100000");
    assert.equal(f.calls.length, 2); assert.equal(await readFile(join(input.directory, "reward-transactions.json"), "utf8"), entries);
    assert.deepEqual(await Promise.all([input.agent.wallet, f.local.sponsor.address].map(w => rpc.getTransactionCount(w))), nonces);
  } finally { rpc.getTransactionReceipt = original; await f.close(); }
});

test("unknown credit usage holds only that agent's reservation and original redemption never invokes the model again", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    await f.executor.execute(await f.input(0, "game", "llm-credits"));
    const credit = await f.input(0, "credits"); f.fail(); const paused = await f.executor.execute(credit);
    assert.equal(paused.terminal, false); assert.equal(paused.phase, "OutcomeUnknown"); assert.equal(paused.creditsUsed, 0); assert.equal(f.calls.length, 3);
    const first = await f.balance(0); assert.ok(first.reservedTokens > 128); assert.ok(first.availableTokens < 4096); assert.equal(first.consumedTokens, 0);
    assert.deepEqual(await f.executor.execute({ ...credit, recover: true }), paused); assert.equal(f.calls.length, 3); assert.deepEqual(await f.balance(0), first);
    assert.equal((await f.balance(1)).reservedTokens, 0); assert.equal((await f.balance(1)).availableTokens, 0);
  } finally { await f.close(); }
});

test("award sponsor shares the registration/gas operator nonce guard and cannot bypass an unknown operation", { timeout: 90000 }, async () => {
  const f = await fixture(), lock = new SessionStore<any>(join(f.config.walletDirectory, "operator", f.local.sponsor.address.toLowerCase()));
  try {
    const input = await f.input(0, "game", "usdc"), nonce = await f.local.f.provider.getTransactionCount(f.local.sponsor.address);
    await lock.start();
    const busy = await f.executor.execute(input); assert.equal(busy.terminal, false); assert.equal(busy.reason, "SESSION_BUSY"); assert.equal(busy.phase, "RewardPending");
    assert.equal(f.calls.length, 2); assert.equal(await f.local.f.provider.getTransactionCount(f.local.sponsor.address), nonce);
    await lock.write({ directory: join(f.directory, "another-provision") }); await lock.close();
    const pending = await f.executor.execute({ ...input, recover: true }); assert.equal(pending.reason, "HOSTED_GAME_SPONSOR_RECOVERY_REQUIRED"); assert.equal(f.calls.length, 2);
    await lock.start(); await lock.write({}); await lock.close();
    const done = await f.executor.execute({ ...input, recover: true }); assert.equal(done.success, true); assert.equal(done.cashRaw, "100000"); assert.equal(f.calls.length, 2);
  } finally { await lock.close(); await f.close(); }
});

test("an admitted hand whose fixed authorization expires before execution dispatches zero models", { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    const input = await f.input(0, "game", "usdc"), expiresAt = Date.now() + 1; f.deadline(expiresAt);
    await new Promise(done => setTimeout(done, 5));
    const result = await f.executor.execute(input);
    assert.equal(result.terminal, true); assert.equal(result.success, false); assert.equal(result.reason, "HOLDEM_DEADLINE_REACHED"); assert.equal(f.calls.length, 0);
    const hand = JSON.parse(await readFile(join(input.directory, "game/session.json"), "utf8")); assert.equal(hand.turns.length, 0);
    assert.equal(await read(f.local.f.account, "cash", [input.agent.binding!.agentId]), 0n);
  } finally { await f.close(); }
});

test("a verified completed hand can finish its pending award after authorization expiry without a model or deadline rewrite", { timeout: 90000 }, async () => {
  const f = await fixture(), clock = Date.now;
  try {
    const input = await f.input(0, "game", "usdc"), expiresAt = Date.now() + 600000; f.deadline(expiresAt);
    const guard = new SessionStore<any>(join(f.config.walletDirectory, "operator", f.local.sponsor.address.toLowerCase()));
    await guard.start(); await guard.write({ directory: join(f.directory, "original-operator-unknown") }); await guard.close();
    const pending = await f.executor.execute(input); assert.equal(pending.terminal, false); assert.equal(f.calls.length, 2);
    const before = await readFile(join(input.directory, "game/session.json"), "utf8"); assert.equal(JSON.parse(before).phase, "Complete");
    await guard.start(); await guard.write({}); await guard.close(); Date.now = () => expiresAt + 1;
    const done = await f.executor.execute({ ...input, recover: true }); assert.equal(done.success, true); assert.equal(done.rewardRaw, "100000"); assert.equal(f.calls.length, 2);
    assert.equal(await readFile(join(input.directory, "game/session.json"), "utf8"), before);
  } finally { Date.now = clock; await f.close(); }
});

test("a completed losing game never emits an actor reward confirmation",{timeout:90000},async()=>{
 const f=await fixture();try{f.lose();const input=await f.input(0,"game","usdc"),events:HostedActivityInput[]=[];input.activity=async e=>{events.push(validateHostedActivity(e));};
 const result=await f.executor.execute(input);assert.equal(result.success,true);assert.equal(result.rewardRaw,"0");assert.ok(events.some(e=>e.scene==="game"&&e.evidence?.outcome==="lost"));assert.equal(events.at(-1)?.evidence?.outcome,"lost");assert.equal(events.at(-1)?.evidence?.rewardRaw,"0");assert.equal(events.some(e=>e.scene==="settlement"&&e.state==="confirmed"),false);
 }finally{await f.close();}
});
