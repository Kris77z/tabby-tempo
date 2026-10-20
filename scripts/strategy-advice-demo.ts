import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, type Json } from "@agentfuel/sdk";
import { selectInference, type SelectionConfig } from "../packages/pi-loop/src/selector.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { readHostedStrategyAdvice } from "../services/hosted-agents/src/strategy-history.js";
import type { HostedStrategyAdvice, StrategyAdvicePolicy, StrategyCandidateAdvice, StrategyPreviewCandidate } from "../services/hosted-agents/src/strategy-types.js";
import type { HostedAgent, HostedFinance, HostedResult, HostedRun } from "../services/hosted-agents/src/types.js";

const observedAt = "2026-10-17T00:00:00.000Z", observedMs = Date.parse(observedAt);
const deadlineMs = observedMs + 86_400_000;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
const transaction = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const requestId = (n: number) => n.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000001";
const agent: HostedAgent = {
  id: "11111111-1111-4111-8111-111111111111", owner: "0x" + "b".repeat(40), wallet: "0x" + "c".repeat(40),
  name: "Controlled offline strategy fixture", modelId: "controlled", strategy: "balanced", allowCredit: true,
  perRunBudgetRaw: "500000", totalBudgetRaw: "10000000", spentRaw: "0", reservedRaw: "0", status: "Ready",
  createdAt: observedAt, updatedAt: observedAt, binding: { chainId: "31337", agentId: "1", wallet: "0x" + "c".repeat(40) },
};

function finance(cashRaw = "1000000"): HostedFinance {
  return { status: "confirmed", observedAt, chainId: "31337", agentId: "1", wallet: agent.wallet,
    block: { number: 100, hash: transaction(100), timestamp: observedMs / 1000 }, cashRaw, debtRaw: "0", scannedTaskCount: 0, ownedTaskCount: 0,
    credit: { score: "100", tier: "A", tierCapRaw: "1000000", feeBps: "1500", eligible: true, rejection: null },
    policy: { maxCashPerTxRaw: "1000000", maxDebtPerTxRaw: "1000000", maxDebtPerDayRaw: "1000000", ownerFrozen: false },
    counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
}

interface FixtureTask { n: number; providerId: string; quote: string; actual: string; revenue: string; funding?: "cash" | "task-credit"; failed?: boolean; unknown?: boolean }

/** Only synthetic financial and admission records are written; no account, wallet or executor is opened. */
async function saveTask(directory: string, fixture: FixtureTask, files: Map<string, string>): Promise<HostedRun> {
  const funding = fixture.funding ?? "cash", id = requestId(fixture.n), taskId = String(fixture.n);
  const workflow: WorkflowConfig = {
    chainId: "31337", agentId: "1", account: "0x" + "1".repeat(40), asset: "0x" + "2".repeat(40), escrowAddress: "0x" + "3".repeat(40),
    allowCredit: true, maxPrice: "500000", deadlineMs, minRemainingMs: 1000, maxCompletionTokens: 128,
    economics: { version: 1, minNetRewardRaw: "1", planningCostRaw: "0", borrowerFeeBps: "1500" },
    tasks: [{ taskId, problemId: "sum-integers", deadlineMs, creditLimit: "500000" }],
    providers: [{ id: fixture.providerId, payTo: "0x" + "4".repeat(40), relayUrl: "http://127.0.0.1:1", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: fixture.quote, capabilities: ["sum-integers", "python3-json-stdio"],
        solve: { version: 1, maxCompletionTokens: 128, maxRounds: 1, maxToolCalls: 1, tiers: ["cheap"] } }] }],
  };
  const selection: SelectionConfig = { ...workflow, providers: workflow.providers.map(p => ({ ...p, routes: p.routes.map(({ solve: _solve, ...r }) => r) })) };
  const decision = selectInference(selection, { atMs: observedMs - 1000, cash: funding === "cash" ? "1000000" : "0", creditEnabled: true,
    tasks: workflow.tasks.map(t => ({ ...t, assigned: true, revenue: { rewardRaw: fixture.revenue, escrowBalanceRaw: fixture.revenue, protocolFeeBps: "0" } })) });
  assert.equal(decision.selected?.funding, funding, "fixture admission must select the claimed original funding");
  const borrowed = funding === "task-credit" ? BigInt(fixture.actual) : 0n;
  const fee = borrowed * 1500n / 10000n;
  const success = !fixture.failed && !fixture.unknown;
  const result: HostedResult = {
    phase: fixture.unknown ? "Paused" : success ? "Succeeded" : "Failed", terminal: !fixture.unknown, success,
    chargedRaw: fixture.actual, taskId, paymentId: transaction(fixture.n), paymentTxHash: transaction(fixture.n + 1000),
    fromCashRaw: funding === "cash" ? fixture.actual : "0", fromCreditRaw: borrowed.toString(), refundedRaw: "0",
    ...(fixture.unknown ? { reason: "HOSTED_PAYMENT_UNKNOWN" } : { settlement: {
      txHash: transaction(fixture.n + 2000), block: { number: fixture.n, hash: transaction(fixture.n + 3000), timestamp: observedMs / 1000 - 1 },
      passed: success, loanStatus: borrowed > 0n ? "2" : "0", repaidRaw: (borrowed + fee).toString(), slashedRaw: "0",
      residualRaw: success ? (BigInt(fixture.revenue) - borrowed - fee).toString() : "0",
    } }),
  };
  const run: HostedRun = { requestId: id, agentId: agent.id, action: "task", status: fixture.unknown ? "Paused" : success ? "Succeeded" : "Failed",
    createdAt: observedAt, updatedAt: observedAt, reservedRaw: "500000", chargedRaw: fixture.actual, recoverable: !!fixture.unknown, result };
  const snapshot = { agent: agent.id, owner: agent.owner, wallet: agent.wallet, request: id, action: run.action,
    reservedRaw: run.reservedRaw, settings: agent, workflow, physicalModels: [],
    config: { models: [{ id: agent.modelId, physicalModels: [], templates: { [agent.strategy]: workflow } }] } };
  const records: Array<[string, unknown]> = [
    [join("agents", agent.id, "runs", id, "task-executor", "session.json"), { version: 1, snapshot, binding: digest(snapshot), transactions: {}, result }],
    [join("agents", agent.id, "runs", id, "task-executor", "workflow", "session.json"), {
      version: 1, config: workflow, binding: digest(workflow), signer: agent.wallet, decision, observations: [], phase: result.phase, reservedPrice: fixture.quote,
    }],
  ];
  for (const [relative, value] of records) {
    const path = join(directory, relative), content = JSON.stringify(value);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { flag: "wx", mode: 0o600 }); files.set(path, content);
  }
  return run;
}

