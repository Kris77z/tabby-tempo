import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { canonical, type Json } from "@agentfuel/sdk";
import { selectInference } from "../../../packages/pi-loop/src/selector.js";
import type { WorkflowConfig } from "../../../packages/pi-loop/src/workflow.js";
import { assessHostedStrategyAdvice, validateStrategyAdvicePreview } from "../src/strategy-advice.js";
import { readHostedStrategyAdvice } from "../src/strategy-history.js";
import { HostedService } from "../src/service.js";
import type { HostedAccounting, HostedAgent, HostedFinance, HostedResult, HostedRun } from "../src/types.js";
import type { StrategyAdviceInput, StrategyHistoryEntry, StrategyPreviewCandidate } from "../src/strategy-types.js";

const auditAt = "2026-10-17T01:00:00.000Z";
const auditHash = "0x" + "a".repeat(64);
function auditAgent(): HostedAgent {
  return { id: randomUUID(), owner: "0x" + "b".repeat(40), wallet: "0x" + "c".repeat(40), name: "Audit", modelId: "controlled", strategy: "balanced",
    perRunBudgetRaw: "1000", totalBudgetRaw: "100000", allowCredit: true, status: "Ready", spentRaw: "0", reservedRaw: "0", createdAt: auditAt, updatedAt: auditAt,
    binding: { chainId: "10143", agentId: "1", wallet: "0x" + "c".repeat(40) } };
}
function auditInput(): StrategyAdviceInput {
  const agent = auditAgent();
  const finance: HostedFinance = { status: "confirmed", observedAt: auditAt, chainId: "10143", agentId: "1", wallet: agent.wallet,
    block: { number: 1, hash: auditHash, timestamp: Date.parse(auditAt) / 1000 }, cashRaw: "10000", debtRaw: "0", scannedTaskCount: 1, ownedTaskCount: 1,
    credit: { score: "1", tier: "A", tierCapRaw: "10000", feeBps: "1500", eligible: true, rejection: null },
    policy: { maxCashPerTxRaw: "10000", maxDebtPerTxRaw: "10000", maxDebtPerDayRaw: "10000", ownerFrozen: false },
    counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
  const accounting: HostedAccounting = { version: 1, observedAt: auditAt, agentId: agent.id, currency: "USDC", decimals: 6, status: "complete",
    totals: { taskRevenueRaw: "0", inferenceCostRaw: "0", borrowingFeeRaw: "0", refundsRaw: "0", gameSubsidyRaw: "0", ownerCapitalRaw: "0", startupCapitalRaw: "0", loanPrincipalRaw: "0", creditsGranted: 0, creditsUsed: 0, netOperatingRaw: "0" },
    coverage: { scope: "retained-hosted-history", since: null, runCount: 0, entryCount: 0, pendingCount: 0, incompleteCount: 0, returnedEntryCount: 0, entriesTruncated: false, uncoveredSpentRaw: "0", reasons: [] }, entries: [] };
  return { agent, finance, accounting, history: { scope: "retained-hosted-history", entries: [], entryCount: 0, entriesTruncated: false, gaps: [] }, observedAt: auditAt };
}
function auditCandidate(providerId = "fixed-a", extra: Partial<StrategyPreviewCandidate> = {}): StrategyPreviewCandidate {
  return { taskId: "1", problemId: "sum-integers", providerId, tier: "cheap", funding: "cash", executionCostRaw: "100", planningCostRaw: "10", borrowerFeeBps: "1500", creditLimitRaw: "1000",
    routeBinding: "a".repeat(64), rewardRaw: "1000", escrowBalanceRaw: "1000", protocolFeeBps: "0", deadlineMs: Date.parse(auditAt) + 60000, ...extra };
}
function auditHistory(providerId = "fixed-a", extra: Partial<StrategyHistoryEntry> = {}): StrategyHistoryEntry {
  return { requestId: randomUUID(), at: auditAt, action: "task", outcome: "succeeded",
    prediction: { source: "original-workflow-admission", atMs: Date.parse(auditAt) - 60000, snapshotHash: auditHash, taskId: "1", problemId: "sum-integers", providerId, tier: "cheap", funding: "cash",
      routeBinding: "a".repeat(64), executionCostRaw: "100", planningCostRaw: "10", borrowerFeeRaw: "0", netRevenueRaw: "1000", netRewardRaw: "890", originalMinNetRewardRaw: "1" },
    realized: { status: "confirmed", executionCostRaw: "100", borrowingFeeRaw: "0", taskRevenueRaw: "1000", planningCostRaw: "10", taskContributionRaw: "900", netAfterPlanningRaw: "890", failureLossRaw: null, knownFailureLossLowerBoundRaw: null },
    executionCostDeviationRaw: "0", gaps: [], ...extra };
}

test("audit: a confirmed cost overrun changes the next hypothetical choice, with exact route cohorts", () => {
  const input = auditInput();
  input.preview = { candidates: [auditCandidate(), auditCandidate("fixed-b", { executionCostRaw: "150" })] };
  input.history.entries = [auditHistory(), auditHistory("fixed-b")];
  assert.equal(assessHostedStrategyAdvice(input).recommendation.providerId, "fixed-a");
  const prior = input.history.entries[0];
  prior.realized = { ...prior.realized, executionCostRaw: "200", taskContributionRaw: "800", netAfterPlanningRaw: "790" };
  prior.executionCostDeviationRaw = "100";
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.recommendation.providerId, "fixed-b");
  assert.equal(value.candidates[0].adjustedExecutionCostRaw, "200");
  assert.equal(value.candidates[1].adjustedExecutionCostRaw, "150");
  assert.equal(value.candidates[1].observedCostBufferRaw, "0");
  assert.equal(value.mode, "advisory-only");
  assert.deepEqual(value.recommendation.reasons, ["STRATEGY_HYPOTHETICAL_ONLY"]);
});

