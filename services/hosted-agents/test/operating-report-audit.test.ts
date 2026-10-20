import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { keccak256, Wallet } from "ethers";
import { accountInterface, canonical, EMPTY_AUTH, paymentId, requestDigest, type ChatInput, type Json, type PaymentHandle } from "@agentfuel/sdk";
import { selectInference } from "../../../packages/pi-loop/src/selector.js";
import type { WorkflowConfig } from "../../../packages/pi-loop/src/workflow.js";
import { assessHostedOperatingReport, evaluateOperatorFinancialObservation, validateOperatingReportPreview } from "../src/operating-report.js";
import { readHostedOperatingReport } from "../src/operating-history.js";
import type { OperatingReportInput, OperatingSupplierReceipt } from "../src/operating-types.js";
import { HostedService } from "../src/service.js";
import { createHostedHttpServer } from "../src/http.js";
import type { HostedAgent, HostedResult, HostedRun } from "../src/types.js";

const at = "2026-10-17T01:00:00.000Z", tx = "0x" + "a".repeat(64);
const address = (digit: string) => "0x" + digit.repeat(40);
const digest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
function actor(): HostedAgent {
  return { id: randomUUID(), owner: address("b"), wallet: address("c"), name: "Audit", modelId: "controlled", strategy: "balanced",
    perRunBudgetRaw: "1000", totalBudgetRaw: "100000", allowCredit: true, status: "Ready", spentRaw: "0", reservedRaw: "0", createdAt: at, updatedAt: at,
    binding: { chainId: "10143", agentId: "1", wallet: address("c") } };
}
function supplier(extra: Partial<OperatingSupplierReceipt> = {}): OperatingSupplierReceipt {
  return { requestId: randomUUID(), paymentId: tx, paymentTxHash: tx, routeBinding: "a".repeat(64), providerId: "original-provider", payTo: address("4"),
    chainId: "10143", account: address("1"), asset: address("2"), service: "infercredit/solve-fixed", model: "original-physical-route",
    grossReceiptsRaw: "120", refundsRaw: "20", netReceiptsRaw: "100", ...extra };
}
function input(): OperatingReportInput {
  const agent = actor(), receipt = supplier();
  const entry = { id: receipt.requestId, requestId: receipt.requestId, action: "task" as const, at, status: "confirmed" as const,
    inferenceCostRaw: "100", refundsRaw: "20", taskRevenueRaw: "970", borrowingFeeRaw: "10", gameSubsidyRaw: "0", ownerCapitalRaw: "0", startupCapitalRaw: "0", loanPrincipalRaw: "80", creditsGranted: 0, creditsUsed: 0,
    taskId: "1", paymentId: receipt.paymentId, txHash: receipt.paymentTxHash, reasons: [] };
  return { agent, observedAt: at, pendingReservationsRaw: "200",
    finance: { status: "confirmed", observedAt: at, chainId: "10143", agentId: "1", wallet: agent.wallet,
      block: { number: 1, hash: tx, timestamp: Date.parse(at) / 1000 }, cashRaw: "1000", debtRaw: "100", scannedTaskCount: 1, ownedTaskCount: 1,
      credit: { score: "1", tier: "A", tierCapRaw: "999999", feeBps: "1500", eligible: true, rejection: null },
      policy: { maxCashPerTxRaw: "999999", maxDebtPerTxRaw: "999999", maxDebtPerDayRaw: "999999", ownerFrozen: false },
      counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } },
    accounting: { version: 1, observedAt: at, agentId: agent.id, currency: "USDC", decimals: 6, status: "complete",
      totals: { taskRevenueRaw: "970", inferenceCostRaw: "100", borrowingFeeRaw: "10", refundsRaw: "20", gameSubsidyRaw: "300", ownerCapitalRaw: "500", startupCapitalRaw: "50", loanPrincipalRaw: "80", creditsGranted: 1000, creditsUsed: 1400, netOperatingRaw: "860" },
      coverage: { scope: "retained-hosted-history", since: at, runCount: 1, entryCount: 1, pendingCount: 0, incompleteCount: 0, returnedEntryCount: 1, entriesTruncated: false, uncoveredSpentRaw: "0", reasons: [] }, entries: [entry] },
    evidence: { suppliers: [receipt], taskFees: [{ requestId: receipt.requestId, taskId: "1", settlementTxHash: tx, protocolFeeRaw: "30", creditFeeSettledRaw: "10", source: "settled-task-and-original-reward", gaps: [] }],
      settlementDomain: { chainId: receipt.chainId, account: receipt.account, asset: receipt.asset }, gaps: [], entriesTruncated: false } };
}
async function directory(work: (value: string) => Promise<void>) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "af-operating-independent-")));
  try { await work(path); } finally { await rm(path, { recursive: true, force: true }); }
}
async function save(base: string, relative: string, value: unknown) {
  const path = join(base, relative); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); return path;
}
const settled = (repaidRaw = "0", residualRaw = "970", loanStatus = "0") => ({ txHash: tx, block: { number: 1, hash: tx, timestamp: Date.parse(at) / 1000 }, passed: true,
  loanStatus, repaidRaw, slashedRaw: "0", residualRaw });
function run(agent: HostedAgent, extra: Partial<HostedResult> = {}, action: HostedRun["action"] = "task"): HostedRun {
  const result: HostedResult = { phase: "Succeeded", terminal: true, success: true, chargedRaw: "100", fromCashRaw: "100", fromCreditRaw: "0", refundedRaw: "0", taskId: "1", settlement: settled(), ...extra };
  return { requestId: randomUUID(), agentId: agent.id, action, status: result.terminal ? result.success ? "Succeeded" : "Failed" : "Paused", createdAt: at, updatedAt: at,
    reservedRaw: "1000", chargedRaw: result.chargedRaw, recoverable: !result.terminal, result };
}

