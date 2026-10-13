import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Contract, Wallet } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { atomicJson, digest } from "../services/arena/src/protocol.js";
import { publicLiveHand, parseLegalDecision, type LiveHandSession } from "../services/arena/src/holdem/live.js";
import { replayHand } from "../services/arena/src/holdem/engine.js";
import { DemoJournal } from "./demo-journal.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { assertGameAwardEvent } from "../services/hosted-agents/src/game-award-events.js";
import { TEMPO_PATH_USD } from "./tempo-config.js";

const [runtimeArg, outputArg, mode] = process.argv.slice(2);
assert.ok(runtimeArg && outputArg && ["prepare", "game-cash", "game-credits", "game-cash-2", "game-credits-2", "cash-task", "reward-task", "finance", "evidence"].includes(mode), "Usage: tempo-gamefi-acceptance.ts RUNTIME OUTPUT MODE [--recover]");
const runtime = resolve(runtimeArg), output = resolve(outputArg), read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const lock = new SessionStore(join(output, "writer")); await lock.start(process.argv.includes("--recover"));
const ready = await read(join(runtime, "ready.json")), bootstrap = await read(ready.bootstrapFile);
assert.equal(ready.chainId, "42431"); assert.equal(bootstrap.chainId, "42431"); assert.equal(bootstrap.asset.address.toLowerCase(), TEMPO_PATH_USD.toLowerCase());
const owner = new Wallet((await readFile(join(runtime, "owner.key"), "utf8")).trim());
const connection = await chainRpcProvider(await readRpcUrlFile(bootstrap.rpcUrlFile), "42431", bootstrap.rpcTransport);
const journalFile = join(output, "acceptance.json"); let state: any;
try { state = await read(journalFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const save = () => atomicJson(journalFile, state);
try {
  if (!state) {
    assert.equal(mode, "prepare");
    const db = await read(join(runtime, "hosted/database/session.json"));
    const used = Number(Object.entries(db.sponsoredOwners).find(([wallet]) => wallet.toLowerCase() === owner.address.toLowerCase())?.[1] ?? 0);
    assert.ok(used <= 1 && db.agents.filter((agent: any) => agent.owner.toLowerCase() === owner.address.toLowerCase()).length <= 4, "Preserve the real owner quota and existing actors");
    const task = await read(join(runtime, "task.json"));
    assert.equal(task.models.find((model: any) => model.id === "kimi-k2.6").templates.balanced.providers[0].routes[0].price, "120000");
    state = { version: 1, createdAt: new Date().toISOString(), runtime, chainId: "42431", owner: owner.address, actors: {}, runs: {},
      budget: { chainId: "42431", asset: TEMPO_PATH_USD, ownerGamesBefore: used, maxNewGames: 3 - used, maxGameCalls: (3 - used) * 20,
        maxGameCompletionTokens: (3 - used) * 20 * 512, maxSponsorRewardsRaw: String((3 - used) * 100000), fundingPerWalletRaw: "1000000",
        ownCashDepositRaw: "20000", fixedTaskPriceRaw: "120000", allowCredit: false, rewardTaskCreditPolicy: "4096 token award; actual usage; Unknown never retried",
        supplierCosts: "Game and reward-credit calls use official Moonshot through system HTTPS proxy; cash task uses existing Magpie. Costs are separate from protocol prices.", taskIds: ["7", "8"] } };
    for (const label of ["cash", "credits"]) state.actors[label] = { create: { requestId: randomUUID(), name: `Tempo GameFi ${label}`, modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: false } };
    await save(); await atomicJson(join(output, "budget.json"), state.budget);
  }
  assert.equal(state.runtime, runtime); assert.equal(state.owner, owner.address);
  let cookie = "";
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method: body ? "POST" : "GET", headers: { origin: ready.frontendOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path.endsWith("/finance") ? 150000 : 20000) });
    const result = await response.json(); assert.ok(response.ok, `HOSTED_HTTP_${response.status}:${result.error?.code ?? result.error ?? "unknown"}`);
    if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0]; return result;
  };
  const challenge = await api("/auth/challenge", { wallet: owner.address });
  assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 42431\nNonce: `));
  assert.ok(challenge.message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
  await api("/auth/login", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
  const wait = async (requestId: string) => {
    const deadline = Date.now() + 900000; let last = "";
    while (Date.now() < deadline) {
      const snapshot = await api("/agents"), run = snapshot.runs.find((row: any) => row.requestId === requestId);
      if (run && run.status !== last) { console.log(JSON.stringify({ requestId, status: run.status, reason: run.reason })); last = run.status; }
      if (run && !["Queued", "Running"].includes(run.status)) return run;
      await new Promise(done => setTimeout(done, 2000));
    }
    throw new Error("GAMEFI_WAIT_TIMEOUT_RECOVER_ORIGINAL_UUID");
  };
  const run = async (label: string, actor: any, action: string, extra = {}) => {
    state.runs[label] ??= { input: { action, requestId: randomUUID(), ...extra }, hostedAgentId: actor.agent.id }; await save();
    const entry = state.runs[label];
    if (entry.result && ["Succeeded", "Failed"].includes(entry.result.status)) return entry.result;
    if (entry.result?.status === "Paused" && action === "game") {
      let hand: any; try { hand = await read(join(runtime, "hosted/agents", actor.agent.id, "runs", entry.input.requestId, "game/session.json")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      assert.ok(hand?.phase === "Complete" && hand.turns.every((turn: any) => turn.outcome === "Applied"), "Only a verified completed hand may recover its remaining chain award; missing or Unknown evidence never redispatches");
    }
    if (entry.result) (entry.observations ??= []).push(entry.result);
    await api(`/agents/${actor.agent.id}/runs`, entry.input); entry.result = await wait(entry.input.requestId); await save(); return entry.result;
  };
  const token = new Contract(TEMPO_PATH_USD, ["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"], connection.provider);
  if (mode === "prepare") {
    assert.equal(BigInt(await connection.provider.send("eth_chainId", [])), 42431n);
    const escrow = new Contract(bootstrap.contracts.escrow, ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], connection.provider);
    if (!state.preflight) {
      const tasks = [];
      for (const taskId of state.budget.taskIds) { const task = await escrow.getTask(taskId); assert.equal(task.status, 1n); assert.ok(task.deadline > BigInt(Math.floor(Date.now() / 1000) + 3600)); tasks.push({ taskId, deadline: String(task.deadline), status: Number(task.status) }); }
      state.preflight = { chainId: "42431", tasks, observedAt: new Date().toISOString() }; await save();
    }
    for (const label of ["cash", "credits"]) {
      const actor = state.actors[label]; actor.agent ??= await api("/agents", actor.create); await save();
      if (!actor.funding) {
        const fundingDirectory = join(output, "funding", label); await mkdir(fundingDirectory, { recursive: true, mode: 0o700 });
        const sponsor = new Wallet((await readFile(bootstrap.roleKeyFiles.sponsor, "utf8")).trim(), connection.provider);
        const operator = new SessionStore<any>(join(runtime, "wallets/operator", sponsor.address.toLowerCase())); await operator.start(true);
        try {
          const active = await operator.read(); assert.ok(!active?.directory || active.directory === fundingDirectory, "Preserve pending operator nonce guard");
          await operator.write({ directory: fundingDirectory });
          const journal = new DemoJournal(connection.provider, join(fundingDirectory, "transactions.json")); await journal.load();
          if (!journal.has("fund")) { assert.equal(await token.balanceOf(actor.agent.wallet), 0n); assert.ok(await token.balanceOf(sponsor.address) > 1000000n);
            await journal.send("fund", sponsor, { ...(await token.getFunction("transfer").populateTransaction(actor.agent.wallet, 1000000n)), maxFeePerGas: BigInt(bootstrap.maxFeePerGas), maxPriorityFeePerGas: 1n }); }
          const receipt = await journal.receipt("fund"); assert.equal((await connection.provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash);
          assertGameAwardEvent(receipt, { role: "reward", contract: TEMPO_PATH_USD, sender: sponsor.address, recipient: actor.agent.wallet, agentId: "1", amount: 1000000n });
          await atomicJson(join(fundingDirectory, "receipt.json"), receipt.toJSON()); await operator.write({});
          actor.funding = { amountRaw: "1000000", txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, sender: sponsor.address, recipient: actor.agent.wallet }; await save();
        } finally { await operator.close(); }
      }
      let provision = await wait(actor.create.requestId);
      if (provision.status === "Paused") { await api(`/agents/${actor.agent.id}/runs`, { action: "provision", requestId: actor.create.requestId }); provision = await wait(actor.create.requestId); }
      assert.equal(provision.status, "Succeeded"); actor.provision = provision;
      const snapshot = await api("/agents"); actor.agent = snapshot.agents.find((row: any) => row.id === actor.agent.id); await save();
      if (label === "cash") assert.equal((await run("own-cash-deposit", actor, "deposit", { amountRaw: "20000" })).status, "Succeeded");
      if (actor.financeBefore?.status !== "confirmed") {
        if (actor.financeBefore) (actor.financeBeforeObservations ??= []).push(actor.financeBefore);
        actor.financeBefore = await api(`/agents/${actor.agent.id}/finance`); await save();
      }
      assert.equal(actor.financeBefore.status, "confirmed"); assert.equal(actor.financeBefore.cashRaw, label === "cash" ? "20000" : "0"); assert.equal(actor.financeBefore.debtRaw, "0");
    }
  } else if (mode.startsWith("game-")) {
    const label = mode.includes("cash") ? "cash" : "credits", actor = state.actors[label]; assert.ok(actor.financeBefore);
    const count = Object.values(state.runs).filter((entry: any) => entry.input.action === "game").length;
    assert.ok(state.runs[mode] || count < state.budget.maxNewGames, "Fixed owner game budget exhausted");
    const result = await run(mode, actor, "game", { rewardKind: label === "cash" ? "usdc" : "llm-credits" });
    console.log(JSON.stringify({ label, result })); if (result.status !== "Succeeded") process.exitCode = 1;
  } else if (mode === "cash-task" || mode === "reward-task") {
    const label = mode === "cash-task" ? "cash" : "credits", actor = state.actors[label]; assert.ok(actor.financeBefore);
    const finance = await api(`/agents/${actor.agent.id}/finance`); assert.equal(finance.status, "confirmed"); assert.equal(finance.debtRaw, "0");
    if (label === "cash") assert.ok(BigInt(finance.cashRaw) >= 120000n, "Own cash plus actual reward insufficient; never top up to force acceptance");
    const result = await run(mode, actor, label === "cash" ? "task" : "reward-task"); console.log(JSON.stringify({ label, result })); if (result.status !== "Succeeded") process.exitCode = 1;
  } else if (mode === "finance") {
    for (const label of ["cash", "credits"]) { const actor = state.actors[label]; actor.financeAfter = await api(`/agents/${actor.agent.id}/finance`); await save(); console.log(JSON.stringify({ label, finance: actor.financeAfter })); }
  } else {
    for (const actor of Object.values(state.actors) as any[]) assert.equal(actor.financeAfter?.status, "confirmed");
    const gameConfig = await read(join(runtime, "game.json")), database = await read(join(runtime, "hosted/database/session.json"));
    const gatewayFile = bootstrap.gatewayReadyFile, gateway = await read(gatewayFile);
    const directSnapshot = async () => {
      const files: Record<string, string> = {}; let gameCalls = 0, creditCalls = 0;
      for (const hostedRun of database.runs.filter((row: any) => row.action === "game")) {
        const path = join(runtime, "hosted/agents", hostedRun.agentId, "runs", hostedRun.requestId, "game/session.json");
        const raw = await readFile(path, "utf8"); const hand = JSON.parse(raw); files[`game:${hostedRun.requestId}`] = digest(raw); gameCalls += hand.turns.length;
      }
      for (const name of await readdir(gameConfig.creditsDirectory)) {
        const path = join(gameConfig.creditsDirectory, name, "session.json");
        try { const raw = await readFile(path, "utf8"); files[`credits:${name}`] = digest(raw); creditCalls += JSON.parse(raw).redemptions.length; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return { gameCalls, creditCalls, files };
    };
    const gatewaySnapshot = async () => {
      const response = await fetch(gateway.bridgeHealthUrl, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200);
      const health = await response.json(); assert.equal(health.ready, true);
      const raw = await readFile(join(resolve(gatewayFile, ".."), "attempts.jsonl"), "utf8");
      const attempts = raw.trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
      return { acceptedRequests: health.acceptedRequests, physicalCalls: attempts.filter(row => row.phase === "DispatchIntent").length,
        journalRecords: attempts.length, journalDigest: digest(raw) };
    };
    const roleAddresses = await Promise.all(Object.values(bootstrap.roleKeyFiles as Record<string, string>).map(async file => new Wallet((await readFile(file, "utf8")).trim()).address));
    const addresses = [...new Map([...database.agents.map((actor: any) => actor.wallet), gameConfig.opponent.binding.wallet, ...roleAddresses].map(address => [address.toLowerCase(), address])).values()] as string[];
    const nonces = async () => Promise.all(addresses.map(async address => ({ address, latest: await connection.provider.getTransactionCount(address, "latest"), pending: await connection.provider.getTransactionCount(address, "pending") })));
    const before = { nonces: await nonces(), direct: await directSnapshot(), magpie: await gatewaySnapshot() };
    const originals = [...Object.values(state.runs) as any[], ...Object.values(state.actors).map((actor: any) => ({ input: { action: "provision", requestId: actor.create.requestId }, hostedAgentId: actor.agent.id, result: actor.provision }))];
    for (const entry of originals) {
      assert.ok(["Succeeded", "Failed"].includes(entry.result?.status) && entry.result.result?.terminal, "Replay only an actual terminal original UUID");
      const replay = await api(`/agents/${entry.hostedAgentId}/runs`, entry.input);
      assert.equal(replay.status, entry.result.status); assert.deepEqual(replay.result, entry.result.result);
    }
    const after = { nonces: await nonces(), direct: await directSnapshot(), magpie: await gatewaySnapshot() };
    assert.deepEqual(after, before, "Terminal replay must produce no transaction or physical model call in either routing domain");
    state.replay = { observedAt: new Date().toISOString(), noNewTransactions: true, noNewModelRequests: true, originalRequestIds: originals.map(entry => entry.input.requestId), before, after }; await save();
    const games = [];
    for (const [label, entry] of Object.entries(state.runs) as [string, any][]) {
      if (entry.input.action !== "game") continue;
      const directory = join(runtime, "hosted/agents", entry.hostedAgentId, "runs", entry.input.requestId);
      const raw = await readFile(join(directory, "game/session.json"), "utf8"), hand: LiveHandSession = JSON.parse(raw), modelTurns = [];
      const replay = replayHand({ ...hand.replay, actions: [] });
      for (const turn of hand.turns) {
        assert.equal(turn.requestDigest, digest(JSON.stringify(turn.request)));
        const view = replay.view(turn.seat); assert.deepEqual(JSON.parse(turn.request.messages[1].content), view);
        const response = turn.response ? JSON.parse(turn.response.rawText) : undefined;
        if (turn.outcome === "Applied") { assert.equal(response.model, turn.request.model); assert.deepEqual(parseLegalDecision(response.choices[0].message.content, view), turn.action); replay.act(turn.seat, turn.action!); }
        else if (turn.outcome === "ResponseInvalid") assert.throws(() => parseLegalDecision(response?.choices?.[0]?.message?.content, view));
        modelTurns.push({ turn: turn.turn, seat: turn.seat, outcome: turn.outcome, requestedModel: turn.request.model, responseModel: response?.model,
          requestDigest: turn.requestDigest, responseDigest: turn.response ? digest(turn.response.rawText) : undefined, httpStatus: turn.response?.httpStatus, usage: response?.usage, durationMs: turn.durationMs });
      }
      assert.deepEqual(replay.exportTrustedReplay().actions, hand.replay.actions);
      const awardState = await read(join(directory, "session.json")), receipts = [];
      for (const file of await readdir(directory)) if (/^receipt-[01]-(reward|approve|deposit)\.json$/.test(file)) receipts.push({ role: file.slice(0, -5), receipt: await read(join(directory, file)) });
      games.push({ label, requestId: entry.input.requestId, hostedAgentId: entry.hostedAgentId, hostedResult: entry.result, privateSessionDigest: digest(raw), replayDigest: digest(JSON.stringify(replay.exportTrustedReplay())),
        hand: publicLiveHand(hand), modelTurns, award: awardState.award, receipts });
    }
    const creditLedgers = [];
    for (const actor of Object.values(state.actors) as any[]) {
      try { const ledger = await read(join(gameConfig.creditsDirectory, actor.agent.id, "session.json"));
        creditLedgers.push({ hostedAgentId: actor.agent.id, policy: ledger.policy, accounts: ledger.accounts, grants: ledger.grants,
          redemptions: ledger.redemptions.map(({ request: _request, response: _response, content: _content, ...safe }: any) => safe) }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const completionTokens = games.flatMap(game => game.modelTurns).reduce((sum, row) => sum + (row.usage?.completion_tokens ?? 0), 0);
    assert.ok(games.length <= state.budget.maxNewGames && before.direct.gameCalls <= state.budget.maxGameCalls && completionTokens <= state.budget.maxGameCompletionTokens);
    const evidence = { version: 1, observedAt: new Date().toISOString(), chainId: "42431", asset: TEMPO_PATH_USD, budget: state.budget,
      actualOwnerGames: Object.entries(database.sponsoredOwners).find(([wallet]) => wallet.toLowerCase() === owner.address.toLowerCase())?.[1], actors: state.actors, runs: state.runs, games, creditLedgers, replay: state.replay,
      modelRouting: { gameAndRewardCredits: "official Moonshot via system HTTPS proxy, separate durable intent/response journals", cashTasks: "existing Magpie gateway" },
      outcome: { cashRewardToActorRaw: games.filter(game => game.label.includes("cash")).reduce((sum, game) => sum + BigInt(game.hostedResult.result?.rewardRaw ?? 0), 0n).toString(),
        creditsGrantedToActor: games.reduce((sum, game) => sum + (game.hostedResult.result?.creditsGranted ?? 0), 0), completionTokens,
        cashTaskStarted: !!state.runs["cash-task"], rewardTaskStarted: !!state.runs["reward-task"], acceptedEndToEnd: false,
        reason: "No tested actor won a reward within the original three-game quota; cash guard prevented a task and reward credit consumption was not attempted." } };
    const publicDirectory = resolve("docs/evidence/tempo-gamefi-20261013");
    await atomicJson(join(publicDirectory, "financial-evidence.json"), evidence);
    await atomicJson(join(publicDirectory, "practice-evidence.json"), await read(join(output, "../practice-acceptance/public-evidence.json")));
    console.log(JSON.stringify({ evidence: join(publicDirectory, "financial-evidence.json"), games: games.length, directCalls: before.direct.gameCalls, magpieCalls: before.magpie.physicalCalls, replay: true, acceptedEndToEnd: false }));
  }
  console.log(JSON.stringify({ mode, journal: journalFile, actors: Object.fromEntries(Object.entries(state.actors).map(([label, value]: [string, any]) => [label, { id: value.agent?.id, binding: value.agent?.binding }])) }));
} finally { connection.close(); await lock.close(); }