test("audit: a net failed loss raises the required profit and changes ranking without treating counts as probabilities", () => {
  const input = auditInput();
  input.preview = { candidates: [auditCandidate(), auditCandidate("fixed-b", { executionCostRaw: "150" })] };
  input.history.entries = [auditHistory(), auditHistory("fixed-b")];
  assert.equal(assessHostedStrategyAdvice(input).recommendation.providerId, "fixed-a");
  const failed = auditHistory();
  failed.outcome = "failed";
  failed.realized = { ...failed.realized, taskRevenueRaw: "0", taskContributionRaw: "-100", netAfterPlanningRaw: "-110", failureLossRaw: "110", knownFailureLossLowerBoundRaw: "110" };
  input.history.entries.push(failed);
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.recommendation.providerId, "fixed-b");
  assert.equal(value.candidates[0].requiredProfitRaw, "210");
  assert.equal(value.candidates[0].observedFailureLossRaw, "110");
  assert.equal(value.candidates[0].failedComparableCount, 1);
  assert.equal(value.history.knownFailureLossRaw, "110");
  assert.deepEqual(value.exclusions, ["chain-fees", "reward-token-opportunity-cost", "success-probability"]);
  assert.equal(Object.keys(value.candidates[0]).some(key => /probability|successRate|expectedProfit/i.test(key)), false);
});

test("audit: historical model hints cannot cross problem, provider, tier or funding boundaries", () => {
  const input = auditInput();
  input.preview = { candidates: [auditCandidate()] };
  const mismatches = [
    { problemId: "unique-sorted" }, { providerId: "fixed-b" }, { tier: "strong" as const }, { funding: "task-credit" as const }, { routeBinding: "b".repeat(64) },
  ];
  input.history.entries = mismatches.map(mismatch => {
    const row = auditHistory();
    row.prediction = { ...row.prediction!, ...mismatch };
    row.executionCostDeviationRaw = "999";
    return row;
  });
  input.history.entries.push(auditHistory("fixed-a", { prediction: null, executionCostDeviationRaw: null }));
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.candidates[0].comparableCount, 0);
  assert.equal(value.candidates[0].observedCostBufferRaw, null);
  assert.equal(value.candidates[0].status, "insufficient-evidence");
  assert.ok(value.candidates[0].gaps.includes("STRATEGY_COMPARABLE_HISTORY_MISSING"));
  assert.equal(value.recommendation.status, "blocked");
});