test("independent roles: net Agent contribution excludes financing and subsidies; relay receipts do not prove either party's profit", () => {
  const data = input(), before = JSON.stringify(data), value = assessHostedOperatingReport(data);
  assert.equal(value.mode, "read-only"); assert.equal(value.scope, "owner-agent-contribution");
  assert.equal(value.agent.settlementOperatingRaw, "860");
  assert.equal(value.agent.loanPrincipalRaw, "80"); assert.equal(value.agent.ownerCapitalRaw, "500");
  assert.equal(value.agent.actualProfitRaw, null); assert.equal(value.platform.actualProfitRaw, null); assert.equal(value.suppliers.actualProfitRaw, null);
  assert.equal(value.agent.gaps.includes("OPERATING_UPSTREAM_COST_UNRECORDED"), false);
  assert.equal(value.platform.derivedProtocolFeeRaw, "30"); assert.equal(value.platform.creditFeeSettledRaw, "10");
  assert.equal(value.platform.creditFeeRecipient, "credit-vault"); assert.equal(value.platform.treasuryReceiptsRaw, null);
  assert.equal(value.suppliers.grossReceiptsRaw, "120"); assert.equal(value.suppliers.refundsRaw, "20"); assert.equal(value.suppliers.netReceiptsRaw, "100");
  assert.equal(value.suppliers.unattributedNetServiceCostRaw, "0");
  assert.equal(value.consolidation.roleTotalsAdditive, false); assert.equal(value.consolidation.externalRevenueRaw, null);
  assert.equal(value.subsidy.rewardTokensGranted, 1000); assert.equal(value.subsidy.inferenceTokensUsed, 1400);
  assert.equal(value.subsidy.rewardTokensConsumed, null); assert.equal(value.subsidy.rewardTokensRemaining, null);
  assert.equal(value.subsidy.usdcAttributedConsumptionRaw, null); assert.equal(value.subsidy.usdcGrantRemainingRaw, null);
  assert.equal(value.subsidy.tokenUsageScope, "paid-and-reward-mix-unknown"); assert.equal(JSON.stringify(data), before);
});

test("independent roles: original provider, payee and route identities are separate cohorts", () => {
  const data = input(); data.accounting.totals.inferenceCostRaw = "300"; data.accounting.totals.refundsRaw = "60";
  data.accounting.totals.netOperatingRaw = "660";
  data.evidence.suppliers.push(supplier({ paymentId: "0x" + "b".repeat(64), payTo: address("5"), routeBinding: "b".repeat(64) }),
    supplier({ paymentId: "0x" + "c".repeat(64), providerId: "different-original-provider", routeBinding: "c".repeat(64) }));
  for (const receipt of data.evidence.suppliers.slice(1)) data.accounting.entries.push({ ...data.accounting.entries[0], id: receipt.requestId, requestId: receipt.requestId,
    taskId: undefined, taskRevenueRaw: "0", borrowingFeeRaw: "0", loanPrincipalRaw: "0", paymentId: receipt.paymentId });
  data.accounting.coverage.entryCount = 3; data.accounting.coverage.returnedEntryCount = 3; data.accounting.coverage.runCount = 3;
  const value = assessHostedOperatingReport(data);
  assert.equal(value.suppliers.rows.length, 3); assert.equal(value.suppliers.netReceiptsRaw, "300");
  assert.deepEqual(value.suppliers.rows.map(row => row.paymentCount), [1, 1, 1]);
  assert.ok(value.suppliers.rows.every(row => row.actualProfitRaw === null));
});

test("independent receipts: duplicate, conflicting, foreign and invalid amounts cannot fabricate supplier receipts", () => {
  for (const variant of ["duplicate", "conflict", "foreign-domain", "foreign-request", "arithmetic"]) {
    const data = input(), receipt = data.evidence.suppliers[0];
    if (variant === "duplicate") data.evidence.suppliers.push(structuredClone(receipt));
    if (variant === "conflict") data.evidence.suppliers.push({ ...receipt, grossReceiptsRaw: "220", netReceiptsRaw: "200" });
    if (variant === "foreign-domain") receipt.chainId = "31337";
    if (variant === "foreign-request") receipt.requestId = randomUUID();
    if (variant === "arithmetic") receipt.netReceiptsRaw = "99";
    const value = assessHostedOperatingReport(data);
    assert.equal(value.suppliers.netReceiptsRaw, variant === "duplicate" ? "100" : "0", variant);
    assert.equal(value.suppliers.unattributedNetServiceCostRaw, variant === "duplicate" ? "0" : "100", variant);
    assert.ok(value.suppliers.gaps.length > 0, variant); assert.equal(value.suppliers.actualProfitRaw, null, variant);
  }
});

test("independent cash: reservations, debt and reserve reduce runway; credit and grant history do not refill cash", () => {
  const data = input(); data.preview = { reserveCashRaw: "50", recurringCostRaw: "25", burn: { amountRaw: "100", windowMs: 60000, taskCount: 3 },
    subsidyBudgetRaw: "400", subsidyBurn: { amountRaw: "25", windowMs: 1000, taskCount: 2 } };
  const value = assessHostedOperatingReport(data);
  assert.equal(value.cash.spendableCashRaw, "650"); assert.equal(value.cash.creditIncluded, false);
  assert.equal(value.runway.source, "owner-hypothetical"); assert.equal(value.runway.status, "finite");
  assert.equal(value.runway.horizonMs, "390000"); assert.equal(value.runway.fullTasks, "19");
  assert.equal(value.scenario?.settlementOperatingAfterAssumedCostRaw, "835");
  assert.equal(value.scenario?.subsidyBudgetRemainingRaw, "100"); assert.equal(value.scenario?.subsidyBudgetRunway?.horizonMs, "4000");
  assert.equal(value.scenario?.subsidyBudgetRunway?.fullTasks, "8");
  assert.equal(value.agent.settlementOperatingRaw, "860"); assert.equal(value.platform.treasuryReceiptsRaw, null);
});