function candidate(taskId: string, providerId: string, executionCostRaw: string, rewardRaw: string, routeBinding: string, rest: Partial<StrategyPreviewCandidate> = {}): StrategyPreviewCandidate {
  return { taskId, providerId, problemId: "sum-integers", tier: "cheap", funding: "cash", executionCostRaw, rewardRaw, escrowBalanceRaw: rewardRaw,
    planningCostRaw: "0", borrowerFeeBps: "1500", creditLimitRaw: "500000", protocolFeeBps: "0", deadlineMs, routeBinding, ...rest };
}
function summarizeCandidate(c: StrategyCandidateAdvice) {
  return { taskId: c.taskId, providerId: c.providerId, funding: c.funding, status: c.status, quotedExecutionCostRaw: c.quotedExecutionCostRaw,
    observedCostBufferRaw: c.observedCostBufferRaw, adjustedExecutionCostRaw: c.adjustedExecutionCostRaw,
    comparableCount: c.comparableCount, failedComparableCount: c.failedComparableCount, observedFailureLossRaw: c.observedFailureLossRaw,
    successfulCompletionProfitRaw: c.successfulCompletionProfitRaw, requiredProfitRaw: c.requiredProfitRaw,
    cashAfterRaw: c.cashAfterRaw, creditRequiredRaw: c.creditRequiredRaw, reasons: c.reasons, gaps: c.gaps };
}
function summarize(value: HostedStrategyAdvice) {
  return { recommendation: value.recommendation, cash: value.cash, candidates: value.candidates.map(summarizeCandidate) };
}