test("audit: reserve holds after planning and execution; credit never pays for planning or props up the floor", () => {
  const input = auditInput();
  if (input.finance.status !== "confirmed") assert.fail();
  input.finance.cashRaw = "1110";
  input.history.entries = [auditHistory()];
  input.preview = { candidates: [auditCandidate()] };
  const equal = assessHostedStrategyAdvice(input);
  assert.equal(equal.candidates[0].cashAfterRaw, "1000");
  assert.equal(equal.candidates[0].status, "eligible");
  input.finance.cashRaw = "1109";
  const under = assessHostedStrategyAdvice(input);
  assert.ok(under.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
  assert.equal(under.recommendation.status, "no-eligible-candidate");
  input.finance.cashRaw = "5";
  input.history.entries[0].prediction!.funding = "task-credit";
  input.preview = { policy: { reserveCashRaw: "0", minProfitRaw: "1", minMarginBps: "1000" }, candidates: [auditCandidate("fixed-a", { funding: "task-credit" })] };
  const noPlannerCash = assessHostedStrategyAdvice(input);
  assert.ok(noPlannerCash.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
  assert.ok(noPlannerCash.candidates[0].gaps.includes("STRATEGY_DAILY_CREDIT_USAGE_UNKNOWN"));
  assert.equal(noPlannerCash.cash.creditIncluded, false);
});

test("audit: unresolved amounts block a choice and full active reservations are withheld without mutation", () => {
  const input = auditInput();
  input.preview = { candidates: [auditCandidate()] };
  input.history.entries = [auditHistory()];
  input.accounting.status = "partial";
  input.accounting.coverage.reasons = ["ACCOUNTING_PAYMENT_UNRESOLVED"];
  input.accounting.totals.netOperatingRaw = null;
  input.agent.reservedRaw = "500";
  const before = JSON.stringify(input);
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.recommendation.status, "blocked");
  assert.equal(value.cash.pendingCommitmentsRaw, "500");
  assert.equal(value.cash.availableBeforeReserveRaw, "9500");
  assert.equal(value.cash.spendableCashRaw, "8500");
  assert.equal(value.history.netOperatingRaw, null);
  assert.ok(value.candidates[0].gaps.includes("STRATEGY_UNRESOLVED_LIABILITIES"));
  assert.equal(JSON.stringify(input), before);
});

test("audit: minimum margin rounds up in integer units and uses net task revenue", () => {
  const input = auditInput();
  input.preview = { candidates: [auditCandidate("fixed-a", { rewardRaw: "101", escrowBalanceRaw: "101", protocolFeeBps: "1000", executionCostRaw: "80", planningCostRaw: "1" })] };
  input.history.entries = [auditHistory()];
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.candidates[0].netRevenueRaw, "91");
  assert.equal(value.candidates[0].requiredProfitRaw, "10");
  assert.equal(value.candidates[0].successfulCompletionProfitRaw, "10");
  assert.equal(value.candidates[0].status, "eligible");
  input.preview.candidates![0].executionCostRaw = "81";
  assert.ok(assessHostedStrategyAdvice(input).candidates[0].reasons.includes("STRATEGY_MINIMUM_PROFIT"));
});

test("audit: preview schema refuses private payloads, negative or oversized raw amounts and fake token proof", () => {
  for (const preview of [
    { privateKey: "SECRET" }, { policy: { reserveCashRaw: "0", minProfitRaw: "1", minMarginBps: "1000", owner: "SECRET" } },
    { candidates: [{ ...auditCandidate(), relayUrl: "SECRET" }] },
    { candidates: [{ ...auditCandidate(), rewardRaw: "-1" }] },
    { candidates: [{ ...auditCandidate(), rewardRaw: (1n << 256n).toString() }] },
    { candidates: [{ ...auditCandidate(), protocolFeeBps: "10001" }] },
    { candidates: [auditCandidate(), auditCandidate()] },
  ]) assert.throws(() => validateStrategyAdvicePreview(preview), /HOSTED_STRATEGY_PREVIEW_INVALID/);
  const input = auditInput();
  const prior = auditHistory(); prior.prediction!.funding = "reward-tokens";
  input.history.entries = [prior];
  input.preview = { candidates: [auditCandidate("fixed-a", { funding: "reward-tokens", executionCostRaw: "0", tokenFundingConfirmed: true })] };
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.candidates[0].status, "insufficient-evidence");
  assert.ok(value.candidates[0].gaps.includes("STRATEGY_TOKEN_BALANCE_UNVERIFIED"));
});

