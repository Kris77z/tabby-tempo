import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, Wallet } from "ethers";
import { atomicJson } from "../services/arena/src/protocol.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { TEMPO_CHAIN_ID, TEMPO_PATH_USD } from "./tempo-config.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";

// Operator-only, bounded real-model testnet acceptance. Browser-facing business
// commands pass through Next. Each original UUID is durable before dispatch.
const directory = resolve(process.argv[2] ?? ""), mode = process.argv[3];
if (!process.argv[2] || !["prepare", "prepare-validation", "cheap", "strong", "autonomy", "autonomy-next-window", "autonomy-after-compensation", "autonomy-validation", "finance", "evidence"].includes(mode)) throw new Error("Usage: tempo-hosted-acceptance.ts RUNTIME prepare|prepare-validation|cheap|strong|autonomy|autonomy-next-window|autonomy-after-compensation|autonomy-validation|finance|evidence");
const lock = new SessionStore(join(directory, "acceptance-writer")); await lock.start(process.argv.includes("--recover"));
const connection = await chainRpcProvider(await readRpcUrlFile(JSON.parse(await readFile(join(directory, "ready.json"), "utf8")).rpcUrlFile), TEMPO_CHAIN_ID, "direct");
try {
  const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
  assert.equal(ready.chainId, "42431");
  const bootstrap = JSON.parse(await readFile(ready.bootstrapFile, "utf8"));
  const gateway = JSON.parse(await readFile(bootstrap.gatewayReadyFile, "utf8"));
  const gatewayDirectory = resolve(bootstrap.gatewayReadyFile, "..");
  const journalFile = join(directory, "acceptance.json");
  let journal: any;
  try { journal = JSON.parse(await readFile(journalFile, "utf8")); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; journal = { version: 1, chainId: "42431", agents: {}, runs: {}, startedAt: new Date().toISOString() }; }
  assert.equal(journal.chainId, "42431");
  const save = () => atomicJson(journalFile, journal);
  const token = new Contract(TEMPO_PATH_USD, ["function balanceOf(address) view returns(uint256)"], connection.provider);
  const attempts = async () => {
    const raw = await readFile(join(gatewayDirectory, "attempts.jsonl"), "utf8").catch(e => { if (e.code === "ENOENT") return ""; throw e; });
    return raw.trim() ? raw.trim().split("\n").map(line => JSON.parse(line)) : [];
  };
  const health = async () => {
    const response = await fetch(gateway.bridgeHealthUrl, { signal: AbortSignal.timeout(10000) }); assert.equal(response.ok, true);
    const value = await response.json(); assert.equal(value.ready, true); assert.ok(Number.isSafeInteger(value.acceptedRequests)); return value;
  };
  let cookie = "";
  const api = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method, headers: { origin: ready.frontendOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.endsWith("/finance") ? 150000 : 20000) });
    const data = await response.json(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0]; return data;
  };
  let owner: Wallet;
  try { owner = new Wallet((await readFile(join(directory, "owner.key"), "utf8")).trim()); }
  catch (e: any) { if (e.code !== "ENOENT") throw e; owner = new Wallet(Wallet.createRandom().privateKey); await writeFile(join(directory, "owner.key"), owner.privateKey + "\n", { flag: "wx", mode: 0o600 }); }
  const challenge = await api("/auth/challenge", "POST", { wallet: owner.address });
  assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 42431\nNonce: `));
  await api("/auth/login", "POST", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
  const wait = async (requestId: string) => {
    const until = Date.now() + 900000; let last = "";
    while (Date.now() < until) {
      const snapshot = await api("/agents"), run = snapshot.runs.find((r: any) => r.requestId === requestId);
      if (run && run.status !== last) { console.log(JSON.stringify({ requestId, action: run.action, status: run.status, reason: run.reason })); last = run.status; }
      if (run && !["Queued", "Running"].includes(run.status)) return run;
      await delay(2000);
    }
    throw new Error(`TEMPO_WAIT_TIMEOUT:${requestId}; recover original UUID`);
  };
  const run = async (label: string, agentId: string, action: string, extra = {}) => {
    journal.runs[label] ??= { input: { action, requestId: randomUUID(), ...extra } }; await save();
    const entry = journal.runs[label];
    if (entry.result && !["Paused", "Queued", "Running"].includes(entry.result.status)) { assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result; }
    if (entry.result) (entry.attempts ??= []).push({ observedAt: new Date().toISOString(), result: entry.result });
    await api(`/agents/${agentId}/runs`, "POST", entry.input); entry.result = await wait(entry.input.requestId); await save();
    assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result;
  };
  const fund = async (label: string, wallet: string) => {
    const entry = journal.agents[label];
    try {
      const funding = JSON.parse(await readFile(join(directory, "operator-funding", label, "session.json"), "utf8"));
      if (funding.result) {
        assert.equal(funding.result.chainId, "42431"); assert.equal(funding.result.recipient.toLowerCase(), wallet.toLowerCase());
        assert.equal(funding.result.asset.toLowerCase(), TEMPO_PATH_USD.toLowerCase()); assert.equal(funding.result.amountRaw, "1000000");
        assert.equal(funding.result.status, 1); assert.equal(funding.result.canonical, true);
        const receipt = await connection.provider.getTransactionReceipt(funding.result.txHash);
        assert.equal(receipt?.status, 1); assert.equal(receipt?.blockHash, funding.result.blockHash);
        assert.equal((await connection.provider.getBlock(receipt!.blockNumber))?.hash, receipt!.blockHash);
        entry.operatorFunding = funding.result;
        entry.faucet.status = "Unknown"; entry.faucet.balanceObservedAt = new Date().toISOString(); entry.faucet.observedBalanceRaw = String(await token.balanceOf(wallet));
        await save(); return;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!entry.faucet) { entry.faucet = { intentAt: new Date().toISOString(), address: wallet }; await save();
      entry.faucet.hashes = await connection.provider.send("tempo_fundAddress", [wallet]); await save(); }
    const until = Date.now() + 30000;
    while (await token.balanceOf(wallet) < 1_000_000n && Date.now() < until) await delay(300);
    assert.ok(await token.balanceOf(wallet) >= 1_000_000n, "Inspect original faucet; never issue a second funding request automatically");
    if (entry.operatorFunding && !entry.faucet.hashes) {
      entry.faucet.status = "Unknown"; entry.faucet.balanceObservedAt = new Date().toISOString(); entry.faucet.observedBalanceRaw = String(await token.balanceOf(wallet));
    } else { entry.faucet.confirmedAt ??= new Date().toISOString(); entry.faucet.balanceRaw = String(await token.balanceOf(wallet)); }
    await save();
  };
  const actors = [["cheap", "kimi-k2.6", "40000"], ["strong", "kimi-k3", "40000"], ["autonomy", "kimi-k2.6", "50000"]];
  if (mode === "prepare-validation" || journal.agents["autonomy-validation"]) actors.push(["autonomy-validation", "kimi-k2.6", "50000"]);
  const updateDashboardSelection = async () => {
    if (!actors.every(([label]) => journal.agents[label]?.financeBefore?.status === "confirmed")) return;
    const selected = actors.map(([label]) => ({ id: journal.agents[label].financeBefore.agentId, name: `Tempo real ${label}` }));
    if (JSON.stringify(journal.dashboardSelection) === JSON.stringify(selected)) return;
    // Dashboard selection is excluded from execution bindings by the runtime;
    // changing these public labels cannot redirect a payment or task request.
    await atomicJson(ready.bootstrapFile, { ...bootstrap, dashboardAgents: selected });
    const manifest = JSON.parse(await readFile(ready.manifestFile, "utf8"));
    await atomicJson(ready.manifestFile, { ...manifest, agents: selected });
    journal.dashboardSelection = selected; await save();
  };
  await updateDashboardSelection();
  if (mode === "prepare" || mode === "prepare-validation") {
    journal.gatewayBefore ??= await health(); journal.gatewayAttemptOffset ??= (await attempts()).length; await save();
    if (mode === "prepare-validation") {
      assert.equal(journal.runs.autonomy?.result?.status, "Failed");
      assert.equal(journal.runs.autonomy.result.result?.autonomousTasks, 1);
      assert.equal(journal.runs.autonomy.result.result?.terminal, true);
      const snapshot = await api("/agents"), original = snapshot.agents.find((agent: any) => agent.id === journal.agents.autonomy.agent.id);
      assert.equal(original.totalBudgetRaw, "300000"); assert.equal(original.spentRaw, "150000"); assert.equal(original.reservedRaw, "0");
    }
    for (const [label, modelId, raw] of mode === "prepare-validation" ? actors.filter(([label]) => label === "autonomy-validation") : actors) {
      journal.agents[label] ??= { create: { requestId: randomUUID(), name: `Tempo real ${label}`, modelId, strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: true } }; await save();
      const entry = journal.agents[label]; entry.agent ??= await api("/agents", "POST", entry.create); await save();
      await fund(label, entry.agent.wallet);
      let provision = await wait(entry.create.requestId);
      if (provision.status === "Paused") { entry.firstProvisionPause ??= provision; await save(); await api(`/agents/${entry.agent.id}/runs`, "POST", { action: "provision", requestId: entry.create.requestId }); provision = await wait(entry.create.requestId); }
      entry.provision = provision; await save(); assert.equal(provision.status, "Succeeded", JSON.stringify(provision));
      await run(`${label}-deposit`, entry.agent.id, "deposit", { amountRaw: raw });
      if (entry.financeBefore?.status !== "confirmed") {
        if (entry.financeBefore) (entry.financeBeforeAttempts ??= []).push(entry.financeBefore);
        entry.financeBefore = await api(`/agents/${entry.agent.id}/finance`); await save();
      }
      assert.equal(entry.financeBefore.status, "confirmed", `${label}:${entry.financeBefore.reason}`); assert.equal(entry.financeBefore.chainId, "42431");
    }
    await updateDashboardSelection();
    console.log(JSON.stringify({ prepared: true, agents: actors.map(([label]) => ({ label, agentId: journal.agents[label].financeBefore.agentId, cashRaw: journal.agents[label].financeBefore.cashRaw })) }));
  } else if (["cheap", "strong", "autonomy", "autonomy-next-window", "autonomy-after-compensation", "autonomy-validation"].includes(mode)) {
    const label = mode === "autonomy-validation" ? mode : mode.startsWith("autonomy-") ? "autonomy" : mode;
    const entry = journal.agents[label]; assert.equal(entry?.financeBefore?.status, "confirmed", "Run prepare first");
    if (mode === "autonomy-next-window" && !journal.runs["autonomy-expired-window"]) {
      const original = journal.runs.autonomy;
      assert.ok(original?.input?.requestId);
      const loopFile = join(directory, "hosted", "agents", entry.agent.id, "runs", original.input.requestId, "autonomy-loop", "session.json");
      const loop = JSON.parse(await readFile(loopFile, "utf8"));
      assert.equal(loop.steps.length, 0); assert.equal(loop.startedTasks, 0); assert.equal(loop.completedTasks, 0); assert.equal(loop.chargedRaw, "0");
      assert.ok(Date.now() >= loop.config.deadlineMs, "Original window must naturally expire; never extend its budget/deadline");
      await api(`/agents/${entry.agent.id}/runs`, "POST", original.input);
      const terminal = await wait(original.input.requestId);
      assert.equal(terminal.status, "Failed"); assert.equal(terminal.result.phase, "Stopped"); assert.equal(terminal.result.reason, "AUTONOMY_DEADLINE");
      assert.equal(terminal.result.chargedRaw, "0"); assert.equal(terminal.result.autonomousTasks, 0);
      journal.runs["autonomy-expired-window"] = { ...original, originalPausedResult: original.result, result: terminal,
        window: { deadlineMs: loop.config.deadlineMs, maxTasks: loop.config.maxTasks, maxSpendRaw: loop.config.maxSpendRaw } };
      journal.runs.autonomy = { input: { action: "autonomous", requestId: randomUUID() } }; await save();
    }
    if (mode === "autonomy-after-compensation" && !journal.runs["autonomy-unknown-compensated"]) {
      const original = journal.runs.autonomy;
      assert.equal(original?.result?.reason, "UPSTREAM_DISPATCH_UNKNOWN");
      const resolutions = await readdir(join(directory, "allowance-resolution"));
      const states = await Promise.all(resolutions.map(async paymentId => JSON.parse(await readFile(join(directory, "allowance-resolution", paymentId, "session.json"), "utf8"))));
      const state = states.find(item => item.parentRequestId === original.input.requestId);
      assert.ok(state?.abortCompleted && state.abortResult?.txHash, "Unknown call must be sealed, compensated and independently terminated before a new business run");
      const snapshot = await api("/agents"), terminal = snapshot.runs.find((r: any) => r.requestId === original.input.requestId);
      assert.equal(terminal?.status, "Failed"); assert.equal(terminal.result.phase, "Stopped");
      assert.equal(terminal.result.chargedRaw, "10000"); assert.equal(terminal.result.refundedRaw, "120000");
      assert.equal(terminal.result.autonomousTasks, 0);
      const currentAgent = snapshot.agents.find((a: any) => a.id === entry.agent.id);
      assert.equal(currentAgent.totalBudgetRaw, "300000"); assert.equal(currentAgent.spentRaw, "10000"); assert.equal(currentAgent.reservedRaw, "0");
      journal.runs["autonomy-unknown-compensated"] = { ...original, originalUnknownResult: original.result, result: terminal,
        compensation: { evidence: state.evidence, evidenceDigest: state.evidenceDigest, resolutionId: state.resolutionId, refundId: state.refundId,
          closure: state.closure, refund: state.refund?.result, termination: state.abortResult }, vendorCost: "unknown, assumed by operator" };
      journal.runs.autonomy = { input: { action: "autonomous", requestId: randomUUID() } }; await save();
    }
    if (mode === "autonomy-after-compensation") {
      // Only enough extra test cash to cover a 10000 cash planner and the
      // existing 80000 task credit cap. This does not raise spending policy.
      await run("autonomy-recovery-deposit", entry.agent.id, "deposit", { amountRaw: "10000" });
    }
    const result = await run(label, entry.agent.id, label.startsWith("autonomy") ? "autonomous" : "metered-task");
    if (entry.financeAfter) (entry.financeAfterAttempts ??= []).push(entry.financeAfter);
    entry.financeAfter = await api(`/agents/${entry.agent.id}/finance`); await save();
    assert.equal(entry.financeAfter.status, "confirmed"); assert.equal(entry.financeAfter.debtRaw, "0");
    if (label.startsWith("autonomy")) assert.equal(result.result?.autonomousTasks, 2, "Legitimate early stop is retained; it does not prove two-task acceptance");
    console.log(JSON.stringify({ label, result, finance: entry.financeAfter }));
  } else if (mode === "finance") {
    for (const [label] of actors) {
      const entry = journal.agents[label]; assert.ok(entry?.agent?.id);
      if (entry.financeAfter) (entry.financeAfterAttempts ??= []).push(entry.financeAfter);
      entry.financeAfter = await api(`/agents/${entry.agent.id}/finance`); await save();
      console.log(JSON.stringify({ label, finance: entry.financeAfter }));
      assert.equal(entry.financeAfter.status, "confirmed", `${label}:${entry.financeAfter.reason}`);
    }
  } else {
    const before = await health(), beforeAttempts = await attempts();
    // Include every signing role: task settlements and operator refunds must
    // also remain unchanged when replaying a completed business UUID.
    const roleAddresses = await Promise.all(Object.values(bootstrap.roleKeyFiles as Record<string, string>).map(async file =>
      new Wallet((await readFile(file, "utf8")).trim()).address));
    const wallets = [...new Map([...actors.map(([label]) => journal.agents[label].agent.wallet), ...roleAddresses].map(address => [address.toLowerCase(), address])).values()];
    const nonces = await Promise.all(wallets.map(async address => ({ address, latest: await connection.provider.getTransactionCount(address, "latest"), pending: await connection.provider.getTransactionCount(address, "pending") })));
    for (const [label] of actors) {
      const original = journal.runs[label]?.result;
      assert.ok(original && ["Succeeded", "Failed"].includes(original.status) && original.result?.terminal);
      if (label !== "autonomy" || !journal.agents["autonomy-validation"]) assert.equal(original.status, "Succeeded");
      await api(`/agents/${journal.agents[label].agent.id}/runs`, "POST", journal.runs[label].input);
      const replay = await wait(journal.runs[label].input.requestId); assert.equal(replay.status, original.status); assert.deepEqual(replay.result, original.result);
    }
    assert.deepEqual(await Promise.all(wallets.map(async address => ({ address, latest: await connection.provider.getTransactionCount(address, "latest"), pending: await connection.provider.getTransactionCount(address, "pending") }))), nonces);
    const after = await health(); assert.equal(after.acceptedRequests, before.acceptedRequests); assert.equal((await attempts()).length, beforeAttempts.length);
    journal.replay = { noNewTransactions: true, noNewModelRequests: true, nonces, before, after };
    journal.snapshot = await api("/agents"); journal.completedAt = new Date().toISOString(); await save();
    const taskResults: any[] = [], ledgers: any[] = [], decisions: any[] = [];
    async function collect(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name); if (entry.isDirectory()) await collect(file);
      else if (entry.name === "session.json" && ["task-executor", "inference-ledger", "autonomy-loop"].some(kind => path.endsWith("/" + kind))) {
        const value = JSON.parse(await readFile(file, "utf8"));
        if (path.endsWith("/task-executor") && value.result?.taskId) taskResults.push(value.result);
        if (path.endsWith("/inference-ledger")) ledgers.push({ binding: value.binding, grants: value.grants, invocations: value.invocations.map((v: any) => ({ id: v.id, modelId: v.modelId, state: v.state, usage: v.result?.usage, chargedCredits: v.result?.chargedCredits })) });
        if (path.endsWith("/autonomy-loop")) decisions.push({ sessionId: value.config.sessionId, phase: value.phase, completedTasks: value.completedTasks, steps: value.steps, chargedRaw: value.chargedRaw });
      }
    } }
    for (const [label] of actors) await collect(join(directory, "hosted", "agents", journal.agents[label].agent.id));
    const expectedSuccesses = journal.agents["autonomy-validation"] ? 5 : 4;
    assert.equal(taskResults.filter(result => result.success && result.settlement?.passed).length, expectedSuccesses);
    if (journal.agents["autonomy-validation"]) {
      assert.equal(journal.runs["autonomy-validation"].result.status, "Succeeded");
      assert.equal(journal.runs["autonomy-validation"].result.result.autonomousTasks, 2);
      assert.equal(journal.runs.autonomy.result.result.autonomousTasks, 1);
    }
    const plannerResolutions: any[] = [];
    for (const paymentId of await readdir(join(directory, "planner-resolution")).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      const state = JSON.parse(await readFile(join(directory, "planner-resolution", paymentId, "session.json"), "utf8"));
      plannerResolutions.push({ evidence: state.evidence, evidenceDigest: state.evidenceDigest, expectedAttemptsDigest: state.expectedAttemptsDigest,
        resolutionId: state.resolutionId, refundId: state.refundId, resolution: state["resolve-undelivered"], refund: state.refund });
    }
    const publicDirectory = resolve("docs/evidence/tempo-20261012"); await mkdir(publicDirectory, { recursive: true });
    // Owner addresses, receipts and usage are public; no raw signatures, role
    // keys, gateway authentication keys or private provider responses are copied.
    await atomicJson(join(publicDirectory, "financial-evidence.json"), { observedAt: journal.completedAt, boundary: "Tempo Moderato 42431, test PathUSD, existing ERC-8004 registries with verified interfaces, real Kimi K2.6/K3 through Magpie, independent local Docker Arena, local Next/hosted backend",
      gatewayBaseline: journal.gatewayBefore, acceptedModelRequests: before.acceptedRequests - journal.gatewayBefore.acceptedRequests,
      replay: journal.replay, agents: journal.agents, runs: journal.runs, taskResults, ledgers, decisions, plannerResolutions, vendorCalls: beforeAttempts.slice(journal.gatewayAttemptOffset) });
    console.log(JSON.stringify({ evidence: join(publicDirectory, "financial-evidence.json"), modelRequests: before.acceptedRequests - journal.gatewayBefore.acceptedRequests, taskCount: taskResults.length, replay: journal.replay }));
  }
} finally { connection.close(); await lock.close(); }