test("independent runway: absent burn is unknown and declared zero burn never becomes infinite runway", () => {
  const data = input();
  const absent = assessHostedOperatingReport(data); assert.equal(absent.runway.status, "unknown"); assert.equal(absent.runway.horizonMs, null);
  data.preview = { burn: { amountRaw: "0", windowMs: 60000 } };
  const zero = assessHostedOperatingReport(data); assert.equal(zero.runway.status, "zero-burn"); assert.equal(zero.runway.horizonMs, null); assert.equal(zero.runway.fullTasks, null);
  if (data.finance.status !== "confirmed") assert.fail(); data.finance.cashRaw = "1";
  data.preview = { burn: { amountRaw: "100", windowMs: 60000, taskCount: 3 } };
  const empty = assessHostedOperatingReport(data); assert.equal(empty.cash.spendableCashRaw, "0"); assert.equal(empty.runway.horizonMs, "0"); assert.equal(empty.runway.fullTasks, "0");
});

test("independent preview: owner hypotheses cannot inject actuals, global books, hidden fields or invalid numeric units", () => {
  for (const preview of [
    { platform: { actualProfitRaw: "999" } }, { evidence: { receiptsRaw: "999" } }, { privateKey: "SECRET_KEY" },
    { burn: { amountRaw: "100", windowMs: 1, taskCount: 1, provider: "SECRET_URL" } },
    { burn: { amountRaw: "-1", windowMs: 1 } }, { burn: { amountRaw: "01", windowMs: 1 } },
    { reserveCashRaw: (1n << 256n).toString() }, { recurringCostRaw: "1.5" }, { subsidyBudgetRaw: 1 },
    { burn: { amountRaw: "1", windowMs: 0 } }, { burn: { amountRaw: "1", windowMs: Number.MAX_SAFE_INTEGER + 1 } },
    { burn: { amountRaw: "1", windowMs: 1, taskCount: 0 } }, { burn: { amountRaw: "1", windowMs: 1, taskCount: 1.5 } },
    { subsidyBurn: { amountRaw: "1", windowMs: 0 } }, [], null,
  ]) assert.throws(() => validateOperatingReportPreview(preview), /HOSTED_OPERATING_INPUT_INVALID/, JSON.stringify(preview));
});

test("independent unknowns: finance identity and retained coverage cannot be repaired with owner cost assumptions", () => {
  for (const reason of ["unavailable", "wrong-owner", "wrong-chain", "future", "stale", "partial", "truncated"]) {
    const data = input(); data.preview = { reserveCashRaw: "0", burn: { amountRaw: "1", windowMs: 60000 } };
    if (data.finance.status !== "confirmed") assert.fail();
    if (reason === "wrong-owner") data.finance.wallet = address("9");
    if (reason === "wrong-chain") data.finance.chainId = "31337";
    if (reason === "future") data.finance.observedAt = "2026-10-17T02:00:00.000Z";
    if (reason === "stale") data.finance.observedAt = "2026-10-16T01:00:00.000Z";
    if (reason === "unavailable") data.finance = { status: "unavailable", observedAt: at, reason: "HOSTED_FINANCE_UNCONFIRMED" };
    if (reason === "partial") { data.accounting.status = "partial"; data.accounting.totals.netOperatingRaw = null; data.accounting.coverage.reasons = ["ACCOUNTING_HISTORY_INVALID"]; }
    if (reason === "truncated") { data.accounting.coverage.entriesTruncated = true; data.evidence.entriesTruncated = true; }
    const value = assessHostedOperatingReport(data);
    if (["unavailable", "wrong-owner", "wrong-chain", "future", "stale"].includes(reason)) { assert.equal(value.cash.status, "unavailable", reason); assert.equal(value.runway.status, "unknown", reason); }
    if (reason === "partial") { assert.equal(value.agent.settlementOperatingRaw, null); assert.equal(value.status, "partial"); }
    if (reason === "truncated") { assert.equal(value.platform.derivedProtocolFeeRaw, null); assert.equal(value.coverage.roleEntriesTruncated, true); }
    assert.equal(value.agent.actualProfitRaw, null); assert.equal(value.platform.actualProfitRaw, null);
  }
});

test("independent incomplete history: absent child or older rows do not prove zero platform fees", () => {
  for (const reason of ["ACCOUNTING_HISTORY_MISSING", "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_HISTORY_LIMIT"]) {
    const data = input(); data.accounting.status = "partial"; data.accounting.totals.netOperatingRaw = null;
    data.accounting.coverage.reasons = [reason]; data.accounting.entries = []; data.evidence.suppliers = []; data.evidence.taskFees = [];
    data.preview = { burn: { amountRaw: "1", windowMs: 60000 } };
    const value = assessHostedOperatingReport(data);
    assert.equal(value.platform.derivedProtocolFeeRaw, null, reason); assert.equal(value.platform.creditFeeSettledRaw, null, reason);
    assert.equal(value.platform.knownDerivedProtocolFeeRaw, "0", reason); assert.equal(value.agent.settlementOperatingRaw, null);
    assert.equal(value.agent.netServiceCostRaw, "100");
    assert.equal(value.runway.status, "unknown", reason); assert.equal(value.cash.spendableCashRaw, null, reason);
  }
});