test("audit: a confirmed finance object must match the selected on-chain identity and advice time", () => {
  const cases = [
    { chainId: "31337" }, { agentId: "999" }, { wallet: "0x" + "d".repeat(40) },
    { observedAt: "2026-10-17T02:00:00.000Z" }, { observedAt: "2026-10-16T01:00:00.000Z" },
  ];
  for (const mismatch of cases) {
    const input = auditInput();
    if (input.finance.status !== "confirmed") assert.fail();
    input.finance = { ...input.finance, ...mismatch };
    input.history.entries = [auditHistory()];
    input.preview = { candidates: [auditCandidate()] };
    const value = assessHostedStrategyAdvice(input);
    assert.equal(value.recommendation.status, "blocked", JSON.stringify(mismatch));
    assert.equal(value.cash.status, "unavailable", JSON.stringify(mismatch));
    assert.equal(value.cash.cashRaw, null, JSON.stringify(mismatch));
  }
});

test("audit: future historical results and future original predictions cannot improve a present preview", () => {
  for (const futurePrediction of [false, true]) {
    const input = auditInput();
    const row = auditHistory();
    if (futurePrediction) row.prediction!.atMs = Date.parse(auditAt) + 60000;
    else row.at = "2026-10-17T02:00:00.000Z";
    input.history.entries = [row];
    input.preview = { candidates: [auditCandidate()] };
    const value = assessHostedStrategyAdvice(input);
    assert.equal(value.candidates[0].comparableCount, 0);
    assert.equal(value.recommendation.status, "blocked");
  }
});

const auditDigest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
const auditSettlement = (passed = true) => ({ txHash: auditHash, block: { number: 1, hash: auditHash, timestamp: Date.parse(auditAt) / 1000 }, passed,
  loanStatus: "0", repaidRaw: "0", slashedRaw: "0", residualRaw: passed ? "1000" : "0" });
function auditRun(agent: HostedAgent, extra: Partial<HostedResult> = {}): HostedRun {
  const result: HostedResult = { phase: "Succeeded", terminal: true, success: true, chargedRaw: "120", fromCashRaw: "120", fromCreditRaw: "0", refundedRaw: "0", taskId: "1", settlement: auditSettlement(), ...extra };
  return { requestId: randomUUID(), agentId: agent.id, action: "task", status: result.success ? "Succeeded" : "Failed", createdAt: auditAt, updatedAt: auditAt,
    reservedRaw: "1000", chargedRaw: result.chargedRaw, recoverable: false, result };
}
async function auditDirectory(work: (directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-strategy-independent-")));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function auditSave(directory: string, relative: string, value: unknown) {
  const path = join(directory, relative); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); return path;
}
function auditWorkflow(): WorkflowConfig {
  const atMs = Date.parse(auditAt), end = atMs + 60000;
  return { agentId: "1", chainId: "10143", account: "0x" + "1".repeat(40), asset: "0x" + "2".repeat(40), escrowAddress: "0x" + "3".repeat(40),
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs: end, creditLimit: "1000" }],
    providers: [{ id: "fixed-a", payTo: "0x" + "4".repeat(40), relayUrl: "http://127.0.0.1:9999", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: "100", capabilities: ["sum-integers", "python3-json-stdio"], solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128 } }] }],
    allowCredit: true, maxPrice: "1000", deadlineMs: end, minRemainingMs: 1, maxCompletionTokens: 128,
    economics: { version: 1, minNetRewardRaw: "1", planningCostRaw: "0", borrowerFeeBps: "1500" } };
}
async function auditAdmission(directory: string, agent: HostedAgent, run: HostedRun, parentRequestId?: string, planningCostRaw = "0") {
  const config = auditWorkflow(), { funding: _funding, ...selection } = config;
  config.economics!.planningCostRaw = planningCostRaw;
  const decision = selectInference({ ...selection, providers: config.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) },
    { atMs: Date.parse(auditAt) - 60000, cash: "10000", creditEnabled: true, tasks: config.tasks.map(task => ({ ...task, assigned: true, revenue: { rewardRaw: "1000", escrowBalanceRaw: "1000", protocolFeeBps: "0" } })) });
  const physicalModels = { cheap: "controlled-cheap", strong: "controlled-strong" };
  const snapshot = { agent: agent.id, owner: agent.owner, wallet: agent.wallet, request: run.requestId, action: run.action, reservedRaw: run.reservedRaw,
    settings: { name: agent.name, modelId: agent.modelId, strategy: agent.strategy, perRunBudgetRaw: agent.perRunBudgetRaw, totalBudgetRaw: agent.totalBudgetRaw, allowCredit: agent.allowCredit },
    workflow: config, physicalModels, config: { models: [{ id: agent.modelId, physicalModels: structuredClone(physicalModels), templates: { balanced: structuredClone(config) } }] } };
  const base = `agents/${agent.id}/runs/${parentRequestId ? `${parentRequestId}/children/` : ""}${run.requestId}/task-executor`;
  const executorPath = await auditSave(directory, `${base}/session.json`, { version: 1, binding: auditDigest(snapshot), snapshot, result: run.result, privateResponse: "SECRET_RESPONSE" });
  const workflow = { version: 1, binding: auditDigest(config), config, signer: agent.wallet, decision, observations: [], phase: "Succeeded", reservedPrice: "100", privateResponse: "SECRET_RESPONSE" };
  const workflowPath = await auditSave(directory, `${base}/workflow/session.json`, workflow);
  return { executorPath, workflowPath, workflow, snapshot };
}

