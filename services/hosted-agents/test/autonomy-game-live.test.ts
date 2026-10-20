import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Wallet, Transaction } from "ethers";
import { replayHand } from "../../arena/src/holdem/engine.js";
import { HostedAutonomyExecutor } from "../src/autonomy-executor.js";
import { key, read } from "../../underwriter/test/fixture.js";
import { validateHostedActivity, type HostedActivityInput } from "../src/scene-types.js";
import { HostedService } from "../src/service.js";
import { InferenceRewardLedger } from "../../arena/src/inference-rewards/index.js";
import { createKimiRewardDispatch } from "../../arena/src/inference-rewards/provider.js";
import { randomUUID } from "node:crypto";

import { createAutonomyGameFixture as fixture } from "./autonomy-game-fixture.js";

for (const rewardKind of ["usdc", "llm-credits"] as const) test(`automatic ${rewardKind} game reward funds an actual task, canonical independent settlement and read-only replay`, { timeout: 240000 }, async () => {
  const t = await fixture();
  try {
    const actor = await t.f.actor(5, "kimi-k2.6", 0n); actor.agent.totalBudgetRaw = "130000";
    const ready = await t.tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready));
    actor.agent.binding = ready.binding; actor.agent.status = "Ready"; assert.equal(ready.cashRaw, "0");
    const parent = actor.input("task"); parent.run.action = "autonomous"; parent.run.reservedRaw = "130000";
    const activities: HostedActivityInput[] = []; parent.activity = async event => { activities.push(validateHostedActivity(event)); };
    const sponsor = new Wallet(key(1)).address, sponsorBalance = await read(t.f.fx.f.token!, "balanceOf", [sponsor]);
    const executor = t.autonomous(rewardKind === "usdc" ? ["usdc", "llm-credits"] : ["llm-credits"]);
    const result = await executor.execute(parent);
    assert.equal(result.phase, "Completed", JSON.stringify({ result, activities, requests: t.requests, samples: t.samples }));
    assert.equal(result.success, true); assert.equal(result.autonomousGames, 1); assert.equal(result.autonomousTasks, 1);
    assert.equal(result.chargedRaw, rewardKind === "usdc" ? "130000" : "0");
    const host = JSON.parse(await readFile(join(parent.directory, "autonomy-host", "session.json"), "utf8"));
    const children = Object.values(host.children) as any[]; assert.equal(children.length, 2);
    const match = children.find(child => child.run.action === "game"), task = children.find(child => child.run.action !== "game");
    assert.ok(match); assert.ok(task); assert.equal(match.run.rewardKind, rewardKind); assert.equal(match.agent.allowCredit, false); assert.equal(match.run.reservedRaw, "0");
    assert.equal(task.run.action, rewardKind === "usdc" ? "metered-task" : "reward-task");
    const game = JSON.parse(await readFile(join(match.directory, "game", "session.json"), "utf8"));
    assert.deepEqual(replayHand(game.replay).view(0).result!.winners, [0]); assert.equal(game.replay.actions.length, 2);
    assert.ok(activities.some(event => event.scene === "game" && event.evidence?.outcome === "won"));
    assert.ok(activities.some(event => event.scene === "settlement" && event.evidence?.passed === true && !!event.evidence.txHash));
    const financial = await t.tasks.finance(actor.agent); assert.equal(financial.status, "confirmed", JSON.stringify(financial));
    if (financial.status === "confirmed") { assert.equal(financial.counts.successes, "1"); assert.equal(financial.debtRaw, "0"); assert.ok(BigInt(financial.cashRaw) > 0n); }
    const settled = JSON.parse(await readFile(join(task.directory, "task-executor", "session.json"), "utf8")).result;
    assert.equal(settled.settlement.passed, true);
    assert.equal(settled.settlement.loanStatus, rewardKind === "usdc" ? "2" : "0");
    const canonical = await t.f.fx.f.provider.getTransactionReceipt(settled.settlement.txHash);
    assert.equal(canonical!.status, 1); assert.equal((await t.f.fx.f.provider.getBlock(canonical!.blockNumber))!.hash, canonical!.blockHash);
    const gameAwardHashes: string[] = [];
    if (rewardKind === "usdc") {
      assert.equal(sponsorBalance - await read(t.f.fx.f.token!, "balanceOf", [sponsor]), 100000n);
      const entries = JSON.parse(await readFile(join(match.directory, "reward-transactions.json"), "utf8")); assert.equal(Object.keys(entries).length, 3);
      for (const entry of Object.values(entries) as any[]) {
        gameAwardHashes.push(entry.txHash);
        const tx = Transaction.from(entry.rawTransaction), receipt = await t.f.fx.f.provider.getTransactionReceipt(entry.txHash);
        assert.equal(tx.hash, entry.txHash); assert.equal(receipt!.status, 1); assert.equal((await t.f.fx.f.provider.getBlock(receipt!.blockNumber))!.hash, receipt!.blockHash);
      }
      assert.equal(t.requests.filter(request => request.model === "physical-planner").length, 1);
      assert.equal(settled.fromCreditRaw, "30000"); assert.equal(settled.fromCashRaw, "90000");
    } else {
      assert.equal(await read(t.f.fx.f.token!, "balanceOf", [sponsor]), sponsorBalance);
      assert.equal(t.requests.filter(request => request.model === "physical-planner").length, 0);
      assert.equal(settled.creditsUsed, 30); assert.equal((await t.games.rewardBalance(actor.agent)).availableTokens, 4066);
    }
    assert.equal(t.requests.filter(request => request.tools).length, 1);
    // Metered worker owns its own real DockerExecutor; reward-task uses the explicitly injected one.
    if (rewardKind === "llm-credits") assert.ok(t.samples.length > 0);
    const counts = t.requests.length, nonces = await Promise.all([actor.wallet.address, sponsor].map(address => t.f.fx.f.provider.getTransactionCount(address)));
    assert.deepEqual(await executor.execute({ ...parent, recover: true }), result);
    assert.equal(t.requests.length, counts); assert.deepEqual(await Promise.all([actor.wallet.address, sponsor].map(address => t.f.fx.f.provider.getTransactionCount(address))), nonces);
    const summaryDirectory = new URL("../../../frontend/acceptance/autonomous-collaboration-20261014/", import.meta.url).pathname;
    await mkdir(summaryDirectory, { recursive: true });
    const summaryPath = join(summaryDirectory, "automatic-game.json");
    let summaries: any[] = [];
    try { summaries = JSON.parse(await readFile(summaryPath, "utf8")).cases ?? []; } catch { /* First successful case creates the public evidence file. */ }
    const loop = JSON.parse(await readFile(join(parent.directory, "autonomy-loop", "session.json"), "utf8"));
    const plannerPayments = [];
    for (const step of loop.steps.filter((step: any) => BigInt(step.decisionChargedRaw ?? "0") > 0n)) {
      const receipt = JSON.parse(await readFile(join(parent.directory, "planner", step.decisionId, "session.json"), "utf8")).inference.receipt;
      plannerPayments.push({ decisionId: step.decisionId, paymentId: receipt.paymentId, txHash: receipt.txHash, fromCashRaw: receipt.fromCash, fromCreditRaw: receipt.fromCredit });
    }
    const publicReceipts = [];
    for (const hash of [...new Set([...gameAwardHashes, ...plannerPayments.map(payment => payment.txHash), settled.acceptTxHash, settled.paymentTxHash, settled.settlement.txHash].filter(Boolean))]) {
      const receipt = (await t.f.fx.f.provider.getTransactionReceipt(hash))!;
      publicReceipts.push({ txHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
        canonical: (await t.f.fx.f.provider.getBlock(receipt.blockNumber))!.hash === receipt.blockHash });
    }
    const matchResult = JSON.parse(await readFile(join(match.directory, "session.json"), "utf8")).result;
    const summary = { rewardKind, chainId: "31337", modelMode: "controlled-loopback-http", independentVerifier: "Docker + separate Arena settler",
      parentRequestId: parent.run.requestId, gameRequestId: match.run.requestId, taskRequestId: task.run.requestId,
      matchId: matchResult.matchId, taskId: settled.taskId, paymentId: settled.paymentId,
      winners: replayHand(game.replay).view(0).result!.winners, gameActionCount: game.replay.actions.length,
      rewardRaw: matchResult.rewardRaw ?? "0", creditsGranted: matchResult.creditsGranted ?? 0,
      balanceBefore: { cashRaw: "0", rewardTokens: 0 },
      balanceAfter: { cashRaw: financial.status === "confirmed" ? financial.cashRaw : "unavailable", rewardTokens: (await t.games.rewardBalance(actor.agent)).availableTokens,
        debtRaw: financial.status === "confirmed" ? financial.debtRaw : "unavailable", successes: financial.status === "confirmed" ? financial.counts.successes : "unavailable" },
      taskFunding: { fromCashRaw: settled.fromCashRaw ?? "0", fromCreditRaw: settled.fromCreditRaw ?? "0", creditsUsed: settled.creditsUsed ?? 0 },
      parent: { phase: result.phase, chargedRaw: result.chargedRaw, completedGames: result.autonomousGames, completedTasks: result.autonomousTasks },
      settlement: settled.settlement, plannerPayments, gameAwardTxHashes: gameAwardHashes, canonicalReceipts: publicReceipts,
      readOnlyRecovery: { requestCountBefore: counts, requestCountAfter: t.requests.length, noncesBefore: nonces,
        noncesAfter: await Promise.all([actor.wallet.address, sponsor].map(address => t.f.fx.f.provider.getTransactionCount(address))), originalResultPreserved: true },
      completedAt: new Date().toISOString() };
    await writeFile(summaryPath, JSON.stringify({ version: 1, chainId: "31337", cases: [...summaries.filter(existing => existing.rewardKind !== rewardKind), summary] }, null, 2) + "\n");
  } finally { await t.close(); }
});