test("independent subsidy uncertainty: a missing reward grant cannot turn known grants into an exact remaining budget", async () => directory(async base => {
  const data = input();
  const known = run(data.agent, { chargedRaw: "0", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined, rewardRaw: "300" }, "game");
  const missing = run(data.agent, { chargedRaw: "0", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined, rewardRaw: undefined }, "game");
  known.rewardKind = missing.rewardKind = "usdc";
  for (const budget of ["400", "200"]) {
    const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [known, missing], observedAt: at,
      preview: { subsidyBudgetRaw: budget, subsidyBurn: { amountRaw: "25", windowMs: 1000, taskCount: 2 } } });
    assert.ok(value.coverage.reasons.includes("ACCOUNTING_SUBSIDY_UNKNOWN"));
    assert.equal(value.subsidy.gameUsdcGrantedRaw, "300"); assert.equal(value.subsidy.gameDistributionOutflowRaw, "300");
    assert.equal(value.scenario?.subsidyBudgetRaw, budget); assert.equal(value.scenario?.subsidyBudgetRemainingRaw, null); assert.equal(value.scenario?.subsidyBudgetShortfallRaw, null);
    const runway = value.scenario?.subsidyBudgetRunway; assert.ok(runway);
    assert.equal(runway.status, "unknown"); assert.equal(runway.availableRaw, null); assert.equal(runway.horizonMs, null); assert.equal(runway.fullTasks, null);
    assert.equal(runway.burnAmountRaw, "25"); assert.ok(runway.reasons.includes("OPERATING_SUBSIDY_GRANTS_UNKNOWN"));
    assert.equal(value.subsidy.usdcGrantRemainingRaw, null); assert.equal(value.agent.actualProfitRaw, null);
  }
}));

test("independent operator declarations: costs and explicit subsidy allocation are reported hypotheses, never audited profit", () => {
  const observation = { version: 1, source: "operator-declared", role: "supplier", subjectId: "controlled-supplier", period: { from: "2026-10-16T01:00:00.000Z", to: at }, evidenceDigest: "a".repeat(64),
    receiptsRaw: "1000", refundsRaw: "100", costsRaw: "600", cashRaw: "500", reservationsRaw: "100", debtRaw: "100", reserveCashRaw: "50",
    subsidyGrantedRaw: "200", subsidyAllocatedRaw: "80", subsidyBudgetRaw: "300", burn: { amountRaw: "25", windowMs: 60000, taskCount: 1 },
    subsidyBurn: { amountRaw: "10", windowMs: 1000, taskCount: 2 } };
  const before = JSON.stringify(observation), value = evaluateOperatorFinancialObservation(observation);
  assert.equal(value.source, "operator-declared"); assert.equal(value.reportedNetReceiptsRaw, "900"); assert.equal(value.reportedContributionRaw, "100"); assert.equal(value.actualProfitRaw, null);
  assert.equal(value.subsidy.unallocatedGrantRaw, "120"); assert.equal(value.runway.availableRaw, "250"); assert.equal(value.runway.horizonMs, "600000");
  assert.equal(value.subsidy.remainingBudgetRaw, "100"); assert.equal(value.subsidy.budgetShortfallRaw, "0");
  assert.equal(value.subsidy.budgetRunway?.horizonMs, "10000"); assert.equal(value.subsidy.budgetRunway?.fullTasks, "20"); assert.equal(JSON.stringify(observation), before);
  const promised = evaluateOperatorFinancialObservation({ ...observation, subsidyCommittedRaw: "50" });
  assert.equal(promised.subsidy.remainingBudgetRaw, "50"); assert.equal(promised.subsidy.budgetRunway?.horizonMs, "5000");
  const oversubscribed = evaluateOperatorFinancialObservation({ ...observation, subsidyBudgetRaw: "100" });
  assert.equal(oversubscribed.subsidy.remainingBudgetRaw, "0"); assert.equal(oversubscribed.subsidy.budgetShortfallRaw, "100"); assert.equal(oversubscribed.subsidy.budgetRunway?.horizonMs, "0");
  for (const extra of [ { costsRaw: "-1" }, { costsRaw: (1n << 256n).toString() }, { subsidyAllocatedRaw: "201" }, { evidenceDigest: "bogus" }, { privateKey: "SECRET" },
    { period: { from: at, to: "2026-10-16T01:00:00.000Z" } }, { currency: "TOKEN" },
  ]) assert.throws(() => evaluateOperatorFinancialObservation({ ...observation, ...extra }));
});

async function admission(base: string, agent: HostedAgent, request: HostedRun, parentRequestId?: string, cashRaw = "10000", planningCostRaw = "0") {
  const deadlineMs = Date.parse(at) + 60000;
  const config: WorkflowConfig = { agentId: "1", chainId: "10143", account: address("1"), asset: address("2"), escrowAddress: address("3"),
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs, creditLimit: "1000" }],
    providers: [{ id: "original-provider", payTo: address("4"), relayUrl: "http://127.0.0.1:9999", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: "100", capabilities: ["sum-integers", "python3-json-stdio"], solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128 } }] }],
    allowCredit: true, maxPrice: "1000", deadlineMs, minRemainingMs: 1, maxCompletionTokens: 128,
    economics: { version: 1, minNetRewardRaw: "1", planningCostRaw, borrowerFeeBps: "1500" } };
  const { funding: _funding, ...selection } = config;
  const decision = selectInference({ ...selection, providers: config.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) },
    { atMs: Date.parse(at) - 60000, cash: cashRaw, creditEnabled: true,
      tasks: config.tasks.map(task => ({ ...task, assigned: true, revenue: { rewardRaw: "1000", escrowBalanceRaw: "1000", protocolFeeBps: "300" } })) });
  const physicalModels = { cheap: "original-cheap", strong: "original-strong" };
  const snapshot = { agent: agent.id, owner: agent.owner, wallet: agent.wallet, request: request.requestId, action: request.action, reservedRaw: request.reservedRaw,
    settings: { name: agent.name, modelId: agent.modelId, strategy: agent.strategy, perRunBudgetRaw: agent.perRunBudgetRaw, totalBudgetRaw: agent.totalBudgetRaw, allowCredit: agent.allowCredit },
    workflow: config, physicalModels, config: { models: [{ id: agent.modelId, physicalModels: structuredClone(physicalModels), templates: { balanced: structuredClone(config) } }] } };
  const prefix = `agents/${agent.id}/runs/${parentRequestId ? `${parentRequestId}/children/` : ""}${request.requestId}/task-executor`;
  const executorPath = await save(base, `${prefix}/session.json`, { version: 1, binding: digest(snapshot), snapshot, result: request.result,
    rawTransaction: "SECRET_SIGNED", privateResponse: "SECRET_RESPONSE", providerKey: "SECRET_KEY" });
  const settlement = request.result?.settlement;
  const workflow = { version: 1, binding: digest(config), config, signer: agent.wallet, decision, observations: [], phase: "Succeeded", reservedPrice: "100", privateResponse: "SECRET_RESPONSE",
    ...(settlement ? { finance: { taskStatus: "3", principal: "0", fee: "0", loanStatus: settlement.loanStatus, repaid: settlement.repaidRaw, slashed: settlement.slashedRaw, residual: settlement.residualRaw } } : {}) };
  const workflowPath = await save(base, `${prefix}/workflow/session.json`, workflow);
  return { executorPath, workflowPath, snapshot, workflow };
}

