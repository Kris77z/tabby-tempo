import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Wallet } from "ethers";
import { fundMonadHostedWallet } from "./monad-hosted-funding.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";
import { atomicJson } from "../services/arena/src/protocol.js";

// Explicit, bounded paid-model acceptance. All browser-facing requests pass through Next.
// Persistent UUIDs prevent a process restart from buying another inference package.
const directory = resolve(process.argv[2] ?? "");
const mode = process.argv[3];
if (!process.argv[2] || !["prepare", "continue", "completion-prepare", "cheap", "strong", "autonomy", "evidence"].includes(mode)) throw new Error("Usage: monad-hosted-acceptance.ts RUNTIME prepare|continue|completion-prepare|cheap|strong|autonomy|evidence");
const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
assert.equal(ready.chainId, "10143"); assert.equal(ready.frontendOrigin, "http://127.0.0.1:3024");
const journalFile = join(directory, "acceptance.json");
let journal: any;
try { journal = JSON.parse(await readFile(journalFile, "utf8")); }
catch (e: any) { if (e.code !== "ENOENT") throw e; journal = { version: 1, agents: {}, runs: {}, startedAt: new Date().toISOString() }; }
const save = () => atomicJson(journalFile, journal);
const gatewayAttempts = resolve("demo-output/local-hosted-20261012/gateway/attempts.jsonl");
async function attempts() {
  const content = await readFile(gatewayAttempts, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return content.trim() ? content.trim().split("\n").map(line => JSON.parse(line)) : [];
}
async function gatewayHealth() {
  const response = await fetch("http://127.0.0.1:3427/health", { signal: AbortSignal.timeout(10000) });
  assert.equal(response.ok, true, "Gateway health is required to record paid-call boundaries");
  const health = await response.json(); assert.equal(health.ready, true); assert.ok(Number.isSafeInteger(health.acceptedRequests)); return health;
}
let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method, headers: {
    origin: ready.frontendOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.endsWith("/finance") ? 60000 : 20000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0];
  return data;
}
const owner = new Wallet((await readFile(join(directory, "owner.key"), "utf8")).trim());
const challenge = await api("/auth/challenge", "POST", { wallet: owner.address });
assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 10143\nNonce: `));
assert.ok(challenge.message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
await api("/auth/login", "POST", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
async function wait(requestId: string) {
  const deadline = Date.now() + 660000; let last = "";
  while (Date.now() < deadline) {
    const snapshot = await api("/agents"); const run = snapshot.runs.find((r: any) => r.requestId === requestId);
    if (run && run.status !== last) { console.log(JSON.stringify({ requestId, action: run.action, status: run.status, reason: run.reason })); last = run.status; }
    if (run && !["Queued", "Running"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`MONAD_WAIT_TIMEOUT:${requestId}; inspect original request, do not create replacement UUID`);
}
async function run(label: string, agentId: string, action: string, extra = {}) {
  journal.runs[label] ??= { input: { action, requestId: randomUUID(), ...extra } }; await save();
  const entry = journal.runs[label];
  const cachedDecisionRecovery = action === "autonomous" && entry.result?.status === "Failed" && entry.result?.reason === "AUTONOMY_INVALID_DECISION";
  if (entry.result && entry.result.status !== "Paused" && !cachedDecisionRecovery) { assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result; }
  if (cachedDecisionRecovery) { entry.beforeCachedDecisionRecovery ??= entry.result; await save(); }
  await api(`/agents/${agentId}/runs`, "POST", entry.input);
  entry.result = await wait(entry.input.requestId); await save();
  assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result;
}
if (mode === "prepare") {
  if (!journal.gatewayBefore) { journal.gatewayBefore = await gatewayHealth(); journal.gatewayAttemptOffset = (await attempts()).length; await save(); }
  assert.ok(Number.isSafeInteger(journal.gatewayAttemptOffset), "Paid-call baseline needs its original attempts line offset");
  const actors = [["cheap", "kimi-k2.6", "40000"], ["strong", "kimi-k3", "40000"], ["autonomy", "kimi-k2.6", "50000"]];
  for (const [label, modelId, raw] of actors) {
    journal.agents[label] ??= { create: { requestId: randomUUID(), name: `Monad real ${label}`, modelId, strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: true } }; await save();
    const entry = journal.agents[label];
    entry.agent ??= await api("/agents", "POST", entry.create); await save();
    let provision = await wait(entry.create.requestId);
    if (!entry.funded) {
      // Funding owns its durable transfer journal and confirms/replays the original transfer.
      await fundMonadHostedWallet(directory, label, entry.agent.wallet, raw); entry.funded = true; await save();
    }
    if (provision.status === "Paused") {
      await api(`/agents/${entry.agent.id}/runs`, "POST", { action: "provision", requestId: entry.create.requestId });
      provision = await wait(entry.create.requestId);
    }
    assert.equal(provision.status, "Succeeded", JSON.stringify(provision));
    await run(`${label}-deposit`, entry.agent.id, "deposit", { amountRaw: raw });
    if (entry.financeBefore?.status !== "confirmed") entry.financeBefore = await api(`/agents/${entry.agent.id}/finance`);
    await save();
    console.log(JSON.stringify({ label, financeStatus: entry.financeBefore.status, reason: entry.financeBefore.reason }));
  }
  for (const [label] of actors) { const finance = journal.agents[label].financeBefore; assert.equal(finance.status, "confirmed", `${label}:${finance.reason}`); assert.equal(finance.chainId, "10143"); }
} else if (mode === "continue") {
  const id = journal.agents.autonomy.agent.id;
  if (!journal.runs["autonomy-aborted"]) {
    const snapshot = await api("/agents"), original = snapshot.runs.find((r: any) => r.requestId === journal.runs.autonomy.input.requestId);
    assert.equal(original?.status, "Failed"); assert.equal(original.result.chargedRaw, "10000"); assert.equal(original.result.refundedRaw, "130000");
    assert.equal(original.result.autonomousTasks, 0);
    journal.runs["autonomy-aborted"] = { ...journal.runs.autonomy, previousResult: journal.runs.autonomy.result, result: original };
    delete journal.runs.autonomy; await save();
  }
  await run("autonomy-continuation-deposit", id, "deposit", { amountRaw: "10000" });
  journal.agents.autonomy.continuationBefore = await api(`/agents/${id}/finance`); await save();
  assert.equal(journal.agents.autonomy.continuationBefore.status, "confirmed");
  assert.equal(journal.agents.autonomy.continuationBefore.cashRaw, "50000"); assert.equal(journal.agents.autonomy.continuationBefore.debtRaw, "0");
  journal.runs.autonomy ??= { input: { action: "autonomous", requestId: randomUUID() } }; await save();
  console.log(JSON.stringify({ prepared: true, originalRequestId: journal.runs["autonomy-aborted"].input.requestId, nextRequestId: journal.runs.autonomy.input.requestId }));
} else if (mode === "completion-prepare") {
  const id = journal.agents.autonomy.agent.id;
  if (!journal.runs["autonomy-single-completed"]) {
    const snapshot = await api("/agents"), original = snapshot.runs.find((r: any) => r.requestId === journal.runs.autonomy.input.requestId);
    assert.equal(original?.status, "Failed"); assert.equal(original.result.chargedRaw, "140000"); assert.equal(original.result.autonomousTasks, 1);
    journal.runs["autonomy-single-completed"] = { ...journal.runs.autonomy, result: original };
    delete journal.runs.autonomy; await save();
  }
  const snapshot = await api("/agents"), agent = snapshot.agents.find((a: any) => a.id === id);
  assert.ok(!agent.activeRequestId); assert.equal(agent.spentRaw, "150000");
  journal.completionBudget ??= { before: agent, settings: { name: agent.name, modelId: agent.modelId, strategy: agent.strategy,
    perRunBudgetRaw: agent.perRunBudgetRaw, totalBudgetRaw: "450000", allowCredit: agent.allowCredit } }; await save();
  journal.completionBudget.after = await api(`/agents/${id}`, "PATCH", journal.completionBudget.settings); await save();
  await run("autonomy-completion-deposit", id, "deposit", { amountRaw: "2000" });
  journal.agents.autonomy.completionBefore = await api(`/agents/${id}/finance`); await save();
  assert.equal(journal.agents.autonomy.completionBefore.status, "confirmed");
  assert.equal(journal.agents.autonomy.completionBefore.cashRaw, "50000"); assert.equal(journal.agents.autonomy.completionBefore.debtRaw, "0");
  journal.runs.autonomy ??= { input: { action: "autonomous", requestId: randomUUID() } }; await save();
  console.log(JSON.stringify({ prepared: true, originalRequestId: journal.runs["autonomy-single-completed"].input.requestId, nextRequestId: journal.runs.autonomy.input.requestId }));
} else if (["cheap", "strong", "autonomy"].includes(mode)) {
  assert.ok(journal.agents[mode]?.agent, "Run prepare first");
  assert.equal(journal.agents[mode].financeBefore?.status, "confirmed", "Confirmed initial finance is required before paid acceptance");
  const id = journal.agents[mode].agent.id;
  const result = await run(mode, id, mode.startsWith("autonomy") ? "autonomous" : "metered-task");
  journal.agents[mode].financeAfter = await api(`/agents/${id}/finance`); await save();
  assert.equal(journal.agents[mode].financeAfter.status, "confirmed");
  assert.equal(journal.agents[mode].financeAfter.chainId, "10143"); assert.equal(journal.agents[mode].financeAfter.debtRaw, "0");
  if (mode === "autonomy") assert.equal(result.result?.autonomousTasks, 2, "Planner stopped legitimately, but the two-task acceptance is not complete");
  console.log(JSON.stringify({ label: mode, result: journal.runs[mode].result, finance: journal.agents[mode].financeAfter }));
} else {
  const bootstrap = JSON.parse(await readFile(join(directory, "..", "bootstrap.json"), "utf8"));
  assert.equal(bootstrap.chainId, "10143");
  const connection = await monadProvider(await readRpcUrlFile(ready.rpcUrlFile ?? bootstrap.rpcUrlFile), "direct");
  const provider = connection.provider;
  try {
    const before = await gatewayHealth(), beforeAttempts = await attempts();
    assert.ok(journal.gatewayBefore && Number.isSafeInteger(journal.gatewayAttemptOffset), "Run prepare with a saved gateway baseline first");
    assert.ok(before.acceptedRequests >= journal.gatewayBefore.acceptedRequests, "Gateway restarted; reconcile original attempt baseline before declaring call counts");
    const labels = ["cheap", "strong", "autonomy"];
    const preflight = JSON.parse(await readFile(join(directory, "..", "preflight.json"), "utf8"));
    const operators = ["guardian", "verifier", "refunder"].map(role => preflight.roles.find((r: any) => r.role === role).address);
    const wallets = [...new Set([...labels.map(label => journal.agents[label].agent.wallet), ...operators])];
    const readNonces = () => Promise.all(wallets.map(async wallet => ({ wallet, latest: await provider.getTransactionCount(wallet, "latest"), pending: await provider.getTransactionCount(wallet, "pending") })));
    const nonces = await readNonces();
    for (const label of labels) {
      const entry = journal.runs[label];
      assert.equal(entry?.result?.status, "Succeeded", `${label} is not complete`);
      if (label === "autonomy") assert.equal(entry.result.result?.autonomousTasks, 2);
      else assert.equal(entry.result.result?.settlement?.passed, true);
      await api(`/agents/${journal.agents[label].agent.id}/runs`, "POST", entry.input);
      const replay = await wait(entry.input.requestId); assert.equal(replay.status, "Succeeded"); assert.deepEqual(replay.result, entry.result.result);
    }
    assert.deepEqual(await readNonces(), nonces);
    const after = await gatewayHealth(); assert.equal((await attempts()).length, beforeAttempts.length);
    assert.equal(after.acceptedRequests, before.acceptedRequests);
    journal.replay = { noNewTransactions: true, noNewModelRequests: true, checkedNonces: nonces, before, after };
    journal.snapshot = await api("/agents"); journal.completedAt = new Date().toISOString(); await save();
    const taskResults: any[] = [], ledgers: any[] = [], decisions: any[] = [];
    async function evidenceFiles(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await evidenceFiles(file);
        else if (entry.name === "session.json" && ["task-executor", "inference-ledger", "autonomy-loop"].some(kind => path.endsWith("/" + kind))) {
          const state = JSON.parse(await readFile(file, "utf8"));
          if (path.endsWith("/task-executor") && state.result?.taskId) taskResults.push(state.result);
          if (path.endsWith("/inference-ledger")) ledgers.push({ binding: state.binding, grants: state.grants, invocations: state.invocations.map((v: any) => ({ id: v.id, modelId: v.modelId, state: v.state, usage: v.result?.usage, chargedCredits: v.result?.chargedCredits })) });
          if (path.endsWith("/autonomy-loop")) decisions.push({ sessionId: state.config.sessionId, phase: state.phase, chargedRaw: state.chargedRaw, completedTasks: state.completedTasks, steps: state.steps });
        }
      }
    }
    for (const label of labels) await evidenceFiles(join(directory, "hosted", "agents", journal.agents[label].agent.id));
    const publicDirectory = resolve("frontend/acceptance/monad-hosted-20261012"); await mkdir(publicDirectory, { recursive: true });
    const calls = beforeAttempts.slice(journal.gatewayAttemptOffset);
    const completed = taskResults.filter(result => result.success && result.settlement?.passed), terminated = taskResults.filter(result => !result.success);
    const expectedCompleted = journal.runs["autonomy-single-completed"] ? 5 : 4;
    assert.equal(completed.length, expectedCompleted, "Include every completed task from earlier parents and the final two-task parent");
    assert.equal(new Set(completed.map(result => result.taskId)).size, expectedCompleted);
    assert.equal(terminated.length, journal.runs["autonomy-aborted"] ? 1 : 0);
    if (terminated.length) { assert.equal(terminated[0].taskId, "14"); assert.equal(terminated[0].refundedRaw, "120000"); assert.equal(terminated[0].chargedRaw, "0"); }
    assert.equal(ledgers.length, completed.length + terminated.length);
    assert.ok(calls.some(call => call.phase === "DispatchIntent" && call.model === "kimi-k2.6"));
    assert.ok(calls.some(call => call.phase === "DispatchIntent" && call.model === "kimi-k3"));
    assert.equal(ledgers.filter(ledger => ledger.invocations.length > 0 && ledger.invocations.every((invocation: any) => invocation.state === "Completed")).length, expectedCompleted);
    assert.equal(decisions.filter(decision => decision.phase === "Completed" && decision.completedTasks === 2).length, 1);
    assert.equal(decisions.length, 1 + (journal.runs["autonomy-aborted"] ? 1 : 0) + (journal.runs["autonomy-single-completed"] ? 1 : 0));
    assert.equal(calls.filter(call => call.phase === "DispatchIntent").length, before.acceptedRequests - journal.gatewayBefore.acceptedRequests, "Journal slice must match this acceptance's gateway request count");
    await writeFile(join(publicDirectory, "financial-evidence.json"), JSON.stringify({ observedAt: journal.completedAt,
      boundary: "Real Kimi K2.6/K3 via Magpie; Monad testnet 10143 with canonical ERC8004 registries and test USDC; independent local Docker Arena; local frontend/backend",
      gatewayBaseline: journal.gatewayBefore, gatewayAttemptOffset: journal.gatewayAttemptOffset, acceptedModelRequests: before.acceptedRequests - journal.gatewayBefore.acceptedRequests,
      replay: journal.replay, agents: journal.agents, runs: journal.runs, taskResults, ledgers, decisions, vendorCalls: calls }, null, 2));
    console.log(JSON.stringify({ replay: journal.replay, runs: Object.keys(journal.runs) }));
  } finally { connection.close(); }
}