test("audit: history recovers original successful admission without recomputing from current settings", async () => auditDirectory(async directory => {
  const input = auditInput(), run = auditRun(input.agent);
  const files = await auditAdmission(directory, input.agent, run);
  const before = await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]);
  input.agent.modelId = "new-model"; input.agent.strategy = "aggressive";
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [run], observedAt: auditAt });
  const row = value.history.entries[0];
  assert.equal(row.prediction?.source, "original-workflow-admission");
  assert.equal(row.prediction.executionCostRaw, "100");
  assert.equal(row.realized.executionCostRaw, "120");
  assert.equal(row.executionCostDeviationRaw, "20");
  assert.equal(row.realized.netAfterPlanningRaw, "880");
  assert.equal(JSON.stringify(value).includes("SECRET"), false);
  assert.deepEqual(await Promise.all([readFile(files.executorPath, "utf8"), readFile(files.workflowPath, "utf8")]), before);
}));

test("audit: changed task or settlement domain invalidates the original prediction", async () => auditDirectory(async directory => {
  const input = auditInput(), run = auditRun(input.agent);
  const files = await auditAdmission(directory, input.agent, run);
  const changedResult = { ...run, result: { ...run.result!, taskId: "2" } };
  const wrongTask = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [changedResult], observedAt: auditAt });
  assert.equal(wrongTask.history.entries[0].prediction, null);
  assert.ok(wrongTask.history.entries[0].gaps.includes("STRATEGY_ADMISSION_BINDING_MISMATCH"));
  const tampered = structuredClone(files.snapshot); tampered.workflow.asset = "0x" + "9".repeat(40);
  // Ordinary digests can be recomputed; the retained template's domain must still match.
  await writeFile(files.executorPath, JSON.stringify({ version: 1, binding: auditDigest(tampered), snapshot: tampered, result: run.result }));
  const { funding: _funding, ...selection } = tampered.workflow;
  const tamperedDecision = selectInference({ ...selection, providers: tampered.workflow.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) }, files.workflow.decision.snapshot);
  await writeFile(files.workflowPath, JSON.stringify({ ...files.workflow, config: tampered.workflow, binding: auditDigest(tampered.workflow), decision: tamperedDecision }));
  const wrongAsset = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [run], observedAt: auditAt });
  assert.equal(wrongAsset.history.entries[0].prediction, null);
  assert.ok(wrongAsset.history.entries[0].gaps.includes("STRATEGY_ADMISSION_BINDING_MISMATCH"));
}));

test("audit: missing original prediction remains null and a conflicting charge is no confirmed loss lower bound", async () => auditDirectory(async directory => {
  const input = auditInput();
  const run = auditRun(input.agent, { phase: "Failed", success: false, chargedRaw: "20", fromCashRaw: "10", settlement: auditSettlement(false) });
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [run], observedAt: auditAt });
  const row = value.history.entries[0];
  assert.equal(row.prediction, null);
  assert.equal(row.executionCostDeviationRaw, null);
  assert.equal(row.realized.failureLossRaw, null);
  assert.equal(row.realized.knownFailureLossLowerBoundRaw, null);
  assert.ok(row.gaps.includes("ACCOUNTING_COST_MISMATCH"));
}));

