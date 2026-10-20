import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHostedAccounting } from "../src/accounting.js";
import type { HostedAgent, HostedResult, HostedRun } from "../src/types.js";

const at = "2026-10-17T00:00:00.000Z", tx = "0x" + "a".repeat(64);
function agent(): HostedAgent { return { id: randomUUID(), owner: "0x" + "b".repeat(40), wallet: "0x" + "c".repeat(40), name: "Accounting", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "1000", totalBudgetRaw: "10000", allowCredit: true, createdAt: at, updatedAt: at, status: "Ready", spentRaw: "0", reservedRaw: "0", binding: { chainId: "10143", agentId: "1", wallet: "0x" + "c".repeat(40) } }; }
function run(a: HostedAgent, action: HostedRun["action"], extra: Partial<HostedResult> = {}, more: Partial<HostedRun> = {}): HostedRun {
  const result: HostedResult = { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", ...extra };
  return { requestId: randomUUID(), agentId: a.id, action, status: result.terminal ? result.success ? "Succeeded" : "Failed" : "Paused", createdAt: at, updatedAt: at, reservedRaw: "1000", chargedRaw: result.chargedRaw, recoverable: !result.terminal, result, ...more };
}
const settlement = (repaidRaw = "0", residualRaw = "100", loanStatus = "0", passed = true) => ({ txHash: tx, block: { number: 1, hash: tx, timestamp: 1792195200 }, passed, repaidRaw, residualRaw, slashedRaw: "0", loanStatus });
async function fixture(work: (directory: string) => Promise<void>) { const directory = await realpath(await mkdtemp(join(tmpdir(), "af-accounting-"))); try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
async function save(directory: string, relative: string, value: unknown) { const path = join(directory, relative); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); return path; }

test("operating revenue includes repayment once; capital, principal and game/token subsidies stay outside profit", async () => fixture(async directory => {
  const a = agent();
  const provision = run(a, "provision", { cashRaw: "50" });
  const deposit = run(a, "deposit", {}, { amountRaw: "100" });
  const game = run(a, "game", { rewardRaw: "10", creditsGranted: 500 });
  const task = run(a, "task", { chargedRaw: "10", fromCashRaw: "2", fromCreditRaw: "8", refundedRaw: "0", taskId: "4", paymentId: tx,
    // Outstanding principal/fee have been zeroed by settlement; neither is historical borrowing cost.
    principalRaw: "0", feeRaw: "0", settlement: settlement("9", "89", "2") });
  const value = await readHostedAccounting({ directory, agent: a, runs: [provision, deposit, game, task] });
  assert.equal(value.status, "complete");
  assert.deepEqual(value.totals, { taskRevenueRaw: "98", inferenceCostRaw: "10", borrowingFeeRaw: "1", refundsRaw: "0", gameSubsidyRaw: "10", ownerCapitalRaw: "100", startupCapitalRaw: "50", loanPrincipalRaw: "8", creditsGranted: 500, creditsUsed: 0, netOperatingRaw: "87" });
  assert.equal(value.coverage.scope, "retained-hosted-history");
}));

test("confirmed refunds already reduce cost; borrowed principal is not a second expense", async () => fixture(async directory => {
  const a = agent(), refunded = run(a, "metered-task", { phase: "Refunded", success: false, chargedRaw: "0", taskId: "7", fromCashRaw: "2", fromCreditRaw: "8", refundedRaw: "10" });
  const value = await readHostedAccounting({ directory, agent: a, runs: [refunded] });
  assert.equal(value.status, "complete"); assert.equal(value.totals.inferenceCostRaw, "0"); assert.equal(value.totals.refundsRaw, "10");
  assert.equal(value.totals.loanPrincipalRaw, "8"); assert.equal(value.totals.netOperatingRaw, "0");
}));

test("missing settlement, unresolved payment and default fees retain known costs without inventing profit", async () => fixture(async directory => {
  const a = agent();
  const historical = run(a, "task", { chargedRaw: "12", rewardRaw: "999999", taskId: "9" });
  const unknown = run(a, "task", { terminal: false, success: false, chargedRaw: "5", reason: "HOSTED_PAYMENT_UNKNOWN" });
  const failed = run(a, "task", { phase: "Failed", success: false, chargedRaw: "10", fromCashRaw: "0", fromCreditRaw: "10", taskId: "10", settlement: { ...settlement("0", "0", "3", false), slashedRaw: "100" } });
  const value = await readHostedAccounting({ directory, agent: a, runs: [historical, unknown, failed] });
  assert.equal(value.status, "partial"); assert.equal(value.totals.netOperatingRaw, null); assert.equal(value.totals.taskRevenueRaw, "0"); assert.equal(value.totals.inferenceCostRaw, "27");
  assert.equal(value.coverage.pendingCount, 1); assert.equal(value.coverage.incompleteCount, 2);
  assert.ok(value.coverage.reasons.includes("ACCOUNTING_BORROWING_FEE_UNKNOWN")); assert.ok(value.coverage.reasons.includes("ACCOUNTING_SETTLEMENT_MISSING"));
}));

test("goal cumulative charges count once and private financial journal reads do not leak or mutate evidence", async () => fixture(async directory => {
  const a = agent(), goal = run(a, "goal", { chargedRaw: "30", refundedRaw: "7" });
  const path = await save(directory, `agents/${a.id}/runs/${goal.requestId}/mission/session.json`, { version: 1,
    input: { agentId: a.id, owner: a.owner, wallet: a.wallet }, view: { calls: [{ chargedRaw: "10" }, { chargedRaw: "20" }] },
    calls: [{ started: true, response: { chargedRaw: "10", text: "SECRET_RESPONSE" } }, { started: true, response: { chargedRaw: "20" } }, { started: true, recovery: { chargedRaw: "0", refundedRaw: "7", resolved: true } }],
    privateKey: "SECRET_KEY", policy: { raw: "SECRET_RAW_TX" }, route: { relayUrl: "SECRET_URL" } });
  const before = await readFile(path, "utf8"), value = await readHostedAccounting({ directory, agent: a, runs: [goal] });
  assert.equal(value.status, "complete"); assert.equal(value.totals.inferenceCostRaw, "30"); assert.equal(value.totals.netOperatingRaw, "-30"); assert.equal(value.totals.refundsRaw, "7");
  assert.equal(value.entries.length, 1); assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(await readFile(path, "utf8"), before);
}));

test("autonomy planner and child journals split cumulative parent costs and recover hidden game subsidies", async () => fixture(async directory => {
  const a = agent(), parent = run(a, "autonomous", { chargedRaw: "23" }), child = run(a, "metered-task", { chargedRaw: "20", fromCashRaw: "20", fromCreditRaw: "0", taskId: "12", paymentId: tx, settlement: settlement() }), game = run(a, "game", { rewardRaw: "50", creditsGranted: 1000 });
  const base = `agents/${a.id}/runs/${parent.requestId}`;
  const host = await save(directory, `${base}/autonomy-host/session.json`, { version: 1, input: { agent: a, run: parent }, children: { [child.requestId]: { agent: a, run: child }, [game.requestId]: { agent: a, run: game } }, privateKey: "SECRET" });
  await save(directory, `${base}/autonomy-loop/session.json`, { version: 1, config: { sessionId: parent.requestId }, phase: "Completed", chargedRaw: "23", steps: [
    { decisionChargedRaw: "3", childId: child.requestId, outcome: { terminal: true, success: true, chargedRaw: "20" } },
    { decisionSource: "runtime", decisionChargedRaw: "0", childId: game.requestId, outcome: { terminal: true, success: true, chargedRaw: "0" } }] });
  const childPath = await save(directory, `${base}/children/${child.requestId}/task-executor/session.json`, { version: 1, snapshot: { agent: a.id, owner: a.owner, wallet: a.wallet, request: child.requestId, action: child.action }, result: { ...child.result, privateResponse: "SECRET" }, raw: "SECRET" });
  await save(directory, `${base}/children/${game.requestId}/session.json`, { version: 1, result: { ...game.result, privateResponse: "SECRET" } });
  const before = await readFile(childPath, "utf8"), hostBefore = await readFile(host, "utf8");
  // A duplicate browser-visible child is the same execution, not a second cost or subsidy.
  const value = await readHostedAccounting({ directory, agent: a, runs: [parent, child] });
  assert.equal(value.status, "complete"); assert.equal(value.totals.inferenceCostRaw, "23"); assert.equal(value.totals.taskRevenueRaw, "100"); assert.equal(value.totals.netOperatingRaw, "77");
  assert.equal(value.totals.gameSubsidyRaw, "50"); assert.equal(value.totals.creditsGranted, 1000); assert.equal(value.entries.length, 3);
  const reversed = await readHostedAccounting({ directory, agent: a, runs: [child, parent] });
  assert.equal(reversed.status, "complete"); assert.deepEqual(reversed.totals, value.totals); assert.equal(reversed.entries.length, 3);
  assert.equal(reversed.entries.find(entry => entry.requestId === child.requestId)?.parentRequestId, parent.requestId);
  assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(await readFile(childPath, "utf8"), before); assert.equal(await readFile(host, "utf8"), hostBefore);
}));

test("missing legacy child evidence preserves the aggregate charge and marks history incomplete", async () => fixture(async directory => {
  const a = agent(), parent = run(a, "autonomous", { chargedRaw: "33" });
  const value = await readHostedAccounting({ directory, agent: a, runs: [parent] });
  assert.equal(value.status, "partial"); assert.equal(value.totals.inferenceCostRaw, "33"); assert.equal(value.totals.netOperatingRaw, null); assert.ok(value.coverage.reasons.includes("ACCOUNTING_HISTORY_MISSING"));
}));

test("duplicate payment and task evidence is excluded from totals and flagged", async () => fixture(async directory => {
  const a = agent(), task = run(a, "task", { chargedRaw: "10", fromCashRaw: "10", fromCreditRaw: "0", paymentId: tx, taskId: "1", settlement: settlement() });
  const duplicate = { ...task, requestId: randomUUID() };
  const value = await readHostedAccounting({ directory, agent: a, runs: [task, duplicate] });
  assert.equal(value.totals.inferenceCostRaw, "10"); assert.equal(value.totals.taskRevenueRaw, "100"); assert.equal(value.totals.netOperatingRaw, null);
  assert.ok(value.coverage.reasons.includes("ACCOUNTING_DUPLICATE_PAYMENT")); assert.ok(value.coverage.reasons.includes("ACCOUNTING_DUPLICATE_TASK"));
}));

test("private journal symlinks are rejected; response limits never discard amounts from totals", async () => fixture(async directory => {
  const a = agent(), goal = run(a, "goal", { chargedRaw: "3" }), outside = await save(directory, "secret.json", { version: 1, privateKey: "SECRET" });
  const mission = join(directory, `agents/${a.id}/runs/${goal.requestId}/mission`); await mkdir(mission, { recursive: true }); await symlink(outside, join(mission, "session.json"));
  const unsafe = await readHostedAccounting({ directory, agent: a, runs: [goal] });
  assert.ok(unsafe.coverage.reasons.includes("ACCOUNTING_HISTORY_INVALID")); assert.equal(JSON.stringify(unsafe).includes("SECRET"), false);
  const games = Array.from({ length: 201 }, () => run(a, "game", { rewardRaw: "1" }));
  const limited = await readHostedAccounting({ directory, agent: a, runs: games });
  assert.equal(limited.totals.gameSubsidyRaw, "201"); assert.equal(limited.entries.length, 200); assert.equal(limited.coverage.entryCount, 201); assert.equal(limited.coverage.returnedEntryCount, 200); assert.equal(limited.coverage.entriesTruncated, true);
}));

test("a truncated goal call journal cannot erase a known cumulative charge", async () => fixture(async directory => {
  const a = agent(), goal = run(a, "goal", { chargedRaw: "30" });
  await save(directory, `agents/${a.id}/runs/${goal.requestId}/mission/session.json`, { version: 1, input: { agentId: a.id, owner: a.owner, wallet: a.wallet }, calls: [{ response: { chargedRaw: "10" } }] });
  const value = await readHostedAccounting({ directory, agent: a, runs: [goal] });
  assert.equal(value.status, "partial"); assert.equal(value.totals.inferenceCostRaw, "30"); assert.equal(value.totals.netOperatingRaw, null); assert.ok(value.coverage.reasons.includes("ACCOUNTING_COST_MISMATCH"));
}));

test("a lost terminal run is detected against cumulative spend even if active charges exceed the gap", async () => fixture(async directory => {
  const a = { ...agent(), spentRaw: "25" }, terminal = run(a, "task", { chargedRaw: "10", taskId: "1", settlement: settlement() }), active = run(a, "task", { terminal: false, success: false, chargedRaw: "50" });
  const value = await readHostedAccounting({ directory, agent: a, runs: [terminal, active] });
  assert.equal(value.coverage.uncoveredSpentRaw, "15"); assert.equal(value.totals.inferenceCostRaw, "60"); assert.equal(value.totals.netOperatingRaw, null); assert.ok(value.coverage.reasons.includes("ACCOUNTING_HISTORY_MISSING"));
  const empty = await readHostedAccounting({ directory, agent: a, runs: [] });
  assert.equal(empty.status, "partial"); assert.equal(empty.coverage.uncoveredSpentRaw, "25"); assert.equal(empty.totals.netOperatingRaw, null);
}));

test("partially refunded borrowing never guesses a settled fee from cleared loan balances", async () => fixture(async directory => {
  const a = agent(), task = run(a, "task", { chargedRaw: "8", fromCashRaw: "2", fromCreditRaw: "8", refundedRaw: "2", principalRaw: "0", feeRaw: "0", taskId: "1", settlement: settlement("8", "90", "2") });
  const value = await readHostedAccounting({ directory, agent: a, runs: [task] });
  assert.equal(value.totals.taskRevenueRaw, "98"); assert.equal(value.totals.inferenceCostRaw, "8"); assert.equal(value.totals.borrowingFeeRaw, "0"); assert.equal(value.totals.netOperatingRaw, null);
  assert.ok(value.coverage.reasons.includes("ACCOUNTING_BORROWING_FEE_UNKNOWN"));
}));

test("successful games and reward calls distinguish missing subsidy/token evidence from explicit zero", async () => fixture(async directory => {
  const a = agent(), usdc = run(a, "game", {}, { rewardKind: "usdc" }), tokens = run(a, "game", { rewardRaw: "0" }, { rewardKind: "llm-credits" });
  const missing = await readHostedAccounting({ directory, agent: a, runs: [usdc, tokens, run(a, "credits")] });
  assert.equal(missing.status, "partial"); assert.equal(missing.totals.netOperatingRaw, null); assert.ok(missing.coverage.reasons.includes("ACCOUNTING_SUBSIDY_UNKNOWN")); assert.ok(missing.coverage.reasons.includes("ACCOUNTING_TOKEN_USAGE_UNKNOWN"));
  const explicit = await readHostedAccounting({ directory, agent: a, runs: [{ ...usdc, result: { ...usdc.result!, rewardRaw: "0" } }, { ...tokens, result: { ...tokens.result!, creditsGranted: 0 } }, run(a, "credits", { creditsUsed: 0 })] });
  assert.equal(explicit.status, "complete"); assert.equal(explicit.totals.gameSubsidyRaw, "0"); assert.equal(explicit.totals.creditsGranted, 0); assert.equal(explicit.totals.netOperatingRaw, "0");
}));

test("Tempo contribution uses PathUSD while chain fees and actual profit remain unknown", async () => fixture(async directory => {
 const a=agent();a.binding!.chainId="42431";
 const v=await readHostedAccounting({directory,agent:a,runs:[run(a,"deposit",{},{amountRaw:"100"})]});
 assert.equal(v.currency,"PathUSD");assert.equal(v.costScope,"settlement-asset-only");assert.equal(v.chainFeesRaw,null);assert.equal(v.actualProfitRaw,null);
 const legacy=agent(); delete legacy.binding;
 assert.equal((await readHostedAccounting({directory,agent:legacy,runs:[],chainId:"42431"})).currency,"PathUSD");
}));
