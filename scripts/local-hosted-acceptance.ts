import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Wallet, JsonRpcProvider, hexlify, randomBytes } from "ethers";
import { fundLocalWallet } from "./local-hosted.js";

// Explicit, bounded paid-model acceptance. All browser-facing requests pass through Next.
// Persistent UUIDs prevent a process restart from buying another inference package.
const directory = resolve(process.argv[2] ?? "");
const mode = process.argv[3];
if (!process.argv[2] || !["prepare", "prepare-credit", "cheap", "strong", "autonomy", "autonomy-credit", "refill-autonomy", "refund-expired-autonomy", "evidence"].includes(mode)) throw new Error("Usage: local-hosted-acceptance.ts RUNTIME prepare|prepare-credit|cheap|strong|autonomy|autonomy-credit|refill-autonomy|refund-expired-autonomy|evidence");
const ready = JSON.parse(await readFile(join(directory, "ready.json"), "utf8"));
assert.equal(ready.chainId, "31337"); assert.equal(ready.frontendOrigin, "http://127.0.0.1:3024");
const journalFile = join(directory, "acceptance.json");
let journal: any;
try { journal = JSON.parse(await readFile(journalFile, "utf8")); }
catch (e: any) { if (e.code !== "ENOENT") throw e; journal = { version: 1, agents: {}, runs: {}, startedAt: new Date().toISOString() }; }
const save = () => writeFile(journalFile, JSON.stringify(journal, null, 2), { mode: 0o600 });
let cookie = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method, headers: {
    origin: ready.frontendOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0];
  return data;
}
const owner = new Wallet((await readFile(join(directory, "owner.key"), "utf8")).trim());
const challenge = await api("/auth/challenge", "POST", { wallet: owner.address });
await api("/auth/login", "POST", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
async function wait(requestId: string) {
  const deadline = Date.now() + 660000; let last = "";
  while (Date.now() < deadline) {
    const snapshot = await api("/agents"); const run = snapshot.runs.find((r: any) => r.requestId === requestId);
    if (run && run.status !== last) { console.log(JSON.stringify({ requestId, action: run.action, status: run.status, reason: run.reason })); last = run.status; }
    if (run && !["Queued", "Running"].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`LOCAL_WAIT_TIMEOUT:${requestId}; inspect original request, do not create replacement UUID`);
}
async function run(label: string, agentId: string, action: string, extra = {}) {
  journal.runs[label] ??= { input: { action, requestId: randomUUID(), ...extra } }; await save();
  const entry = journal.runs[label];
  if (entry.result && entry.result.status !== "Paused") { assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result; }
  await api(`/agents/${agentId}/runs`, "POST", entry.input);
  entry.result = await wait(entry.input.requestId); await save();
  assert.equal(entry.result.status, "Succeeded", JSON.stringify(entry.result)); return entry.result;
}
if (["prepare", "prepare-credit"].includes(mode)) {
  const actors = mode === "prepare-credit" ? [["autonomy-credit", "kimi-k2.6", "50000"]]
    : [["cheap", "kimi-k2.6", "40000"], ["strong", "kimi-k3", "40000"], ["autonomy", "kimi-k2.6", "50000"]];
  for (const [label, modelId, raw] of actors) {
    journal.agents[label] ??= { create: { requestId: randomUUID(), name: `Local real ${label}`, modelId, strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: true } }; await save();
    const entry = journal.agents[label];
    entry.agent ??= await api("/agents", "POST", entry.create); await save();
    let provision = await wait(entry.create.requestId);
    if (!entry.funded) {
      // The faucet itself is not idempotent: an unknown funding outcome requires inspection.
      assert.notEqual(entry.fundingStarted, true, "Inspect faucet balance/receipt before retrying an interrupted mint");
      entry.fundingStarted = true; await save();
      await fundLocalWallet(directory, entry.agent.wallet, raw); entry.funded = true; await save();
    }
    if (provision.status === "Paused") {
      await api(`/agents/${entry.agent.id}/runs`, "POST", { action: "provision", requestId: entry.create.requestId });
      provision = await wait(entry.create.requestId);
    }
    assert.equal(provision.status, "Succeeded", JSON.stringify(provision));
    await run(`${label}-deposit`, entry.agent.id, "deposit", { amountRaw: raw });
    entry.financeBefore = await api(`/agents/${entry.agent.id}/finance`); await save();
  }
} else if (mode === "refund-expired-autonomy") {
  // Reconcile the one observed late, undelivered local allowance. Never refund delivered inference.
  const parent = journal.runs.autonomy, actor = journal.agents.autonomy;
  assert.ok(parent && actor); assert.ok(["PAYMENT_AFTER_EXPIRY", "REFUNDED"].includes(parent.result.reason));
  const root = join(directory, "hosted", "agents", actor.agent.id, "runs", parent.input.requestId);
  const loop = JSON.parse(await readFile(join(root, "autonomy-loop", "session.json"), "utf8"));
  const childId = loop.steps.at(-1).childId; assert.match(childId, /^[a-f0-9-]{36}$/);
  const purchase = JSON.parse(await readFile(join(root, "children", childId, "task-executor", "workflow", "metered", "allowance-purchase", "session.json"), "utf8"));
  const paymentId = purchase.handle.quote.paymentId;
  const url = new URL(purchase.config.relayUrl); assert.equal(url.hostname, "127.0.0.1");
  journal.expiredRefund ??= { paymentId, refundId: hexlify(randomBytes(32)), amount: "120000" }; await save();
  assert.equal(journal.expiredRefund.paymentId, paymentId);
  // This token is the known local workflow fixture token, never a production credential.
  const response = await fetch(url.origin + "/ops/refund", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer controlled-workflow-operator-token-32-characters" }, body: JSON.stringify({ paymentId, refundId: journal.expiredRefund.refundId, amount: journal.expiredRefund.amount }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result));
  journal.expiredRefund.result = result; await save();
  await api(`/agents/${actor.agent.id}/runs`, "POST", parent.input);
  parent.result = await wait(parent.input.requestId); actor.financeAfter = await api(`/agents/${actor.agent.id}/finance`); await save();
  assert.equal(parent.result.status, "Failed"); assert.equal(parent.result.result?.terminal, true);
  assert.equal(parent.result.result?.chargedRaw, "10000"); assert.equal(actor.financeAfter.debtRaw, "0");
  console.log(JSON.stringify({ refund: journal.expiredRefund, result: parent.result, finance: actor.financeAfter }));
} else if (mode === "refill-autonomy") {
  const entry = journal.agents.autonomy; assert.ok(entry?.agent);
  assert.equal(journal.runs.autonomy?.result?.status, "Paused");
  assert.equal(journal.runs.autonomy.result.reason, "INFERENCE_FUNDING_REQUIRED");
  if (!entry.refillFunded) {
    assert.notEqual(entry.refillStarted, true, "Inspect interrupted refill before minting again");
    entry.refillStarted = true; await save();
    await fundLocalWallet(directory, entry.agent.wallet, "80000"); entry.refillFunded = true; await save();
  }
  await run("autonomy-refill", entry.agent.id, "deposit", { amountRaw: "80000" });
} else if (["cheap", "strong", "autonomy", "autonomy-credit"].includes(mode)) {
  assert.ok(journal.agents[mode]?.agent, "Run prepare first");
  const id = journal.agents[mode].agent.id;
  const result = await run(mode, id, mode.startsWith("autonomy") ? "autonomous" : "metered-task");
  journal.agents[mode].financeAfter = await api(`/agents/${id}/finance`); await save();
  if (mode.startsWith("autonomy")) assert.equal(result.result?.autonomousTasks, 2, "Planner stopped legitimately, but the two-task acceptance is not complete");
  console.log(JSON.stringify({ label: mode, result: journal.runs[mode].result, finance: journal.agents[mode].financeAfter }));
} else {
  const provider = new JsonRpcProvider(ready.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    const before = await (await fetch("http://127.0.0.1:3427/health")).json();
    const wallets = Object.values(journal.agents).map((a: any) => a.agent.wallet);
    const nonces = await Promise.all(wallets.map((w: any) => provider.getTransactionCount(w)));
    for (const label of ["cheap", "strong", "autonomy", ...(journal.runs["autonomy-credit"] ? ["autonomy-credit"] : [])]) {
      const entry = journal.runs[label];
      if (label === "autonomy" && journal.expiredRefund?.result) { assert.equal(entry?.result?.status, "Failed"); assert.equal(entry.result.result?.chargedRaw, "10000"); }
      else { assert.equal(entry?.result?.status, "Succeeded", `${label} is not complete`); if (label.startsWith("autonomy")) assert.equal(entry.result.result?.autonomousTasks, 2); }
      await api(`/agents/${journal.agents[label].agent.id}/runs`, "POST", entry.input); await wait(entry.input.requestId);
    }
    assert.deepEqual(await Promise.all(wallets.map((w: any) => provider.getTransactionCount(w))), nonces);
    const after = await (await fetch("http://127.0.0.1:3427/health")).json();
    assert.equal(after.acceptedRequests, before.acceptedRequests);
    journal.replay = { noNewTransactions: true, noNewModelRequests: true, before, after };
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
    await evidenceFiles(join(directory, "hosted", "agents"));
    const publicDirectory = resolve("frontend/acceptance/local-real-20261012"); await mkdir(publicDirectory, { recursive: true });
    const calls = (await readFile(join(directory, "..", "gateway", "attempts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(taskResults.every(result => result.success && result.settlement?.passed || result.refundedRaw === "120000" && result.chargedRaw === "0"));
    assert.ok(ledgers.every(ledger => ledger.invocations.every((invocation: any) => invocation.state === "Completed")));
    await writeFile(join(publicDirectory, "financial-evidence.json"), JSON.stringify({ observedAt: journal.completedAt,
      boundary: "Real Kimi via Magpie; local Anvil/mock identity registries/test USDC; independent Docker Arena; no cloud or Monad deployment",
      replay: journal.replay, agents: journal.agents, runs: journal.runs, expiredRefund: journal.expiredRefund, taskResults, ledgers, decisions, vendorCalls: calls }, null, 2));
    console.log(JSON.stringify({ replay: journal.replay, runs: Object.keys(journal.runs) }));
  } finally { provider.destroy(); }
}
