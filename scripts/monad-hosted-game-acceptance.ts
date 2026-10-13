import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, Wallet } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { HOLDEM_LIVE_LIMITS, publicLiveHand, type LiveHandSession } from "../services/arena/src/holdem/live.js";
import { ESCROW_ABI, atomicJson } from "../services/arena/src/protocol.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";

/** One real hand only. No fabricated winner, hidden-card export, retries or automatic second game. */
export async function monadHostedGameAcceptance(directory: string, mode: "check" | "game" | "task" | "evidence") {
  directory = resolve(directory);
  const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const ready = await read(join(directory, "ready.json")), acceptance = await read(join(directory, "acceptance.json"));
  assert.equal(ready.chainId, "10143"); assert.equal(ready.frontendOrigin, "http://127.0.0.1:3024");
  const selected = acceptance.agents.cheap?.agent; assert.ok(selected?.id, "Prepare the existing cheap Agent first");
  const hosted = await read(ready.hostedConfigFile), taskConfig = await read(hosted.executor.taskConfigFile), gameConfig = await read(hosted.executor.gameConfigFile);
  assert.equal(gameConfig.chainId, "10143"); assert.equal(gameConfig.opponent.modelId, "kimi-k2.6");
  const owner = new Wallet((await readFile(join(directory, "owner.key"), "utf8")).trim());
  let cookie = "";
  const api = async (path: string, method = "GET", input?: unknown) => {
    const response = await fetch(`${ready.frontendOrigin}/api/hosted${path}`, { method, headers: { origin: ready.frontendOrigin,
      "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(60000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`HOSTED_HTTP_${response.status}`);
    if (path === "/auth/login") { cookie = response.headers.get("set-cookie")?.split(";")[0] ?? ""; assert.ok(cookie); }
    return value;
  };
  const challenge = await api("/auth/challenge", "POST", { wallet: owner.address });
  assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 10143\nNonce: `));
  assert.ok(challenge.message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
  await api("/auth/login", "POST", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
  const snapshot = await api("/agents"), agent = snapshot.agents.find((entry: any) => entry.id === selected.id);
  assert.ok(agent?.binding); assert.equal(agent.binding.chainId, "10143"); assert.equal(agent.modelId, "kimi-k2.6");
  assert.equal(agent.owner.toLowerCase(), owner.address.toLowerCase());
  const connection = await monadProvider(await readRpcUrlFile(ready.rpcUrlFile), ready.rpcTransport);
  const store = new SessionStore<any>(join(directory, "game-acceptance")); let held = false;
  try {
    const provider = connection.provider;
    assert.equal(BigInt(await provider.send("eth_chainId", [])), 10143n);
    const template = taskConfig.models.find((model: any) => model.id === agent.modelId).templates[agent.strategy];
    const arenaConfig = await read(join(directory, "arena.json"));
    const arenaResponse = await fetch(`${taskConfig.arenaUrl}/problems`, { signal: AbortSignal.timeout(20000) });
    assert.ok(arenaResponse.ok); const liveArena = await arenaResponse.json();
    const escrow = new Contract(template.escrowAddress, ESCROW_ABI, provider);
    const expectedTaskId = "16", definition = template.tasks.find((task: any) => task.taskId === expectedTaskId);
    const catalogReady = Boolean(definition && arenaConfig.tasks[expectedTaskId]?.problemId === definition.problemId && liveArena.tasks?.[expectedTaskId]?.problemId === definition.problemId);
    for (const route of template.providers.flatMap((entry: any) => entry.routes)) {
      assert.ok(route.solve.maxRounds <= 2); assert.ok(route.solve.maxToolCalls <= 4);
    }
    const limits = { gameCount: 1, gameMaxCalls: HOLDEM_LIVE_LIMITS.maxCalls, gameMaxCompletionTokensPerCall: HOLDEM_LIVE_LIMITS.maxCompletionTokens,
      gameDeadlineMs: HOLDEM_LIVE_LIMITS.deadlineDurationMs, gameUpstreamTimeoutMs: HOLDEM_LIVE_LIMITS.upstreamTimeoutMs,
      taskMaxModelCalls: 2, taskMaxCompletionTokensPerCall: 512, newUsdcInferencePayments: 0, newBorrowingRaw: "0", gameUsesOfficialKimiNotMagpie: true };
    if (mode === "check") return { checked: true, businessPosts: 0, chainId: "10143", agentId: agent.binding.agentId, hostedAgentId: agent.id, expectedTaskId, catalogReady, limits };
    // This is an acceptance-only journal, separate from root's ongoing financial acceptance.
    await store.start(true); held = true;
    let journal = await store.read();
    if (!journal) { journal = { version: 1, agentId: agent.id, binding: agent.binding, expectedTaskId, limits, startedAt: new Date().toISOString() }; await store.write(journal); }
    assert.equal(journal.agentId, agent.id); assert.deepEqual(journal.binding, agent.binding); assert.equal(journal.expectedTaskId, expectedTaskId);
    const save = () => store.write(journal);
    const wait = async (requestId: string) => {
      const deadline = Date.now() + 660000;
      while (Date.now() < deadline) {
        const state = await api("/agents"), run = state.runs.find((entry: any) => entry.requestId === requestId);
        if (run && !["Running", "Queued"].includes(run.status)) return run;
        await new Promise(done => setTimeout(done, 2000));
      }
      throw new Error("GAME_ACCEPTANCE_WAIT_TIMEOUT_INSPECT_ORIGINAL_UUID");
    };
    const dispatchOnce = async (label: "game" | "task", input: any) => {
      journal[label] ??= { input }; await save();
      const command = journal[label].input;
      const state = await api("/agents"), existing = state.runs.find((entry: any) => entry.requestId === command.requestId);
      // Paused/unknown and terminal runs are observations, never automatically resumed.
      if (!existing) {
        assert.ok(!state.agents.find((entry: any) => entry.id === agent.id)?.activeRequestId, "Finish the original active run first");
        await api(`/agents/${agent.id}/runs`, "POST", command);
      }
      journal[label].result = existing && !["Running", "Queued"].includes(existing.status) ? existing : await wait(command.requestId);
      await save(); return journal[label].result;
    };
    if (mode === "game") {
      if (!journal.financeBefore) { journal.financeBefore = await api(`/agents/${agent.id}/finance`); assert.equal(journal.financeBefore.status, "confirmed"); await save(); }
      const run = await dispatchOnce("game", { action: "game", rewardKind: "llm-credits", requestId: randomUUID() });
      journal.outcome = run.status === "Succeeded" ? (run.result?.creditsGranted > 0 ? "CREDITS_EARNED" : "LOST_NO_CREDITS") : "GAME_UNCONFIRMED_OR_STOPPED";
      assert.equal(run.chargedRaw, "0"); await save();
      return { requestId: run.requestId, status: run.status, reason: run.reason, outcome: journal.outcome, creditsGranted: run.result?.creditsGranted, limits };
    }
    if (mode === "task") {
      assert.equal(journal.game?.result?.status, "Succeeded", "Observe the original hand before task admission");
      if (!(journal.game.result.result?.creditsGranted > 0)) return { outcome: "LOST_NO_CREDITS", additionalGameStarted: false, taskStarted: false };
      assert.ok(catalogReady, "Task 16 must be approved in task, live Arena and independent settler catalogs before dispatch");
      if (!journal.task) {
        const open = [];
        for (const task of template.tasks) {
          const chain = await escrow.getTask(task.taskId);
          if (chain.status === 1n) open.push(task.taskId);
          if (task.taskId === expectedTaskId) { assert.equal(chain.reward, 150000n); assert.equal(Number(chain.deadline) * 1000, definition.deadlineMs); assert.ok(definition.deadlineMs > Date.now() + 300000); }
        }
        assert.deepEqual(open, [expectedTaskId], "Only task 16 may remain open for this bounded acceptance");
        journal.financeBeforeTask = await api(`/agents/${agent.id}/finance`); assert.equal(journal.financeBeforeTask.status, "confirmed"); await save();
      }
      const run = await dispatchOnce("task", { action: "reward-task", requestId: randomUUID() });
      assert.equal(run.chargedRaw, "0");
      if (run.status === "Succeeded") {
        assert.equal(run.result?.taskId, expectedTaskId); assert.equal(run.result?.settlement?.passed, true);
        assert.equal(run.result?.paymentId, undefined); assert.equal(run.result?.settlement?.loanStatus, "0");
        assert.equal(run.result?.settlement?.residualRaw, "150000"); assert.ok(run.result?.creditsUsed > 0);
      }
      journal.financeAfter = await api(`/agents/${agent.id}/finance`); await save();
      return { requestId: run.requestId, status: run.status, reason: run.reason, result: run.result, finance: journal.financeAfter };
    }
    assert.ok(journal.game?.result, "Run the single authorized game first");
    const gameDirectory = join(hosted.hosted.directory, "agents", agent.id, "runs", journal.game.input.requestId);
    const hand = await read(join(gameDirectory, "game", "session.json")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; }) as LiveHandSession | undefined;
    const publicHand = hand ? publicLiveHand(hand) : undefined;
    if (hand) { assert.ok(hand.turns.length <= 20); assert.ok(hand.turns.every(turn => turn.request.model === "kimi-k2.6" && turn.request.max_completion_tokens === 512)); }
    const ledger = await read(join(gameConfig.creditsDirectory, agent.id, "session.json")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    const grant = ledger?.grants.find((entry: any) => entry.grantId === journal.game.input.requestId);
    if (journal.game.result.status === "Succeeded") { assert.ok(grant); assert.equal(grant.allocations[0], journal.game.result.result.creditsGranted); }
    const taskRedemptions = (ledger?.redemptions ?? []).filter((entry: any) => journal.task && entry.redemptionId.startsWith(`${journal.task.input.requestId}:round:`));
    assert.ok(taskRedemptions.length <= 2);
    const taskResult = journal.task?.result;
    let settlement;
    if (taskResult?.status === "Succeeded") {
      const hash = taskResult.result.settlement.txHash, receipt = await provider.getTransactionReceipt(hash);
      assert.ok(receipt && receipt.status === 1); const block = await provider.getBlock(receipt.blockNumber); assert.equal(block?.hash, receipt.blockHash);
      const events = receipt.logs.filter(log => log.address.toLowerCase() === template.escrowAddress.toLowerCase())
        .map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "TaskSettled");
      assert.equal(events.length, 1); assert.equal(events[0]!.args.taskId.toString(), expectedTaskId); assert.equal(events[0]!.args.passed, true);
      assert.equal(events[0]!.args.repaid, 0n); assert.equal(events[0]!.args.slashed, 0n); assert.equal(events[0]!.args.agentResidual, 150000n);
      const chain = await escrow.getTask(expectedTaskId); assert.equal(chain.status, 3n); assert.equal(chain.agentId.toString(), agent.binding.agentId);
      settlement = { txHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, canonical: true };
      assert.equal(journal.financeAfter.debtRaw, "0");
      assert.equal(BigInt(journal.financeAfter.cashRaw) - BigInt(journal.financeBeforeTask.cashRaw), 150000n);
    }
    const evidence = { checkedAt: new Date().toISOString(), chainId: "10143", hostedAgentId: agent.id, agentId: agent.binding.agentId,
      scope: "Real hosted Kimi hand, local identity-bound token ledger, optional reward-funded Pi task and canonical Monad settlement", limits,
      outcome: journal.outcome, game: journal.game.result, hand: publicHand, grant,
      task: taskResult, settlement, redemptions: taskRedemptions.map((entry: any) => ({ redemptionId: entry.redemptionId, status: entry.status, model: entry.model, chargedTokens: entry.chargedTokens, usage: entry.usage, error: entry.error })),
      financeBefore: journal.financeBefore, financeBeforeTask: journal.financeBeforeTask, financeAfter: journal.financeAfter,
      fullRewardTaskAccepted: taskResult?.status === "Succeeded" && Boolean(settlement), additionalGamesStarted: 0 };
    await atomicJson(join(directory, "game-acceptance", "evidence.json"), evidence); return evidence;
  } finally { if (held) await store.close(); connection.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, mode] = process.argv.slice(2);
  if (!directory || !["check", "game", "task", "evidence"].includes(mode)) { console.error("Usage: monad-hosted-game-acceptance.ts RUNTIME check|game|task|evidence"); process.exitCode = 1; }
  else monadHostedGameAcceptance(directory, mode as "check" | "game" | "task" | "evidence").then(result => console.log(JSON.stringify(result)))
    .catch(error => { const code = (error as Error).message; console.error(/^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "MONAD_GAME_ACCEPTANCE_STOPPED_INSPECT_ORIGINAL_JOURNAL"); process.exitCode = 1; });
}