test("audit: journal symlinks and foreign owners never expose private content or write evidence", async () => auditDirectory(async directory => {
  const input = auditInput(), run = auditRun(input.agent), foreign = auditRun(auditAgent());
  const secret = await auditSave(directory, "private.json", { version: 1, privateKey: "SECRET_KEY", response: "SECRET_RESPONSE", rawTransaction: "SECRET_SIGNED" });
  const snapshotPath = join(directory, `agents/${input.agent.id}/runs/${run.requestId}/task-executor/session.json`);
  await mkdir(join(snapshotPath, ".."), { recursive: true }); await symlink(secret, snapshotPath);
  const before = await readFile(secret, "utf8");
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [run, foreign], observedAt: auditAt });
  assert.equal(value.history.entries.length, 1);
  assert.equal(value.history.entries[0].requestId, run.requestId);
  assert.ok(value.history.entries[0].gaps.includes("STRATEGY_HISTORY_INVALID"));
  assert.equal(JSON.stringify(value).includes("SECRET"), false);
  assert.equal(await readFile(secret, "utf8"), before);
}));

test("audit: reservations admitted during finance I/O are withheld before returning advice", { timeout: 10000 }, async () => auditDirectory(async directory => {
  const owner = Wallet.createRandom();
  let financeStarted!: () => void, releaseFinance!: () => void, releaseTask!: () => void;
  const began = new Promise<void>(resolve => { financeStarted = resolve; });
  const financeGate = new Promise<void>(resolve => { releaseFinance = resolve; });
  const taskGate = new Promise<void>(resolve => { releaseTask = resolve; });
  const service = await HostedService.open({ directory, origin: "http://127.0.0.1:3000", chainId: "10143", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 3, maxTotalBudgetRaw: "100000", maxPerRunBudgetRaw: "1000" }, {
    async execute(input) {
      if (input.run.action === "provision") return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", cashRaw: "0", binding: { chainId: "10143", agentId: "1", wallet: input.agent.wallet } };
      await taskGate;
      return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0" };
    },
    async finance(agent) {
      financeStarted(); await financeGate;
      const snapshot = auditInput().finance;
      if (snapshot.status !== "confirmed") assert.fail();
      const observedAt = new Date().toISOString();
      return { ...snapshot, wallet: agent.wallet, observedAt, block: { ...snapshot.block, timestamp: Math.floor(Date.parse(observedAt) / 1000) } };
    },
  });
  try {
    const agent = await service.create(owner.address, { requestId: randomUUID(), name: "Audit", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "1000", totalBudgetRaw: "100000", allowCredit: true });
    await service.waitUntilIdle();
    const pendingAdvice = service.strategyAdvice(owner.address, agent.id);
    await began;
    await service.command(owner.address, agent.id, { requestId: randomUUID(), action: "task" });
    releaseFinance();
    const value = await pendingAdvice;
    assert.equal(value.cash.pendingCommitmentsRaw, "1000");
    assert.equal(value.cash.status, "unavailable");
    assert.equal(value.cash.availableBeforeReserveRaw, null);
    assert.equal(value.cash.unresolvedLiabilities, true);
  } finally {
    releaseFinance(); releaseTask(); await service.waitUntilIdle(); await service.close();
  }
}));

test("audit: a serialized rejected admission is a real rejection rather than a binding failure", async () => auditDirectory(async directory => {
  const input = auditInput(), run = auditRun(input.agent, { phase: "Stopped", success: false, chargedRaw: "0", fromCashRaw: "0", taskId: undefined, settlement: undefined });
  const files = await auditAdmission(directory, input.agent, run);
  const { funding: _funding, ...selection } = files.workflow.config;
  const rejected = selectInference({ ...selection, providers: selection.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) },
    { ...files.workflow.decision.snapshot, tasks: files.workflow.decision.snapshot.tasks.map(task => ({ ...task, assigned: false })) });
  assert.equal(rejected.selected, undefined);
  const serialized = JSON.stringify({ ...files.workflow, phase: "Stopped", decision: rejected });
  assert.equal("selected" in JSON.parse(serialized).decision, false);
  await writeFile(files.workflowPath, serialized);
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [run], observedAt: auditAt });
  const row = value.history.entries[0];
  assert.equal(row.prediction, null);
  assert.ok(row.gaps.includes("STRATEGY_ORIGINAL_ADMISSION_REJECTED"));
  assert.equal(row.gaps.includes("STRATEGY_ADMISSION_BINDING_MISMATCH"), false);
  assert.equal(row.realized.failureLossRaw, "0");
}));