test("one actual settled task exhausts the configured catalog and closes a two-task parent without another game, plan or child", { timeout: 240000 }, async () => {
  const t = await fixture();
  try {
    for (const model of t.tasks.config.models) for (const workflow of Object.values(model.templates)) workflow.tasks = workflow.tasks.slice(0, 1);
    const actor = await t.f.actor(5, "kimi-k2.6", 0n); actor.agent.totalBudgetRaw = "130000";
    const ready = await t.tasks.execute(actor.input("provision")); assert.equal(ready.success, true); actor.agent.binding = ready.binding;
    const parent = actor.input("task"); parent.run.action = "autonomous"; parent.run.reservedRaw = "130000";
    const executor = new HostedAutonomyExecutor(t.tasks, { ...t.autonomous(["llm-credits"]).config, maxTasks: 2 }, { provider: t.f.fx.f.provider, games: t.games });
    const result = await executor.execute(parent);
    assert.equal(result.phase, "Stopped", JSON.stringify(result)); assert.equal(result.reason, "AUTONOMY_NO_AVAILABLE_TASKS");
    assert.equal(result.terminal, true); assert.equal(result.success, true); assert.equal(result.autonomousTasks, 1); assert.equal(result.autonomousGames, 1);
    const host = JSON.parse(await readFile(join(parent.directory, "autonomy-host", "session.json"), "utf8"));
    const children = Object.values(host.children) as any[]; assert.equal(children.length, 2);
    assert.equal(children.filter(child => child.run.action === "game").length, 1);
    const child = children.find(child => child.run.action === "reward-task"); assert.ok(child);
    const settled = JSON.parse(await readFile(join(child.directory, "task-executor", "session.json"), "utf8")).result;
    assert.equal(settled.phase, "Succeeded"); assert.equal(settled.settlement.passed, true);
    const receipt = (await t.f.fx.f.provider.getTransactionReceipt(settled.settlement.txHash))!;
    assert.equal(receipt.status, 1); assert.equal((await t.f.fx.f.provider.getBlock(receipt.blockNumber))!.hash, receipt.blockHash);
    assert.equal(t.requests.filter(request => request.tools).length, 1); assert.equal(t.requests.filter(request => request.model === "physical-planner").length, 0);
    const loop = JSON.parse(await readFile(join(parent.directory, "autonomy-loop", "session.json"), "utf8"));
    assert.equal(loop.config.maxTasks, 2); assert.equal(loop.steps.at(-1).context.observation.availableTasks, 0);
    assert.equal(loop.steps.at(-1).decisionChargedRaw, "0");
    const requests = t.requests.length, nonce = await t.f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await executor.execute({ ...parent, recover: true }), result);
    assert.equal(t.requests.length, requests); assert.equal(await t.f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);

    // A new parent must see the already-settled canonical task before a game,
    // sponsor admission, planner payment or a second task can be dispatched.
    const emptyParent = actor.input("task"); emptyParent.run.action = "autonomous"; emptyParent.run.reservedRaw = "130000";
    const roleAddresses = Array.from({ length: 10 }, (_, index) => new Wallet(key(index + 1)).address);
    const roleNonces = await Promise.all(roleAddresses.map(address => t.f.fx.f.provider.getTransactionCount(address)));
    const empty = await executor.execute(emptyParent);
    assert.equal(empty.phase, "Stopped"); assert.equal(empty.reason, "AUTONOMY_NO_AVAILABLE_TASKS");
    assert.equal(empty.terminal, true); assert.equal(empty.success, false); assert.equal(empty.autonomousTasks, 0); assert.equal(empty.autonomousGames, 0);
    assert.equal(empty.chargedRaw, "0"); assert.equal(t.requests.length, requests);
    const emptyHost = await readFile(join(emptyParent.directory, "autonomy-host", "session.json"), "utf8");
    const emptyLoop = await readFile(join(emptyParent.directory, "autonomy-loop", "session.json"), "utf8");
    assert.deepEqual(JSON.parse(emptyHost).children, {});
    assert.equal(JSON.parse(emptyLoop).startedTasks, 0); assert.equal(JSON.parse(emptyLoop).startedGames ?? 0, 0);
    assert.deepEqual(await Promise.all(roleAddresses.map(address => t.f.fx.f.provider.getTransactionCount(address))), roleNonces);
    assert.deepEqual(await executor.execute({ ...emptyParent, recover: true }), empty);
    assert.equal(t.requests.length, requests);
    assert.equal(await readFile(join(emptyParent.directory, "autonomy-host", "session.json"), "utf8"), emptyHost);
    assert.equal(await readFile(join(emptyParent.directory, "autonomy-loop", "session.json"), "utf8"), emptyLoop);
    assert.deepEqual(await Promise.all(roleAddresses.map(address => t.f.fx.f.provider.getTransactionCount(address))), roleNonces);
  } finally { await t.close(); }
});