test("independent history: only the original bound admission and matching settled proceeds derive protocol attribution", async () => directory(async base => {
  const data = input(), task = run(data.agent), files = await admission(base, data.agent, task);
  const before = await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]);
  const oldFetch = globalThis.fetch; let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error("NO_NETWORK_PERMITTED"); };
  try {
    data.agent.modelId = "current-model-changed"; data.agent.strategy = "aggressive";
    const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task], observedAt: at });
    assert.equal(value.platform.derivedProtocolFeeRaw, "30"); assert.equal(value.platform.knownDerivedProtocolFeeRaw, "30");
    assert.equal(value.platform.treasuryReceiptsRaw, null); assert.equal(value.platform.actualProfitRaw, null);
    assert.equal(value.agent.settlementOperatingRaw, "870"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "100");
    assert.equal(value.suppliers.actualProfitRaw, null); assert.equal(value.subsidy.rewardTokensRemaining, null);
    assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(outbound, 0);
    assert.deepEqual(await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]), before);
    assert.equal((await readdir(join(base, `agents/${data.agent.id}/runs/${task.requestId}/task-executor`))).some(file => /lock/i.test(file)), false);
  } finally { globalThis.fetch = oldFetch; }
}));

test("independent history: credit principal is financing, and only the settled borrowing fee reaches the credit-vault column", async () => directory(async base => {
  const data = input(), task = run(data.agent, { fromCashRaw: "20", fromCreditRaw: "80", settlement: settled("92", "878", "2"), principalRaw: "0", feeRaw: "0" });
  await admission(base, data.agent, task, undefined, "20");
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task], observedAt: at });
  assert.equal(value.agent.loanPrincipalRaw, "80"); assert.equal(value.agent.borrowingFeeRaw, "12");
  assert.equal(value.agent.taskRevenueRaw, "970"); assert.equal(value.agent.netServiceCostRaw, "100"); assert.equal(value.agent.settlementOperatingRaw, "858");
  assert.equal(value.platform.creditFeeSettledRaw, "12"); assert.equal(value.platform.derivedProtocolFeeRaw, "30"); assert.equal(value.platform.treasuryReceiptsRaw, null);
}));

test("independent retained cash receipt: the original signed task payment belongs to its business task and payee", async () => directory(async base => {
  const data = input(), wallet = Wallet.createRandom(); data.agent.wallet = wallet.address; data.agent.binding!.wallet = wallet.address;
  if (data.finance.status !== "confirmed") assert.fail(); data.finance.wallet = wallet.address;
  const task = run(data.agent), files = await admission(base, data.agent, task), provider = files.workflow.config.providers[0];
  const body: ChatInput = { agentId: "1", taskId: "1", service: provider.service, model: provider.model, messages: [{ role: "user", content: "SECRET_PROMPT" }], solve: provider.routes[0].solve as unknown as Json };
  const requestHash = requestDigest(body), nonce = "0x" + "d".repeat(64), id = paymentId("1", requestHash, nonce);
  const rawTransaction = await wallet.signTransaction({ chainId: 10143, nonce: 0, to: address("1"), gasLimit: 300000, gasPrice: 1,
    data: accountInterface.encodeFunctionData("payProvider", [1, provider.payTo, 100, id, EMPTY_AUTH, "0x"]) });
  const paymentHash = keccak256(rawTransaction);
  const handle: PaymentHandle = { version: 1, relayUrl: provider.relayUrl, input: body, creditNonce: "0",
    quote: { paymentId: id, agentId: "1", taskId: "1", requestDigest: requestHash, serverNonce: nonce, service: provider.service, model: provider.model, price: "100", payTo: provider.payTo,
      asset: address("2"), chainId: "10143", account: address("1"), quoteExpiry: "1792202460", createdBlock: 1 },
    submission: { rawTransaction, txHash: paymentHash, nonce: 0, from: wallet.address } };
  task.result!.paymentId = id; task.result!.paymentTxHash = paymentHash;
  const workflow = { ...files.workflow, handle };
  await writeFile(files.executorPath, JSON.stringify({ version: 1, binding: digest(files.snapshot), snapshot: files.snapshot, result: task.result }));
  await writeFile(files.workflowPath, JSON.stringify(workflow));
  const before = await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]);
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task], observedAt: at });
  assert.equal(value.suppliers.netReceiptsRaw, "100"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "0"); assert.equal(value.suppliers.rows.length, 1);
  assert.equal(value.suppliers.rows[0].providerId, "original-provider"); assert.equal(value.suppliers.rows[0].payTo.toLowerCase(), provider.payTo.toLowerCase());
  assert.equal(value.suppliers.actualProfitRaw, null); assert.equal(JSON.stringify(value).includes(rawTransaction), false); assert.equal(JSON.stringify(value).includes("SECRET_PROMPT"), false);
  assert.deepEqual(await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]), before);
}));