test("audit: runtime child planning is zero once, and an incomplete parent excludes the child's cohort", async () => auditDirectory(async directory => {
  const input = auditInput(), child = auditRun(input.agent);
  const parent: HostedRun = { ...auditRun(input.agent), action: "autonomous", result: { phase: "Completed", terminal: true, success: true, chargedRaw: "120" } };
  await auditAdmission(directory, input.agent, child, parent.requestId);
  const base = `agents/${input.agent.id}/runs/${parent.requestId}`;
  await auditSave(directory, `${base}/autonomy-host/session.json`, { version: 1, input: { agent: input.agent, run: parent }, children: { [child.requestId]: { agent: input.agent, run: child } } });
  const loop = { version: 1, config: { sessionId: parent.requestId }, phase: "Completed", chargedRaw: "120", steps: [{ decisionSource: "runtime", childId: child.requestId,
    decision: { action: "run-task", modelId: input.agent.modelId, funding: "cash" }, outcome: { terminal: true, success: true, chargedRaw: "120" } }] };
  const loopPath = await auditSave(directory, `${base}/autonomy-loop/session.json`, loop);
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [parent, child], observedAt: auditAt });
  assert.equal(value.history.entries.length, 1);
  const row = value.history.entries[0];
  assert.equal(row.parentRequestId, parent.requestId);
  assert.equal(row.realized.planningCostRaw, "0");
  assert.equal(row.realized.executionCostRaw, "120");
  assert.equal(row.realized.netAfterPlanningRaw, "880");
  assert.equal(row.realized.status, "confirmed");
  assert.equal(row.executionCostDeviationRaw, "20");
  await writeFile(loopPath, JSON.stringify({ ...loop, chargedRaw: "121" }));
  const partial = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [parent, child], observedAt: auditAt,
    preview: { candidates: [auditCandidate("fixed-a", { routeBinding: row.prediction!.routeBinding })] } });
  assert.equal(partial.history.entries[0].realized.status, "incomplete");
  assert.equal(partial.history.entries[0].realized.planningCostRaw, null);
  assert.equal(partial.history.entries[0].executionCostDeviationRaw, null);
  assert.equal(partial.candidates[0].comparableCount, 0);
  assert.equal(partial.recommendation.status, "blocked");
}));

test("audit: known debt is reserved without becoming an operating expense", () => {
  const input = auditInput();
  if (input.finance.status !== "confirmed") assert.fail();
  input.finance.cashRaw = "500"; input.finance.debtRaw = "100";
  input.history.entries = [auditHistory()];
  input.preview = { policy: { reserveCashRaw: "200", minProfitRaw: "1", minMarginBps: "1000" }, candidates: [auditCandidate()] };
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.cash.outstandingDebtRaw, "100");
  assert.equal(value.cash.availableBeforeReserveRaw, "400");
  assert.equal(value.cash.spendableCashRaw, "200");
  assert.equal(value.candidates[0].cashRequiredRaw, "110");
  assert.equal(value.candidates[0].cashAfterRaw, "290");
  assert.equal(value.candidates[0].successfulCompletionProfitRaw, "890");
  assert.equal(value.candidates[0].status, "eligible");
  assert.equal(value.history.netOperatingRaw, "0");
  input.agent.reservedRaw = "50"; input.pendingCommitmentsRaw = "100";
  const pending = assessHostedStrategyAdvice(input);
  assert.equal(pending.cash.pendingCommitmentsRaw, "100");
  assert.equal(pending.cash.availableBeforeReserveRaw, "300");
  assert.equal(pending.cash.spendableCashRaw, "100");
  assert.equal(pending.candidates[0].cashAfterRaw, "190");
  assert.equal(pending.recommendation.status, "blocked");
});

test("audit: actual cash is consumed before new credit even when debt earmarks part of that cash", () => {
  const input = auditInput();
  if (input.finance.status !== "confirmed") assert.fail();
  input.finance.cashRaw = "100"; input.finance.debtRaw = "50";
  const row = auditHistory(); row.prediction!.funding = "task-credit";
  input.history.entries = [row];
  input.preview = { policy: { reserveCashRaw: "0", minProfitRaw: "1", minMarginBps: "0" }, candidates: [auditCandidate("fixed-a", { funding: "task-credit", executionCostRaw: "150", planningCostRaw: "0" })] };
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.cash.availableBeforeReserveRaw, "50");
  assert.equal(value.candidates[0].cashRequiredRaw, "100");
  assert.equal(value.candidates[0].creditRequiredRaw, "50");
  assert.equal(value.candidates[0].cashAfterRaw, "-50");
  assert.equal(value.candidates[0].status, "rejected");
  assert.ok(value.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
});