/** Reproducible assertions use the same read-only projection as the hosted endpoint. */
export async function buildStrategyAdviceDemo() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-strategy-demo-"))), files = new Map<string, string>();
  try {
    const seeds = await Promise.all([
      saveTask(directory, { n: 1, providerId: "route-a", quote: "80000", actual: "80000", revenue: "220000" }, files),
      saveTask(directory, { n: 2, providerId: "route-b", quote: "100000", actual: "100000", revenue: "230000" }, files),
      saveTask(directory, { n: 3, providerId: "route-c", quote: "40000", actual: "40000", revenue: "200000" }, files),
      saveTask(directory, { n: 4, providerId: "route-credit", quote: "100000", actual: "100000", revenue: "230000", funding: "task-credit" }, files),
    ]);
    const read = (runs: HostedRun[], candidates?: StrategyPreviewCandidate[], options: { cashRaw?: string; policy?: StrategyAdvicePolicy } = {}) =>
      readHostedStrategyAdvice({ directory, agent: { ...agent, spentRaw: runs.filter(r => r.status !== "Paused").reduce((sum, r) => sum + BigInt(r.chargedRaw), 0n).toString() },
        runs, finance: finance(options.cashRaw), observedAt, ...(candidates ? { preview: { candidates, ...(options.policy ? { policy: options.policy } : {}) } } : {}) });
    const seedHistory = await read(seeds);
    const binding = (provider: string) => {
      const result = seedHistory.history.entries.find(row => row.prediction?.providerId === provider)?.prediction?.routeBinding;
      assert.ok(result, `original bound prediction missing for ${provider}: ${JSON.stringify(seedHistory.history)}`); return result;
    };
    const a = candidate("101", "route-a", "80000", "220000", binding("route-a"));
    const b = candidate("102", "route-b", "100000", "230000", binding("route-b"));
    const c = candidate("103", "route-c", "40000", "200000", binding("route-c"));
    const before = await read(seeds, [a, b]);
    assert.equal(before.recommendation.providerId, "route-a");
    const overrun = await saveTask(directory, { n: 5, providerId: "route-a", quote: "80000", actual: "120000", revenue: "220000" }, files);
    const afterOverrun = await read([...seeds, overrun], [a, b]);
    const actualOverrun = afterOverrun.history.entries.find(row => row.requestId === overrun.requestId)!;
    assert.equal(actualOverrun.prediction?.executionCostRaw, "80000"); assert.equal(actualOverrun.realized.executionCostRaw, "120000");
    assert.equal(actualOverrun.executionCostDeviationRaw, "40000"); assert.equal(afterOverrun.candidates[0].observedCostBufferRaw, "40000");
    assert.equal(afterOverrun.recommendation.providerId, "route-b");
    const beforeFailure = await read([...seeds, overrun], [c, b]);
    assert.equal(beforeFailure.recommendation.providerId, "route-c");
    const failure = await saveTask(directory, { n: 6, providerId: "route-c", quote: "40000", actual: "70000", revenue: "200000", failed: true }, files);
    const runs = [...seeds, overrun, failure], afterFailure = await read(runs, [c, b]);
    const actualFailure = afterFailure.history.entries.find(row => row.requestId === failure.requestId)!;
    assert.equal(actualFailure.outcome, "failed"); assert.equal(actualFailure.realized.failureLossRaw, "70000");
    assert.equal(afterFailure.candidates[0].observedFailureLossRaw, "70000"); assert.equal(afterFailure.recommendation.providerId, "route-b");
    const reservePolicy = { reserveCashRaw: "200000", minProfitRaw: "1", minMarginBps: "1000" };
    const reserve = await read(runs, [b], { cashRaw: "250000", policy: reservePolicy });
    assert.ok(reserve.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
    const creditCandidate = candidate("104", "route-credit", "300000", "500000", binding("route-credit"), { funding: "task-credit" });
    const creditReserve = await read(runs, [creditCandidate], { cashRaw: "250000", policy: reservePolicy });
    assert.equal(creditReserve.candidates[0].creditRequiredRaw, "50000"); assert.equal(creditReserve.cash.creditIncluded, false);
    assert.equal(creditReserve.candidates[0].cashAfterRaw, "0"); assert.ok(creditReserve.candidates[0].reasons.includes("STRATEGY_CASH_RESERVE"));
    const absoluteCandidate = candidate("105", "route-b", "49000", "50000", binding("route-b"));
    const marginCandidate = candidate("106", "route-b", "185000", "200000", binding("route-b"));
    const profitGates = await read(runs, [absoluteCandidate, marginCandidate], { policy: { reserveCashRaw: "200000", minProfitRaw: "10000", minMarginBps: "1000" } });
    assert.equal(profitGates.candidates[0].requiredProfitRaw, "10000"); assert.equal(profitGates.candidates[1].requiredProfitRaw, "20000");
    for (const row of profitGates.candidates) assert.ok(row.reasons.includes("STRATEGY_MINIMUM_PROFIT"));
    const unknown = await saveTask(directory, { n: 7, providerId: "route-b", quote: "100000", actual: "10000", revenue: "230000", unknown: true }, files);
    const unresolved = await read([...runs, unknown], [b]);
    assert.equal(unresolved.recommendation.status, "blocked"); assert.ok(unresolved.recommendation.reasons.includes("STRATEGY_UNRESOLVED_LIABILITIES"));
    for (const [path, original] of files) assert.equal(await readFile(path, "utf8"), original, "advice must leave original fixture records unchanged");
    const sources = ["scripts/strategy-advice-demo.ts", "services/hosted-agents/src/strategy-advice.ts", "services/hosted-agents/src/strategy-history.ts",
      "services/hosted-agents/src/strategy-types.ts", "services/hosted-agents/src/accounting.ts", "services/hosted-agents/src/finance-projection.ts",
      "packages/pi-loop/src/selector.ts", "packages/pi-loop/src/economics.ts", "packages/pi-loop/src/workflow.ts"];
    const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex")])));
    return {
      version: 1, demonstration: "controlled-offline-strategy-advice", observedAt, currency: "USDC", decimals: 6,
      scope: { controlledFixtures: true, productionRead: false, productionWrite: false, externalRpcCalls: 0, modelCalls: 0, signedTransactions: 0,
        currentQuoteEvidence: false, successProbabilityEstimated: false, basis: "successful-completion-bound", excludes: ["native-gas", "reward-token-opportunity-cost", "success-probability"] },
      fixtureEvidence: { taskCount: 7, journalCount: files.size, originalJournalsUnchanged: true, temporaryFilesRemoved: true,
        fixtureDigest: digest([...files].map(([path, content]) => ({ path: path.slice(directory.length + 1), sha256: createHash("sha256").update(content).digest("hex") })).sort((x, y) => x.path.localeCompare(y.path))) },
      defaultPolicy: before.policy,
      costDeviation: { originalPrediction: actualOverrun.prediction, actualExecutionCostRaw: actualOverrun.realized.executionCostRaw,
        deviationRaw: actualOverrun.executionCostDeviationRaw, before: summarize(before), after: summarize(afterOverrun) },
      paidFailure: { actualLossRaw: actualFailure.realized.failureLossRaw, knownFailureLossRaw: afterFailure.history.knownFailureLossRaw,
        before: summarize(beforeFailure), after: summarize(afterFailure) },
      cashReserve: summarize(reserve), creditCannotSupplyReserve: summarize(creditReserve), minimumProfit: summarize(profitGates),
      unknownBlocksAdvice: { recommendation: unresolved.recommendation, unresolvedLiabilities: unresolved.cash.unresolvedLiabilities,
        pendingCommitmentsRaw: unresolved.cash.pendingCommitmentsRaw },
      checksPassed: ["original-prediction-versus-actual", "cost-overrun-changes-next-preview", "paid-failure-changes-next-preview", "cash-reserve",
        "credit-excluded-from-cash-reserve", "absolute-profit-floor", "net-revenue-margin-floor", "unknown-blocks-advice", "original-journals-unchanged"],
      sourceSha256,
    };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write("Usage: npm run strategy:demo -- [--report /absolute/new-report.json]\nControlled offline fixtures only. Report creation is exclusive and never overwrites.\n"); return; }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--report" || !isAbsolute(args[1]))) throw Error("Usage: --report requires one absolute path to a new file");
  const report = await buildStrategyAdviceDemo(), content = JSON.stringify(report, null, 2) + "\n";
  if (args[0] === "--report") await writeFile(args[1], content, { flag: "wx", mode: 0o600 });
  const reserve = report.cashReserve, credit = report.creditCannotSupplyReserve;
  const summary = { version: report.version, demonstration: report.demonstration, observedAt, currency: report.currency, decimals: report.decimals,
    scope: report.scope, defaultPolicy: report.defaultPolicy,
    costDeviation: { originalExecutionCostRaw: report.costDeviation.originalPrediction!.executionCostRaw, actualExecutionCostRaw: report.costDeviation.actualExecutionCostRaw,
      observedCostBufferRaw: report.costDeviation.after.candidates[0].observedCostBufferRaw,
      beforeProvider: report.costDeviation.before.recommendation.providerId, afterProvider: report.costDeviation.after.recommendation.providerId },
    paidFailure: { actualLossRaw: report.paidFailure.actualLossRaw, observedFailureLossRaw: report.paidFailure.after.candidates[0].observedFailureLossRaw,
      beforeProvider: report.paidFailure.before.recommendation.providerId, afterProvider: report.paidFailure.after.recommendation.providerId },
    cashReserve: { cashRaw: reserve.cash.cashRaw, reserveCashRaw: reserve.cash.reserveCashRaw, cashAfterRaw: reserve.candidates[0].cashAfterRaw, reasons: reserve.candidates[0].reasons },
    creditCannotSupplyReserve: { creditRequiredRaw: credit.candidates[0].creditRequiredRaw, creditIncluded: credit.cash.creditIncluded,
      cashAfterRaw: credit.candidates[0].cashAfterRaw, reasons: credit.candidates[0].reasons },
    minimumProfit: report.minimumProfit.candidates.map(c => ({ profitRaw: c.successfulCompletionProfitRaw, requiredProfitRaw: c.requiredProfitRaw, reasons: c.reasons })),
    unknownBlocksAdvice: report.unknownBlocksAdvice, fixtureEvidence: report.fixtureEvidence, checksPassed: report.checksPassed,
    ...(args[0] === "--report" ? { report: { path: args[1], sha256: createHash("sha256").update(content).digest("hex"), sourceHashesIncluded: true } } : {}),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`strategy-advice-demo: ${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
}