async function signedCashHandle(wallet: Pick<Wallet, "address" | "signTransaction">, amount: string, nonce: number, route: { provider: string; service: string; model: string; relayUrl: string }): Promise<PaymentHandle> {
  const body: ChatInput = { agentId: "1", taskId: "0", service: route.service, model: route.model, messages: [{ role: "user", content: `SECRET_PROMPT_${nonce}` }] };
  const requestHash = requestDigest(body), serverNonce = "0x" + createHash("sha256").update(`controlled-cash-${nonce}`).digest("hex"), id = paymentId("0", requestHash, serverNonce);
  const rawTransaction = await wallet.signTransaction({ chainId: 10143, nonce, to: address("1"), gasLimit: 300000, gasPrice: 1,
    data: accountInterface.encodeFunctionData("payProvider", [1, route.provider, amount, id, EMPTY_AUTH, "0x"]) });
  return { version: 1, relayUrl: route.relayUrl, input: body, creditNonce: "0",
    quote: { paymentId: id, agentId: "1", taskId: "0", requestDigest: requestHash, serverNonce, service: route.service, model: route.model, price: amount, payTo: route.provider,
      asset: address("2"), chainId: "10143", account: address("1"), quoteExpiry: "1792202460", createdBlock: 1 },
    submission: { rawTransaction, txHash: keccak256(rawTransaction), nonce, from: wallet.address } };
}

test("independent goal receipts: two original signed cash calls map once to an aggregate entry without a paymentId", async () => directory(async base => {
  const data = input(), wallet = Wallet.createRandom(); data.agent.wallet = wallet.address; data.agent.binding!.wallet = wallet.address;
  if (data.finance.status !== "confirmed") assert.fail(); data.finance.wallet = wallet.address;
  const provision = run(data.agent, { phase: "Ready", chargedRaw: "0", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined, cashRaw: "0" }, "provision");
  await admission(base, data.agent, provision);
  const goal = run(data.agent, { phase: "Completed", chargedRaw: "30", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined }, "goal");
  const routes = ["12", "18"].map((priceRaw, index) => ({ id: `original-goal-${index}`, provider: address(String(index + 4)), service: "infercredit/chat", model: `original-goal-model-${index}`, relayUrl: "http://127.0.0.1:9999", priceRaw }));
  const calls = await Promise.all(routes.map(async (route, index) => ({ stage: `phase-${index}`, started: true, route,
    handle: await signedCashHandle(wallet, route.priceRaw, index, route), response: { chargedRaw: route.priceRaw, text: "SECRET_RESPONSE", promptTokens: 1, completionTokens: 1 } })));
  const identity = { goal: "SECRET_GOAL", owner: data.agent.owner, wallet: wallet.address, agentId: data.agent.id, chainAgentId: "1", chainId: "10143", strategy: "balanced", reservedRaw: "1000" };
  const journal = await save(base, `agents/${data.agent.id}/runs/${goal.requestId}/mission/session.json`, { version: 1,
    binding: createHash("sha256").update(JSON.stringify({ requestId: goal.requestId, ...identity })).digest("hex"), input: identity, route: routes[0], routes, calls, privateKey: "SECRET_KEY" });
  const before = await readFile(journal, "utf8");
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [provision, goal], observedAt: at });
  assert.equal(value.agent.netServiceCostRaw, "30"); assert.equal(value.agent.settlementOperatingRaw, "-30");
  assert.equal(value.suppliers.netReceiptsRaw, "30"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "0"); assert.equal(value.suppliers.rows.length, 2);
  assert.deepEqual(value.suppliers.rows.map(row => row.netReceiptsRaw).sort(), ["12", "18"]); assert.equal(value.suppliers.actualProfitRaw, null);
  assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(await readFile(journal, "utf8"), before);
}));

test("independent planner receipts: repeated original-route calls aggregate once without adding the parent charge again", async () => directory(async base => {
  const data = input(), wallet = Wallet.createRandom(); data.agent.wallet = wallet.address; data.agent.binding!.wallet = wallet.address;
  if (data.finance.status !== "confirmed") assert.fail(); data.finance.wallet = wallet.address;
  const provision = run(data.agent, { phase: "Ready", chargedRaw: "0", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined, cashRaw: "0" }, "provision");
  await admission(base, data.agent, provision);
  const parent = run(data.agent, { phase: "Completed", chargedRaw: "30", fromCashRaw: undefined, fromCreditRaw: undefined, taskId: undefined, settlement: undefined }, "autonomous");
  const route = { provider: address("4"), service: "infercredit/chat", model: "original-planner-model", relayUrl: "http://127.0.0.1:9999" };
  const config = { plannerProvider: route.provider, plannerService: route.service, plannerModel: route.model, plannerRelayUrl: route.relayUrl, plannerPhysicalModel: "original-physical-planner", plannerPriceRaw: "15" };
  const prefix = `agents/${data.agent.id}/runs/${parent.requestId}`, steps = [];
  for (let index = 0; index < 2; index++) {
    const decisionId = randomUUID(), context = { step: index, privatePrompt: "SECRET_CONTEXT" }, handle = await signedCashHandle(wallet, "15", index, route);
    steps.push({ decisionId, context, decisionChargedRaw: "15", decisionRefundedRaw: "0" });
    await save(base, `${prefix}/planner/${decisionId}/session.json`, { version: 1, context, handle, privateResponse: "SECRET_RESPONSE" });
  }
  const host = await save(base, `${prefix}/autonomy-host/session.json`, { version: 1, input: { agent: data.agent, run: parent }, config, children: {}, privateKey: "SECRET_KEY" });
  const loop = await save(base, `${prefix}/autonomy-loop/session.json`, { version: 1, config: { sessionId: parent.requestId }, phase: "Completed", chargedRaw: "30", steps });
  const before = await Promise.all([readFile(host, "utf8"), readFile(loop, "utf8")]);
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [provision, parent], observedAt: at });
  assert.equal(value.agent.netServiceCostRaw, "30"); assert.equal(value.agent.settlementOperatingRaw, "-30");
  assert.equal(value.suppliers.netReceiptsRaw, "30"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "0"); assert.equal(value.suppliers.rows.length, 1);
  assert.equal(value.suppliers.rows[0].providerId, "autonomy-planner"); assert.equal(value.suppliers.rows[0].paymentCount, 2); assert.equal(value.suppliers.rows[0].netReceiptsRaw, "30");
  assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.deepEqual(await Promise.all([readFile(host, "utf8"), readFile(loop, "utf8")]), before);
}));