test("audit: debt above cash remains a signed shortfall even for a zero-cost zero-floor preview", () => {
  const input = auditInput();
  if (input.finance.status !== "confirmed") assert.fail();
  input.finance.cashRaw = "50"; input.finance.debtRaw = "100";
  input.history.entries = [auditHistory()];
  input.preview = { policy: { reserveCashRaw: "0", minProfitRaw: "0", minMarginBps: "0" }, candidates: [auditCandidate("fixed-a", { executionCostRaw: "0", planningCostRaw: "0" })] };
  const value = assessHostedStrategyAdvice(input);
  assert.equal(value.cash.availableBeforeReserveRaw, "0");
  assert.equal(value.cash.spendableCashRaw, "0");
  assert.equal(value.candidates[0].cashRequiredRaw, "0");
  assert.equal(value.candidates[0].cashAfterRaw, "-50");
  assert.ok(value.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
  assert.equal(value.recommendation.status, "no-eligible-candidate");
});

test("audit: fee uses the greater bound and credit capacity subtracts existing debt", () => {
  for (const [ownerFee, tierCap, expectedFee, unavailable] of [["500", "100", "7", false], ["2000", "100", "10", false], ["500", "99", "7", true]] as const) {
    const input = auditInput();
    if (input.finance.status !== "confirmed") assert.fail();
    input.finance.cashRaw = "100"; input.finance.debtRaw = "50"; input.finance.credit.tierCapRaw = tierCap;
    const row = auditHistory(); row.prediction!.funding = "task-credit"; input.history.entries = [row];
    input.preview = { policy: { reserveCashRaw: "0", minProfitRaw: "1", minMarginBps: "0" }, candidates: [auditCandidate("fixed-a", { funding: "task-credit", executionCostRaw: "150", planningCostRaw: "0", borrowerFeeBps: ownerFee })] };
    const candidate = assessHostedStrategyAdvice(input).candidates[0];
    assert.equal(candidate.creditRequiredRaw, "50");
    assert.equal(candidate.borrowerFeeRaw, expectedFee);
    assert.equal(candidate.reasons.includes("STRATEGY_CREDIT_UNAVAILABLE"), unavailable);
  }
  const input = auditInput();
  if (input.finance.status !== "confirmed") assert.fail();
  input.finance.policy.maxCashPerTxRaw = "5";
  input.history.entries = [auditHistory()]; input.preview = { candidates: [auditCandidate("fixed-a", { executionCostRaw: "0", planningCostRaw: "10" })] };
  assert.ok(assessHostedStrategyAdvice(input).candidates[0].reasons.includes("STRATEGY_CASH_POLICY_LIMIT"));
});

test("audit: a saved seven-unit planner charge is attributed once to its child", async () => auditDirectory(async directory => {
  const input = auditInput(), child = auditRun(input.agent);
  const parent: HostedRun = { ...auditRun(input.agent), action: "autonomous", chargedRaw: "127", result: { phase: "Completed", terminal: true, success: true, chargedRaw: "127" } };
  await auditAdmission(directory, input.agent, child, parent.requestId, "7");
  const base = `agents/${input.agent.id}/runs/${parent.requestId}`;
  await auditSave(directory, `${base}/autonomy-host/session.json`, { version: 1, input: { agent: input.agent, run: parent }, children: { [child.requestId]: { agent: input.agent, run: child } } });
  await auditSave(directory, `${base}/autonomy-loop/session.json`, { version: 1, config: { sessionId: parent.requestId }, phase: "Completed", chargedRaw: "127", steps: [{ decisionSource: "model", decisionChargedRaw: "7", childId: child.requestId,
    decision: { action: "run-task", modelId: input.agent.modelId, funding: "cash" }, outcome: { terminal: true, success: true, chargedRaw: "120" } }] });
  const value = await readHostedStrategyAdvice({ directory, agent: input.agent, finance: input.finance, runs: [parent, child], observedAt: auditAt });
  assert.equal(value.history.entries.length, 1);
  const row = value.history.entries[0];
  assert.equal(row.prediction?.planningCostRaw, "7");
  assert.equal(row.realized.planningCostRaw, "7");
  assert.equal(row.realized.executionCostRaw, "120");
  assert.equal(row.realized.taskContributionRaw, "880");
  assert.equal(row.realized.netAfterPlanningRaw, "873");
  assert.equal(row.executionCostDeviationRaw, "20");
  assert.equal(value.history.netOperatingRaw, "873");
}));