test("real service replenishes an exhausted autonomous reward child through a manual game and resumes the original escrow task", { timeout: 240000 }, async () => {
  const t = await fixture(); let service: HostedService | undefined;
  try {
    const automaticConfig = { ...t.autonomous(["llm-credits"]).config, maxTasks: 1, maxDecisions: 5, games: { maxGames: 1, maxSpendPerGameRaw: "0", rewardKinds: ["llm-credits" as const], rewardTaskMinTokens: 100 } };
    const autonomous = new HostedAutonomyExecutor(t.tasks, automaticConfig, { provider: t.f.fx.f.provider, games: t.games, shouldContinue: agentId => service!.mayContinue(agentId),
      admitGame: (parent, child) => service!.admitAutonomyGame(parent.run.requestId, child.run.requestId, parent.agent.id) });
    service = await HostedService.open({ directory: join(t.directory, "hosted"), origin: "http://localhost:3024", chainId: "31337",
      models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }], maxAgentsPerOwner: 2, maxTotalBudgetRaw: "500000", maxPerRunBudgetRaw: "120000" }, {
      capabilities: { autonomy: { maxTasks: 1, durationMs: automaticConfig.durationMs, plannerPriceRaw: "10000", games: { maxGames: 1, rewardKinds: ["llm-credits"] } } },
      execute: async input => {
        if (input.run.action === "provision") await t.f.fx.f.provider.send("anvil_setBalance", [input.agent.wallet, "0x3635c9adc5dea00000"]);
        return input.run.action === "autonomous" ? autonomous.execute(input) : input.run.action === "game" ? t.games.execute(input) : t.tasks.execute(input);
      },
    }, { autonomyFunding: input => autonomous.resolveFundingTarget(input) });
    const owner = Wallet.createRandom().address;
    const created = await service.create(owner, { name: "Refuel acceptance", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: false, requestId: randomUUID() });
    await service.waitUntilIdle(); let agent = (await service.snapshot(owner)).agents[0]; assert.equal(agent.status, "Ready"); assert.ok(agent.binding);
    await service.command(owner, created.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID() }); await service.waitUntilIdle();
    assert.equal((await t.games.rewardBalance(agent)).availableTokens, 4096);
    const ledger = await InferenceRewardLedger.open(join(t.directory, "credits", agent.id), { accounts: [agent.binding!, t.games.config.opponent.binding],
      dispatch: createKimiRewardDispatch({ baseUrl: "https://api.moonshot.cn/v1", key: "controlled-local-model", upstreamFetch: async (_url, init) => fetch(t.route, init) }) });
    try {
      const used = await ledger.redeem(agent.binding!, { redemptionId: randomUUID(), prompt: "a".repeat(3500), maxCompletionTokens: 128 });
      assert.equal(used.status, "Completed"); assert.equal(used.chargedTokens, 3584);
    } finally { await ledger.close(); }
    assert.equal((await t.games.rewardBalance(agent)).availableTokens, 512);
    t.loseNextGame(); const parentId = randomUUID();
    await service.command(owner, agent.id, { action: "autonomous", requestId: parentId }); await service.waitUntilIdle();
    const paused = await service.snapshot(owner), parent = paused.runs.find(run => run.requestId === parentId)!;
    assert.equal(parent.status, "Paused", JSON.stringify(parent)); assert.equal(parent.reason, "AUTONOMY_GAME_LIMIT");
    assert.equal(parent.fundingNeed, "reward-tokens");
    assert.equal(parent.result!.autonomousGames, 1); assert.equal(parent.result!.autonomousTasks, 0);
    const parentDirectory = join(service.config.directory, "agents", agent.id, "runs", parentId);
    const target = await autonomous.resolveFundingTarget({ agent, run: parent, directory: parentDirectory,
      keyFile: join(service.config.directory, "agents", agent.id, "wallet.key"), recover: true });
    assert.ok(target); assert.equal(target.funding, "reward-tokens");
    const host = JSON.parse(await readFile(join(parentDirectory, "autonomy-host", "session.json"), "utf8"));
    const originalTask = host.children[target.childId];
    const taskBefore = JSON.parse(await readFile(join(originalTask.directory, "task-executor", "session.json"), "utf8")).result;
    assert.equal(taskBefore.reason, "INFERENCE_FUNDING_REQUIRED"); assert.ok(taskBefore.acceptTxHash); assert.ok(taskBefore.taskId);
    const gameId = randomUUID(), game = await service.command(owner, agent.id, { action: "game", rewardKind: "llm-credits", requestId: gameId });
    assert.equal(game.fundingFor, parentId); await service.waitUntilIdle();
    agent = (await service.snapshot(owner)).agents[0]; assert.equal(agent.activeRequestId, parentId);
    assert.equal((await t.games.rewardBalance(agent)).availableTokens, 4608);
    const beforeNonce = await t.f.fx.f.provider.getTransactionCount(agent.wallet), beforeRequests = t.requests.length;
    await service.command(owner, agent.id, { action: "autonomous", requestId: parentId }); await service.waitUntilIdle();
    const final = await service.snapshot(owner), completed = final.runs.find(run => run.requestId === parentId)!;
    assert.equal(completed.status, "Succeeded", JSON.stringify(completed)); assert.equal(completed.result!.autonomousTasks, 1);
    assert.equal(completed.fundingNeed, undefined);
    assert.equal(completed.result!.chargedRaw, "0"); assert.equal(final.agents[0].activeRequestId, undefined);
    const taskAfter = JSON.parse(await readFile(join(originalTask.directory, "task-executor", "session.json"), "utf8")).result;
    assert.equal(taskAfter.taskId, taskBefore.taskId); assert.equal(taskAfter.acceptTxHash, taskBefore.acceptTxHash); assert.equal(taskAfter.settlement.passed, true);
    assert.equal(await t.f.fx.f.provider.getTransactionCount(agent.wallet), beforeNonce, "original accepted task is not re-accepted during refuel recovery");
    assert.equal(t.requests.length, beforeRequests + 1, "only original solver call is newly dispatched");
    const data = JSON.parse(await readFile(join(service.config.directory, "database", "session.json"), "utf8")); assert.equal(data.sponsoredOwners[owner], 3);
    assert.equal(data.fundingRoutes[gameId].childId, target.childId); assert.equal(data.fundingRoutes[gameId].parentRequestId, parentId);
    assert.equal(await read(t.f.fx.f.account, "cash", [agent.binding!.agentId]), 150000n);
    const summaryPath = new URL("../../../frontend/acceptance/autonomous-collaboration-20261014/automatic-game.json", import.meta.url).pathname;
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    const receipt = (await t.f.fx.f.provider.getTransactionReceipt(taskAfter.settlement.txHash))!;
    summary.manualRefuel = { chainId: "31337", modelMode: "controlled-loopback-http", parentRequestId: parentId, childRequestId: target.childId, manualGameRequestId: gameId,
      originalTaskId: taskBefore.taskId, originalAcceptTxHash: taskBefore.acceptTxHash,
      balances: { earnedTokens: 4096, consumedBeforeTask: 3584, availableBeforeTask: 512, availableAfterManualGame: 4608,
        availableAfterTask: (await t.games.rewardBalance(agent)).availableTokens, cashAfterTaskRaw: "150000" },
      pause: { reason: parent.reason, fundingNeed: parent.fundingNeed }, resumedPhase: completed.result!.phase,
      taskIdPreserved: taskAfter.taskId === taskBefore.taskId, acceptTxHashPreserved: taskAfter.acceptTxHash === taskBefore.acceptTxHash,
      actorNonceBeforeResume: beforeNonce, actorNonceAfterResume: await t.f.fx.f.provider.getTransactionCount(agent.wallet),
      newHttpRequestsOnResume: t.requests.length - beforeRequests, sponsoredOwnerSlots: data.sponsoredOwners[owner],
      settlement: taskAfter.settlement, settlementCanonical: receipt.status === 1 && (await t.f.fx.f.provider.getBlock(receipt.blockNumber))!.hash === receipt.blockHash,
      completedAt: new Date().toISOString() };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");
  } finally { await service?.close(); await t.close(); }
});