test("independent history: predicted fees and inconsistent settlement proceeds never become received fees", async () => directory(async base => {
  for (const variant of ["missing", "settlement", "binding", "recomputed-foreign-asset"]) {
    const data = input(), task = run(data.agent);
    if (variant !== "missing") {
      const files = await admission(base, data.agent, task);
      if (variant === "settlement") {
        task.result!.settlement!.residualRaw = "971";
        await writeFile(files.executorPath, JSON.stringify({ version: 1, binding: digest(files.snapshot), snapshot: files.snapshot, result: task.result }));
      }
      if (variant === "binding") {
        const saved = JSON.parse(await readFile(files.executorPath, "utf8")); saved.snapshot.owner = address("9");
        saved.binding = digest(saved.snapshot); await writeFile(files.executorPath, JSON.stringify(saved));
      }
      if (variant === "recomputed-foreign-asset") {
        const changed = structuredClone(files.snapshot); changed.workflow.asset = address("9");
        await writeFile(files.executorPath, JSON.stringify({ version: 1, binding: digest(changed), snapshot: changed, result: task.result }));
        const { funding: _funding, ...selection } = changed.workflow;
        const decision = selectInference({ ...selection, providers: changed.workflow.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) }, files.workflow.decision.snapshot);
        await writeFile(files.workflowPath, JSON.stringify({ ...files.workflow, config: changed.workflow, binding: digest(changed.workflow), decision }));
      }
    }
    const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task], observedAt: at });
    assert.equal(value.platform.derivedProtocolFeeRaw, null, variant); assert.equal(value.platform.treasuryReceiptsRaw, null, variant);
    assert.equal(value.platform.actualProfitRaw, null, variant); assert.equal(value.platform.knownDerivedProtocolFeeRaw, "0", variant);
    assert.ok(value.platform.gaps.length > 0, variant);
  }
}));

test("independent history: child and planner charges are counted once even when the child is also browser-visible", async () => directory(async base => {
  const data = input(), child = run(data.agent), parent = run(data.agent, { phase: "Completed", chargedRaw: "103", fromCashRaw: undefined, taskId: undefined, settlement: undefined }, "autonomous");
  await admission(base, data.agent, child, parent.requestId, "10000", "3");
  const prefix = `agents/${data.agent.id}/runs/${parent.requestId}`;
  await save(base, `${prefix}/autonomy-host/session.json`, { version: 1, input: { agent: data.agent, run: parent }, children: { [child.requestId]: { agent: data.agent, run: child } }, privateKey: "SECRET" });
  await save(base, `${prefix}/autonomy-loop/session.json`, { version: 1, config: { sessionId: parent.requestId }, phase: "Completed", chargedRaw: "103",
    steps: [{ decisionChargedRaw: "3", childId: child.requestId, decision: { action: "run-task", modelId: data.agent.modelId, funding: "cash" }, outcome: { terminal: true, success: true, chargedRaw: "100" } }] });
  for (const runs of [[parent, child], [child, parent]]) {
    const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs, observedAt: at });
    assert.equal(value.agent.netServiceCostRaw, "103"); assert.equal(value.agent.settlementOperatingRaw, "867");
    assert.equal(value.platform.knownDerivedProtocolFeeRaw, "30"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "103");
    assert.equal(JSON.stringify(value).includes("SECRET"), false);
  }
}));

test("independent privacy: foreign runs and symlinked private journals never enter the owner role report", async () => directory(async base => {
  const data = input(), task = run(data.agent), foreignAgent = actor(), foreign = run(foreignAgent);
  const secret = await save(base, "global-operator-book.json", { version: 1, privateKey: "SECRET_KEY", actualProfitRaw: "999999999", response: "SECRET_RESPONSE", provider: "SECRET_GLOBAL_PROVIDER" });
  const taskPath = join(base, `agents/${data.agent.id}/runs/${task.requestId}/task-executor/session.json`);
  await mkdir(join(taskPath, ".."), { recursive: true }); await symlink(secret, taskPath);
  const before = await readFile(secret, "utf8");
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task, foreign], observedAt: at });
  assert.equal(value.coverage.runCount, 1); assert.equal(value.platform.derivedProtocolFeeRaw, null);
  assert.equal(value.suppliers.rows.length, 0); assert.equal(JSON.stringify(value).includes("SECRET"), false); assert.equal(JSON.stringify(value).includes(foreign.requestId), false);
  assert.equal(await readFile(secret, "utf8"), before);
}));

test("independent history: invalid charge evidence retains the known charge and never manufactures zero-cost profit", async () => directory(async base => {
  const data = input(), task = run(data.agent);
  (task.result as unknown as Record<string, unknown>).chargedRaw = "malformed";
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [task], observedAt: at });
  assert.equal(value.agent.netServiceCostRaw, "100"); assert.equal(value.agent.settlementOperatingRaw, null);
  assert.equal(value.platform.derivedProtocolFeeRaw, null); assert.equal(value.runway.status, "unknown"); assert.equal(value.runway.horizonMs, null);
  assert.equal(value.agent.actualProfitRaw, null);
}));

