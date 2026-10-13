import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, open, rename, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { Contract, Wallet } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { atomicJson, digest } from "../services/arena/src/protocol.js";
import { publicLiveHand, type LiveHandSession } from "../services/arena/src/holdem/live.js";
import { TEMPO_PATH_USD } from "./tempo-config.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { loadHostedDaemonConfig } from "./hosted-agents.js";
import { loadTestSponsorship, assertTestSponsorshipActor, type TestSponsorshipGrant } from "../services/hosted-agents/src/test-sponsorship.js";

const [runtimeArg, directoryArg, mode] = process.argv.slice(2);
assert.ok(runtimeArg && directoryArg && ["prepare", "enable", "run", "finance", "evidence"].includes(mode), "Usage: tempo-gamefi-additional-acceptance.ts RUNTIME DIRECTORY MODE [--recover]");
const runtime = resolve(runtimeArg), directory = resolve(directoryArg), read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const writer = new SessionStore(join(directory, "writer")); await writer.start(process.argv.includes("--recover"));
const ready = await read(join(runtime, "ready.json")), bootstrap = await read(ready.bootstrapFile), gameConfig = await read(join(runtime, "game.json"));
assert.equal(ready.chainId, "42431"); assert.equal(bootstrap.asset.address.toLowerCase(), TEMPO_PATH_USD.toLowerCase());
const connection = await chainRpcProvider(await readRpcUrlFile(bootstrap.rpcUrlFile), "42431", bootstrap.rpcTransport);
const owner = new Wallet((await readFile(join(runtime, "owner.key"), "utf8")).trim()), file = join(directory, "acceptance.json");
let state: any;
try { state = await read(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const save = () => atomicJson(file, state);
const source = resolve(runtime, "../../tempo-gamefi-20261013/acceptance/acceptance.json");
let cookie = "";
const api = async (path: string, body?: unknown) => {
  const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method: body ? "POST" : "GET", headers: { origin: ready.frontendOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path.endsWith("/finance") ? 150000 : 20000) });
  const value = await response.json(); assert.ok(response.ok, `HOSTED_HTTP_${response.status}:${value.error ?? "unknown"}`);
  if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0]; return value;
};
const login = async () => {
  const challenge = await api("/auth/challenge", { wallet: owner.address });
  assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 42431\nNonce: `));
  assert.ok(challenge.message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
  await api("/auth/login", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
};
const wait = async (requestId: string) => {
  const deadline = Date.now() + 900000; let last = "";
  while (Date.now() < deadline) { const snapshot = await api("/agents"), result = snapshot.runs.find((row: any) => row.requestId === requestId);
    if (result?.status !== last) { console.log(JSON.stringify({ requestId, status: result?.status, reason: result?.reason })); last = result?.status; }
    if (result && !["Queued", "Running"].includes(result.status)) return result;
    await new Promise(done => setTimeout(done, 2000)); }
  throw new Error("ADDITIONAL_WAIT_TIMEOUT_ORIGINAL_UUID_ONLY");
};
const counters = async () => {
  const gatewayFile = bootstrap.gatewayReadyFile, gateway = await read(gatewayFile), health = await fetch(gateway.bridgeHealthUrl, { signal: AbortSignal.timeout(10000) }); assert.equal(health.status, 200);
  const attemptsRaw = await readFile(join(dirname(gatewayFile), "attempts.jsonl"), "utf8"), attempts = attemptsRaw.trim().split("\n").filter(Boolean).map(row => JSON.parse(row));
  const database = await read(join(runtime, "hosted/database/session.json")); let directGame = 0, rewardCredit = 0; const files: Record<string, string> = {};
  for (const run of database.runs.filter((row: any) => row.action === "game")) {
    try { const raw = await readFile(join(runtime, "hosted/agents", run.agentId, "runs", run.requestId, "game/session.json"), "utf8"); files[run.requestId] = digest(raw); directGame += JSON.parse(raw).turns.length; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const actor of database.agents) {
    try { const raw = await readFile(join(gameConfig.creditsDirectory, actor.id, "session.json"), "utf8"); files[`credits:${actor.id}`] = digest(raw); rewardCredit += JSON.parse(raw).redemptions.length; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { magpie: { acceptedRequests: (await health.json()).acceptedRequests, physicalCalls: attempts.filter(row => row.phase === "DispatchIntent").length, records: attempts.length, journalDigest: digest(attemptsRaw) }, direct: { game: directGame, rewardCredit, files } };
};
const nonces = async () => {
  const db = await read(join(runtime, "hosted/database/session.json"));
  const roles = await Promise.all(Object.values(bootstrap.roleKeyFiles as Record<string, string>).map(async path => new Wallet((await readFile(path, "utf8")).trim()).address));
  const addresses = [...new Map([...db.agents.map((actor: any) => actor.wallet), gameConfig.opponent.binding.wallet, ...roles].map(address => [address.toLowerCase(), address])).values()] as string[];
  return Promise.all(addresses.map(async address => ({ address, latest: await connection.provider.getTransactionCount(address, "latest"), pending: await connection.provider.getTransactionCount(address, "pending") })));
};
const run = async (entry: any) => {
  if (entry.result && ["Succeeded", "Failed"].includes(entry.result.status)) return entry.result;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (entry.result?.status === "Paused") {
      if (/UNKNOWN/i.test(entry.result.reason ?? "")) throw new Error("ADDITIONAL_UNKNOWN_NO_REDISPATCH");
      if (entry.input.action === "game") {
        const hand = await read(join(runtime, "hosted/agents", entry.hostedAgentId, "runs", entry.input.requestId, "game/session.json")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (hand) assert.ok(hand.phase === "Complete" && hand.turns.every((turn: any) => turn.outcome === "Applied"), "Only completed hand can resume its remaining award");
        else assert.ok(/TIMEOUT|UNCERTAIN|UNCONFIRMED|NETWORK|ECONNRESET/.test(entry.result.reason ?? ""), "No persisted model intent and an identified network failure required");
      }
      (entry.observations ??= []).push(entry.result);
      if (entry.result.reason === "INFERENCE_FUNDING_REQUIRED") { entry.fundingResumes = (entry.fundingResumes ?? 0) + 1; assert.ok(entry.fundingResumes <= 6); }
      else { entry.recoveries = (entry.recoveries ?? 0) + 1; assert.ok(entry.recoveries <= 2, "Bounded original UUID network recovery"); }
      await save();
    }
    await api(`/agents/${entry.hostedAgentId}/runs`, entry.input); entry.result = await wait(entry.input.requestId); await save();
    if (entry.result.status !== "Paused" || entry.result.reason === "INFERENCE_FUNDING_REQUIRED") return entry.result;
  }
  throw new Error("ADDITIONAL_ORIGINAL_UUID_RECOVERY_BOUND");
};
const newGameUsage = async (allowUnknown = false) => {
  const result = { calls: 0, completionTokens: 0, cashRewardsRaw: 0n, unknownCalls: 0, usageUnavailableCalls: 0 };
  for (const entry of state.games) {
    const hand = await read(join(runtime, "hosted/agents", entry.hostedAgentId, "runs", entry.input.requestId, "game/session.json")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!hand) continue;
    result.calls += hand.turns.length;
    for (const turn of hand.turns) {
      if (["IntentPersisted", "OutcomeUnknown"].includes(turn.outcome)) result.unknownCalls++;
      let usage: any; try { usage = turn.response ? JSON.parse(turn.response.rawText)?.usage : undefined; } catch { /* retain missing supplier usage */ }
      if (Number.isSafeInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) result.completionTokens += usage.completion_tokens;
      else result.usageUnavailableCalls++;
    }
    if (entry.input.rewardKind === "usdc" && hand.phase === "Complete") result.cashRewardsRaw += 100000n;
    assert.ok(allowUnknown || result.unknownCalls === 0, "Unknown stops the authorized round");
  }
  assert.ok(state.games.length <= 6 && result.calls <= 120 && result.completionTokens <= 61440 && result.cashRewardsRaw <= 600000n); return result;
};
try {
  if (!state) {
    assert.equal(mode, "prepare"); const raw = await readFile(source, "utf8"), original = JSON.parse(raw);
    assert.equal(original.owner, owner.address); assert.equal(original.runtime, runtime);
    assert.equal(original.actors.cash.agent.binding.agentId, "73"); assert.equal(original.actors.credits.agent.binding.agentId, "74");
    const issuedAtMs = Date.now();
    const grant: TestSponsorshipGrant = { version: 1, id: randomUUID(), chainId: "42431", origin: ready.frontendOrigin, asset: TEMPO_PATH_USD, owner: owner.address,
      issuedAtMs, expiresAtMs: issuedAtMs + 21600000, baselineGames: 3, maxAdditionalGames: 6, maxGameCalls: 120, maxGameCompletionTokens: 61440, maxCashRewardsRaw: "600000",
      actors: ["cash", "credits"].map(label => ({ hostedAgentId: original.actors[label].agent.id, registryId: original.actors[label].agent.binding.agentId, wallet: original.actors[label].agent.wallet, rewardKind: label === "cash" ? "usdc" : "llm-credits" })) };
    state = { version: 1, runtime, owner: owner.address, sourceDigest: digest(raw), grant, authorizationFile: join(directory, "authorization/session.json"), actors: original.actors, games: [], tasks: {}, branches: {}, nextBranch: "cash" }; await save();
    const authorization = new SessionStore<TestSponsorshipGrant>(join(directory, "authorization")); await authorization.start(); try { await authorization.write(grant); } finally { await authorization.close(); }
  }
  assert.equal(state.runtime, runtime); assert.equal(state.owner, owner.address);
  try { await readFile(state.authorizationFile, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Recover the gap between acceptance commit and authorization file commit;
    // preserve the already saved UUID, caps and expiry byte-for-byte in shape.
    const authorization = new SessionStore<TestSponsorshipGrant>(join(directory, "authorization")); await authorization.start(process.argv.includes("--recover"));
    try { await authorization.write(state.grant); } finally { await authorization.close(); }
  }
  const config = await read(ready.hostedConfigFile), authorization = await loadTestSponsorship(state.authorizationFile, config.hosted);
  assert.deepEqual(authorization.grant, state.grant); state.authorizationDigest ??= authorization.digest; assert.equal(state.authorizationDigest, authorization.digest);
  if (mode === "prepare") {
    const db = await read(join(runtime, "hosted/database/session.json")); assert.equal(db.sponsoredOwners[owner.address], 3);
    for (const actor of state.grant.actors) assertTestSponsorshipActor(state.grant, db.agents.find((row: any) => row.id === actor.hostedAgentId));
    assert.equal(BigInt(await connection.provider.send("eth_chainId", [])), 42431n);
    const token = new Contract(TEMPO_PATH_USD, ["function decimals() view returns(uint8)", "function symbol() view returns(string)"], connection.provider); assert.equal(await token.decimals(), 6n); assert.equal(await token.symbol(), "PathUSD");
    const escrow = new Contract(bootstrap.contracts.escrow, ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], connection.provider);
    const tasks = [];
    for (const id of ["7", "8"]) { const task = await escrow.getTask(id); assert.equal(task.status, 1n); assert.ok(task.deadline > BigInt(Math.floor(Date.now() / 1000) + 3600)); tasks.push({ id, deadline: String(task.deadline), rewardRaw: String(task.reward), status: Number(task.status) }); }
    await login();
    for (const label of ["cash", "credits"]) { state.actors[label].financeBeforeExtra = await api(`/agents/${state.actors[label].agent.id}/finance`); assert.equal(state.actors[label].financeBeforeExtra.status, "confirmed"); }
    assert.equal(state.actors.cash.financeBeforeExtra.cashRaw, "20000"); assert.equal(state.actors.credits.financeBeforeExtra.cashRaw, "0");
    state.baseline = { observedAt: new Date().toISOString(), ownerGames: 3, tasks, counters: await counters(), nonces: await nonces() }; await save();
    await atomicJson(resolve("docs/evidence/tempo-gamefi-extra-20261013/authorization-evidence.json"), { grant: state.grant, digest: state.authorizationDigest, sourceDigest: state.sourceDigest, baseline: state.baseline });
  } else if (mode === "enable") {
    assert.ok(state.baseline); assert.ok(!config.hosted.testSponsorshipFile || config.hosted.testSponsorshipFile === state.authorizationFile);
    const alreadyConfigured = config.hosted.testSponsorshipFile === state.authorizationFile;
    config.hosted.testSponsorshipFile = state.authorizationFile;
    const temporary = ready.hostedConfigFile + `.${randomUUID()}.extra.tmp`, fd = await open(temporary, "wx", 0o600);
    try { await fd.writeFile(JSON.stringify(config) + "\n"); await fd.sync(); } finally { await fd.close(); }
    try { await rename(temporary, ready.hostedConfigFile); const parent = await open(dirname(ready.hostedConfigFile), "r"); try { await parent.sync(); } finally { await parent.close(); } } finally { await rm(temporary, { force: true }); }
    await loadHostedDaemonConfig(ready.hostedConfigFile); if (!alreadyConfigured) process.kill(ready.pid, "SIGUSR2");
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      try { const probe = await fetch(ready.hostedUrl + "/agents", { signal: AbortSignal.timeout(2000) }); if (probe.status === 401) { await login(); const snapshot = await api("/agents"); if (snapshot.sponsorship.testAuthorization?.id === state.grant.id) { state.enabledAt = new Date().toISOString(); await save(); break; } } } catch { /* short child reload gap */ }
      await new Promise(done => setTimeout(done, 500));
    }
    assert.ok(state.enabledAt, "Reload did not activate original fixed authorization");
  } else {
    await login();
    if (mode === "run") {
      assert.ok(state.enabledAt); const snapshot = await api("/agents"); assert.equal(snapshot.sponsorship.testAuthorization.id, state.grant.id);
      const tryTask = async (label: string) => {
        const actor = state.actors[label], branch = state.branches[label] ??= {};
        if (branch.finished) return;
        let grantedTotal: number | undefined;
        if (label === "credits") {
          const ledger = await read(join(gameConfig.creditsDirectory, actor.agent.id, "session.json"));
          grantedTotal = ledger.grants.reduce((sum: number, grant: any) => sum + grant.allocations[0], 0); branch.granted = grantedTotal;
          if (state.tasks[label]?.result?.reason === "INFERENCE_FUNDING_REQUIRED" && grantedTotal === branch.lastTaskGrantedTotal) return;
        }
        if (!state.tasks[label]) {
          if (label === "cash") {
            const finance = await api(`/agents/${actor.agent.id}/finance`); assert.equal(finance.status, "confirmed"); assert.equal(finance.debtRaw, "0"); branch.cashObserved = finance;
            if (BigInt(finance.cashRaw) < 120000n) { await save(); return; }
          } else {
            if (!grantedTotal) { await save(); return; }
          }
          state.tasks[label] = { hostedAgentId: actor.agent.id, input: { requestId: randomUUID(), action: label === "cash" ? "task" : "reward-task" } }; await save();
        }
        const result = await run(state.tasks[label]); if (label === "credits") branch.lastTaskGrantedTotal = grantedTotal;
        if (result.status === "Paused" && result.reason === "INFERENCE_FUNDING_REQUIRED") { branch.needsCredits = true; await save(); return; }
        branch.finished = true; branch.success = result.status === "Succeeded" && result.result?.success && result.result?.settlement?.passed; await save();
        assert.ok(["7", "8"].includes(result.result?.taskId), "Only original open GameFi tasks allowed");
      };
      try {
        // Drain a saved sixth UUID as well: the cap limits new admission, not
        // receipt/result collection or a verified completed hand's award.
        const pending = state.games.find((row: any) => !row.result || row.result.status === "Paused");
        if (pending) { const result = await run(pending); assert.ok(result.status !== "Paused"); state.nextBranch = pending.label === "cash" ? "credits" : "cash"; await save(); }
        // A crash after a winning terminal result must consume that real award
        // before admitting another game. No new task UUID for a saved branch.
        for (const label of ["cash", "credits"]) if (state.tasks[label] || state.games.some((row: any) => row.label === label && (BigInt(row.result?.result?.rewardRaw ?? 0) > 0n || (row.result?.result?.creditsGranted ?? 0) > 0))) await tryTask(label);
        while (!(state.branches.cash?.finished && state.branches.credits?.finished)) {
          if (state.games.length >= 6) break;
          await newGameUsage(); assert.ok(Date.now() < state.grant.expiresAtMs, "Fixed authorization expired");
          let label = state.nextBranch; if (state.branches[label]?.finished) label = label === "cash" ? "credits" : "cash";
          let entry = state.games.find((row: any) => !row.result || row.result.status === "Paused");
          if (entry) label = entry.label;
          else { entry = { label, hostedAgentId: state.actors[label].agent.id, input: { action: "game", requestId: randomUUID(), rewardKind: label === "cash" ? "usdc" : "llm-credits" } }; state.games.push(entry); await save(); }
          const result = await run(entry); assert.ok(result.status !== "Paused", "Unknown or unresolved game stops additional round");
          state.nextBranch = label === "cash" ? "credits" : "cash"; await save(); await newGameUsage();
          if (result.status === "Succeeded") await tryTask(label);
        }
        state.stopReason = state.branches.cash?.success && state.branches.credits?.success ? "BOTH_REWARD_TASK_PATHS_COMPLETE" : "AUTHORIZED_GAME_LIMIT_OR_TERMINAL_BRANCH";
      } catch (error) { state.stopReason = (error as Error).message; await save(); throw error; }
      state.runCompletedAt = new Date().toISOString(); await save();
    } else if (mode === "finance") {
      for (const label of ["cash", "credits"]) { state.actors[label].financeAfterExtra = await api(`/agents/${state.actors[label].agent.id}/finance`); await save(); assert.equal(state.actors[label].financeAfterExtra.status, "confirmed"); }
    } else {
      const allOriginals = [...state.games, ...Object.values(state.tasks)] as any[];
      const originals = allOriginals.filter(entry => ["Succeeded", "Failed"].includes(entry.result?.status) && entry.result.result?.terminal);
      const excludedUnresolved = allOriginals.filter(entry => !originals.includes(entry)).map(entry => ({ requestId: entry.input.requestId, status: entry.result?.status, reason: entry.result?.reason }));
      const before = { counters: await counters(), nonces: await nonces() };
      for (const entry of originals) { const replay = await api(`/agents/${entry.hostedAgentId}/runs`, entry.input); assert.equal(replay.status, entry.result.status); assert.deepEqual(replay.result, entry.result.result); }
      const after = { counters: await counters(), nonces: await nonces() }; assert.deepEqual(after, before); state.replay = { noNewTransactions: true, noNewModelRequests: true, replayedIds: originals.map(entry => entry.input.requestId), excludedUnresolved, before, after }; await save();
      const games = [], ledgers = [];
      for (const entry of state.games) {
        const path = join(runtime, "hosted/agents", entry.hostedAgentId, "runs", entry.input.requestId);
        const raw = await readFile(join(path, "game/session.json"), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (!raw) { games.push({ ...entry, hand: null, sessionMissing: true }); continue; }
        const hand: LiveHandSession = JSON.parse(raw);
        const receipts = []; for (const name of await readdir(path)) if (/^receipt-[01]-(reward|approve|deposit)\.json$/.test(name)) receipts.push({ role: name.slice(0, -5), receipt: await read(join(path, name)) });
        games.push({ ...entry, hand: publicLiveHand(hand), sessionDigest: digest(raw), modelTurns: hand.turns.map(turn => { let response: any; try { response = turn.response ? JSON.parse(turn.response.rawText) : undefined; } catch { /* publish hashes, never malformed private text */ } return { turn: turn.turn, seat: turn.seat, outcome: turn.outcome, requestDigest: turn.requestDigest, responseDigest: turn.response ? digest(turn.response.rawText) : undefined, requestedModel: turn.request.model, responseModel: response?.model, usage: response?.usage }; }), award: (await read(join(path, "session.json"))).award, receipts });
      }
      for (const actor of Object.values(state.actors) as any[]) {
        const ledger = await read(join(gameConfig.creditsDirectory, actor.agent.id, "session.json")).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
        if (ledger) ledgers.push({ hostedAgentId: actor.agent.id, grants: ledger.grants, accounts: ledger.accounts, redemptions: ledger.redemptions.map(({ request: _request, response: _response, content: _content, ...safe }: any) => safe) });
      }
      const usage = await newGameUsage(true), admission = await read(join(dirname(state.authorizationFile), "admissions/session.json"));
      assert.equal(admission.digest, state.authorizationDigest); assert.equal(admission.admissions.length, state.games.length);
      await atomicJson(resolve("docs/evidence/tempo-gamefi-extra-20261013/financial-evidence.json"), { version: 1, observedAt: new Date().toISOString(), grant: state.grant, authorizationDigest: state.authorizationDigest, sourceDigest: state.sourceDigest, baseline: state.baseline, actors: state.actors, games, tasks: state.tasks, branches: state.branches, stopReason: state.stopReason, admission, ledgers, replay: state.replay,
        gameUsage: { ...usage, cashRewardsRaw: String(usage.cashRewardsRaw) }, bothRewardTaskPathsComplete: !!state.branches.cash?.success && !!state.branches.credits?.success });
    }
  }
  console.log(JSON.stringify({ mode, journal: file, grantId: state.grant.id, expiresAt: new Date(state.grant.expiresAtMs).toISOString(), digest: state.authorizationDigest, games: state.games.length, stopReason: state.stopReason, tasks: Object.fromEntries(Object.entries(state.tasks).map(([label, entry]: [string, any]) => [label, { requestId: entry.input.requestId, status: entry.result?.status, taskId: entry.result?.result?.taskId }])) }));
} finally { connection.close(); await writer.close(); }