test("independent history: a confirmed zero-cost pre-admission rejection does not invent an unknown financial liability", async () => directory(async base => {
  const data = input(), rejected = run(data.agent, { phase: "Stopped", success: false, chargedRaw: "0", fromCashRaw: "0", fromCreditRaw: "0", taskId: undefined,
    paymentId: undefined, settlement: undefined, reason: "WORKFLOW_SELECTION_REJECTED" });
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs: [rejected], observedAt: at,
    preview: { burn: { amountRaw: "1", windowMs: 60000 } } });
  assert.equal(value.agent.netServiceCostRaw, "0"); assert.equal(value.agent.settlementOperatingRaw, "0");
  assert.equal(value.platform.derivedProtocolFeeRaw, "0"); assert.equal(value.platform.creditFeeSettledRaw, "0");
  assert.equal(value.runway.status, "finite"); assert.equal(value.platform.treasuryReceiptsRaw, null);
}));

test("independent history: bounded role output never drops aggregate charges or turns missing data into zero burn", async () => directory(async base => {
  const data = input(), runs = Array.from({ length: 201 }, (_, index) => run(data.agent, { taskId: String(index + 1) }));
  data.agent.spentRaw = "20100";
  const value = await readHostedOperatingReport({ directory: base, agent: data.agent, finance: data.finance, runs, observedAt: at });
  assert.equal(value.agent.netServiceCostRaw, "20100"); assert.equal(value.suppliers.unattributedNetServiceCostRaw, "20100");
  assert.equal(value.coverage.entriesTruncated, true); assert.equal(value.coverage.roleEntriesTruncated, true);
  assert.equal(value.platform.derivedProtocolFeeRaw, null); assert.equal(value.runway.status, "unknown"); assert.equal(value.runway.horizonMs, null);
  assert.equal(JSON.stringify(value).includes("Infinity"), false);
}));

test("independent owner API: authorization precedes private reads; previews cannot mutate executions or submit operator books", { timeout: 10000 }, async () => directory(async base => {
  const owners = [Wallet.createRandom(), Wallet.createRandom()]; let executions = 0, financeCalls = 0;
  const service = await HostedService.open({ directory: base, origin: "http://127.0.0.1:3000", chainId: "10143", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 2, maxTotalBudgetRaw: "10000", maxPerRunBudgetRaw: "100" }, {
    async execute(execution) { executions++; return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", cashRaw: "1000", binding: { chainId: "10143", agentId: "1", wallet: execution.agent.wallet } }; },
    async finance() { financeCalls++; return { status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_UNCONFIRMED" }; },
  });
  const server = createHostedHttpServer(service); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, token?: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) => fetch(origin + path, { method,
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const tokens: string[] = [];
    for (const owner of owners) { const challenge = await service.challenge(owner.address); tokens.push((await service.login(challenge.id, await owner.signMessage(challenge.message))).token); }
    const agent = await service.create(owners[0].address, { requestId: randomUUID(), name: "Audit", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "10000", allowCredit: true });
    await service.waitUntilIdle();
    const path = `/agents/${agent.id}/operating-report`, database = join(base, "database", "session.json"), before = await readFile(database, "utf8"), callsBefore = executions;
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, tokens[1])).status, 404); assert.equal((await request(path, tokens[1], "POST", {})).status, 404);
    assert.equal((await request(path, tokens[0], "PATCH", {})).status, 405);
    assert.equal((await request(path + "?owner=foreign", tokens[0])).status, 400);
    assert.equal((await request(path, tokens[0], "POST", {}, { origin: "https://foreign.invalid" })).status, 403); assert.equal(financeCalls, 0);
    const response = await request(path, tokens[0]); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    const report = await response.json(); assert.equal(report.mode, "read-only"); assert.equal(report.scope, "owner-agent-contribution"); assert.equal(report.platform.actualProfitRaw, null);
    const scenario = await request(path, tokens[0], "POST", { recurringCostRaw: "10", burn: { amountRaw: "5", windowMs: 60000 }, subsidyBudgetRaw: "50" });
    assert.equal(scenario.status, 200); assert.equal((await scenario.json()).scenario.source, "owner-hypothetical");
    for (const body of [{ evidence: { platformReceiptsRaw: "999" } }, { operator: { costsRaw: "0" } }, { role: "platform" }, { privateKey: "SECRET" }, { burn: { amountRaw: "-1", windowMs: 1 } }]) {
      assert.equal((await request(path, tokens[0], "POST", body)).status, 400);
    }
    assert.equal(financeCalls, 2); assert.equal(executions, callsBefore); assert.equal(await readFile(database, "utf8"), before);
    assert.equal(JSON.stringify(report).includes(base), false); assert.equal(JSON.stringify(report).includes(owners[1].address), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); }
}));

test("independent owner API: a state change during finance I/O invalidates the old cash snapshot", { timeout: 10000 }, async () => directory(async base => {
  const owner = Wallet.createRandom(); let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = await HostedService.open({ directory: base, origin: "http://127.0.0.1:3000", chainId: "10143", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 2, maxTotalBudgetRaw: "10000", maxPerRunBudgetRaw: "100" }, {
    async execute(execution) { return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", cashRaw: "1000", binding: { chainId: "10143", agentId: "1", wallet: execution.agent.wallet } }; },
    async finance(agent) {
      const observedAt = new Date().toISOString(); started(); await gate;
      const financial = input().finance; if (financial.status !== "confirmed") assert.fail();
      return { ...financial, wallet: agent.wallet, observedAt, block: { ...financial.block, timestamp: Math.floor(Date.parse(observedAt) / 1000) } };
    },
  });
  try {
    const agent = await service.create(owner.address, { requestId: randomUUID(), name: "Audit", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "10000", allowCredit: true }); await service.waitUntilIdle();
    const pending = service.operatingReport(owner.address, agent.id, { burn: { amountRaw: "1", windowMs: 60000 } }); await began;
    await service.pause(owner.address, agent.id, true); const before = await readFile(join(base, "database", "session.json"), "utf8"); release();
    const report = await pending; assert.equal(report.cash.status, "unavailable"); assert.equal(report.cash.spendableCashRaw, null); assert.equal(report.runway.status, "unknown");
    assert.equal(await readFile(join(base, "database", "session.json"), "utf8"), before);
  } finally { release(); await service.close(); }
}));
