import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonical, type Json } from "@agentfuel/sdk";
import { selectInference, type SelectionConfig } from "../packages/pi-loop/src/selector.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { readHostedOperatingReport } from "../services/hosted-agents/src/operating-history.js";
import { evaluateOperatorFinancialObservation, validateOperatingReportPreview } from "../services/hosted-agents/src/operating-report.js";
import type { OperatorFinancialObservation, OperatingReportPreview } from "../services/hosted-agents/src/operating-types.js";
import type { HostedAgent, HostedFinance, HostedResult, HostedRun } from "../services/hosted-agents/src/types.js";
import { operatingPaymentFixtures, operatingPaymentFixtureWallet } from "./fixtures/operating-report-payment-fixtures.js";

const observedAt = "2026-10-17T00:00:00.000Z", observedMs = Date.parse(observedAt), dayMs = 86_400_000;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
const transaction = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const requestId = (n: number) => n.toString(16).padStart(8, "0") + "-0000-4000-8000-000000000002";
const agent: HostedAgent = {
  id: "22222222-2222-4222-8222-222222222222", owner: "0x" + "b".repeat(40), wallet: operatingPaymentFixtureWallet,
  name: "Controlled offline operating fixture", modelId: "controlled", strategy: "balanced", allowCredit: true,
  perRunBudgetRaw: "500000", totalBudgetRaw: "10000000", spentRaw: "0", reservedRaw: "0", status: "Ready",
  createdAt: observedAt, updatedAt: observedAt, binding: { chainId: "31337", agentId: "1", wallet: operatingPaymentFixtureWallet },
};
function finance(): HostedFinance {
  return { status: "confirmed", observedAt, chainId: "31337", agentId: "1", wallet: agent.wallet,
    block: { number: 100, hash: transaction(100), timestamp: observedMs / 1000 }, cashRaw: "1000000", debtRaw: "100000", scannedTaskCount: 0, ownedTaskCount: 0,
    credit: { score: "100", tier: "A", tierCapRaw: "1000000", feeBps: "1500", eligible: true, rejection: null },
    policy: { maxCashPerTxRaw: "1000000", maxDebtPerTxRaw: "1000000", maxDebtPerDayRaw: "1000000", ownerFrozen: false },
    counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
}
interface TaskFixture { n: number; rewardRaw: string; protocolFeeBps: string; chargedRaw: string; refundedRaw?: string; credit?: boolean; duplicateOf?: number; unknown?: boolean; invalidRefund?: boolean }

/** Fresh synthetic bound journals only. No executor, wallet, RPC client or paid provider is created. */
async function saveTask(directory: string, f: TaskFixture, files: Map<string, string>): Promise<HostedRun> {
  const id = requestId(f.n), taskId = String(f.duplicateOf ?? f.n), grossRaw = (BigInt(f.chargedRaw) + BigInt(f.refundedRaw ?? "0")).toString();
  const handle = operatingPaymentFixtures[String(f.duplicateOf ?? f.n) as keyof typeof operatingPaymentFixtures];
  const workflow: WorkflowConfig = {
    chainId: "31337", agentId: "1", account: "0x" + "1".repeat(40), asset: "0x" + "2".repeat(40), escrowAddress: "0x" + "3".repeat(40),
    allowCredit: true, maxPrice: "500000", deadlineMs: observedMs + dayMs, minRemainingMs: 1000, maxCompletionTokens: 128,
    economics: { version: 1, minNetRewardRaw: "1", planningCostRaw: "0", borrowerFeeBps: "1500" },
    tasks: [{ taskId, problemId: "sum-integers", deadlineMs: observedMs + dayMs, creditLimit: "500000" }],
    providers: [{ id: "controlled-supplier", payTo: "0x" + "4".repeat(40), relayUrl: "http://127.0.0.1:1", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: f.unknown ? "100000" : grossRaw, capabilities: ["sum-integers", "python3-json-stdio"],
        solve: { version: 1, maxCompletionTokens: 128, maxRounds: 1, maxToolCalls: 1, tiers: ["cheap"] } }] }],
  };
  const selection: SelectionConfig = { ...workflow, providers: workflow.providers.map(p => ({ ...p, routes: p.routes.map(({ solve: _solve, ...r }) => r) })) };
  const decision = selectInference(selection, { atMs: observedMs - 1000, cash: f.credit ? "0" : "1000000", creditEnabled: true,
    tasks: workflow.tasks.map(t => ({ ...t, assigned: true, revenue: { rewardRaw: f.rewardRaw, escrowBalanceRaw: f.rewardRaw, protocolFeeBps: f.protocolFeeBps } })) });
  assert.equal(decision.selected?.funding, f.credit ? "task-credit" : "cash");
  const borrowed = f.credit ? BigInt(f.chargedRaw) : 0n, fee = borrowed * 1500n / 10000n;
  const netReward = BigInt(f.rewardRaw) - BigInt(f.rewardRaw) * BigInt(f.protocolFeeBps) / 10000n;
  const result: HostedResult = { phase: f.unknown ? "Paused" : "Succeeded", terminal: !f.unknown, success: !f.unknown, chargedRaw: f.chargedRaw,
    taskId, paymentId: handle.quote.paymentId, paymentTxHash: handle.submission.txHash,
    fromCashRaw: f.credit ? "0" : f.invalidRefund ? f.chargedRaw : grossRaw, fromCreditRaw: borrowed.toString(), refundedRaw: f.refundedRaw ?? "0",
    ...(f.unknown ? { reason: "HOSTED_PAYMENT_UNKNOWN" } : { settlement: { txHash: transaction((f.duplicateOf ?? f.n) + 2000),
      block: { number: f.duplicateOf ?? f.n, hash: transaction((f.duplicateOf ?? f.n) + 3000), timestamp: observedMs / 1000 - 1 },
      passed: true, loanStatus: f.credit ? "2" : "0", repaidRaw: (borrowed + fee).toString(), slashedRaw: "0", residualRaw: (netReward - borrowed - fee).toString() } }) };
  const run: HostedRun = { requestId: id, agentId: agent.id, action: "task", status: f.unknown ? "Paused" : "Succeeded", createdAt: observedAt, updatedAt: observedAt,
    reservedRaw: f.unknown ? "100000" : "500000", chargedRaw: f.chargedRaw, recoverable: !!f.unknown, result };
  const snapshot = { agent: agent.id, owner: agent.owner, wallet: agent.wallet, request: id, action: run.action,
    reservedRaw: run.reservedRaw, settings: agent, workflow, physicalModels: [], config: { models: [{ id: agent.modelId, physicalModels: [], templates: { [agent.strategy]: workflow } }] } };
  const records: Array<[string, unknown]> = [
    [join("agents", agent.id, "runs", id, "task-executor", "session.json"), { version: 1, snapshot, binding: digest(snapshot), transactions: {}, result }],
    [join("agents", agent.id, "runs", id, "task-executor", "workflow", "session.json"), { version: 1, config: workflow, binding: digest(workflow), signer: agent.wallet, decision, handle,
      finance: result.settlement ? { repaid: result.settlement.repaidRaw, residual: result.settlement.residualRaw, slashed: result.settlement.slashedRaw, loanStatus: result.settlement.loanStatus } : undefined,
      observations: [], phase: result.phase, reservedPrice: decision.selected?.price }],
  ];
  for (const [relative, value] of records) { const path = join(directory, relative), content = JSON.stringify(value); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content, { flag: "wx", mode: 0o600 }); files.set(path, content); }
  return run;
}
function simple(n: number, action: HostedRun["action"], result: Partial<HostedResult>, extra: Partial<HostedRun> = {}): HostedRun {
  return { requestId: requestId(n), agentId: agent.id, action, status: "Succeeded", createdAt: observedAt, updatedAt: observedAt, reservedRaw: "0", chargedRaw: "0", recoverable: false,
    result: { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", ...result }, ...extra };
}
function operator(role: "platform" | "supplier", overrides: Partial<OperatorFinancialObservation> = {}) {
  return evaluateOperatorFinancialObservation({ version: 1, source: "operator-declared", role, subjectId: role === "platform" ? "controlled-platform" : "controlled-supplier",
    period: { from: "2026-10-16T00:00:00.000Z", to: observedAt }, evidenceDigest: digest({ controlled: true, role }),
    receiptsRaw: role === "platform" ? "100000" : "200000", refundsRaw: role === "platform" ? "0" : "20000", costsRaw: role === "platform" ? "200000" : "130000",
    cashRaw: "1000000", reservationsRaw: "100000", debtRaw: "100000", reserveCashRaw: "200000", burn: { amountRaw: "100000", windowMs: dayMs, taskCount: 2 }, subsidyBurn: { amountRaw: "50000", windowMs: dayMs }, ...overrides });
}

/** The same retained-history reader and pure declaration evaluator used by the implementation. */
export async function buildOperatingReportDemo() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-operating-demo-"))), files = new Map<string, string>();
  try {
    const tasks = [await saveTask(directory, { n: 1, rewardRaw: "1000000", protocolFeeBps: "500", chargedRaw: "80000", refundedRaw: "20000" }, files),
      await saveTask(directory, { n: 2, rewardRaw: "500000", protocolFeeBps: "1000", chargedRaw: "100000", credit: true }, files)];
    const runs = [...tasks, simple(10, "game", { rewardRaw: "400000" }, { rewardKind: "usdc" }), simple(11, "game", { creditsGranted: 10000 }, { rewardKind: "llm-credits" }),
      simple(12, "credits", { creditsUsed: 215 }), simple(13, "provision", { cashRaw: "200000" }), simple(14, "deposit", {}, { amountRaw: "1000000" })];
    const read = (selected: HostedRun[], preview?: OperatingReportPreview, snapshot: HostedFinance = finance()) => readHostedOperatingReport({ directory,
      agent: { ...agent, spentRaw: selected.filter(r => r.status !== "Paused").reduce((n, r) => n + BigInt(r.chargedRaw), 0n).toString() },
      runs: selected, finance: snapshot, observedAt, ...(preview === undefined ? {} : { preview }) });
    const contribution = await read(runs);
    assert.equal(contribution.agent.taskRevenueRaw, "1400000"); assert.equal(contribution.agent.netServiceCostRaw, "180000"); assert.equal(contribution.agent.refundsRaw, "20000");
    assert.equal(contribution.agent.borrowingFeeRaw, "15000"); assert.equal(contribution.agent.loanPrincipalRaw, "100000"); assert.equal(contribution.agent.settlementOperatingRaw, "1205000");
    assert.equal(contribution.suppliers.netReceiptsRaw, "180000"); assert.equal(contribution.platform.derivedProtocolFeeRaw, "100000"); assert.equal(contribution.platform.creditFeeSettledRaw, "15000");
    assert.equal(contribution.consolidation.roleTotalsAdditive, false); assert.equal(contribution.consolidation.externalRevenueRaw, null);
    assert.equal(contribution.subsidy.gameUsdcGrantedRaw, "400000"); assert.equal(contribution.subsidy.usdcAttributedConsumptionRaw, null); assert.equal(contribution.subsidy.usdcGrantRemainingRaw, null);
    assert.equal(contribution.subsidy.rewardTokensGranted, 10000); assert.equal(contribution.subsidy.inferenceTokensUsed, 215); assert.equal(contribution.subsidy.rewardTokensRemaining, null);
    for (const role of [contribution.agent, contribution.platform, contribution.suppliers]) assert.equal(role.actualProfitRaw, null);
    const preview = { reserveCashRaw: "200000", recurringCostRaw: "50000", subsidyBudgetRaw: "600000", burn: { amountRaw: "100000", windowMs: dayMs, taskCount: 2 }, subsidyBurn: { amountRaw: "50000", windowMs: dayMs } };
    const finite = await read(runs, preview), zeroBurn = await read(runs, { ...preview, burn: { ...preview.burn, amountRaw: "0" } }), noSubsidyBurn = await read(runs, { ...preview, subsidyBurn: undefined });
    assert.equal(finite.runway.status, "finite"); assert.equal(zeroBurn.runway.status, "zero-burn"); assert.equal(contribution.runway.status, "unknown");
    assert.equal(finite.scenario?.source, "owner-hypothetical"); assert.equal(finite.agent.actualProfitRaw, null); assert.equal(finite.platform.actualProfitRaw, null); assert.equal(finite.suppliers.actualProfitRaw, null);
    const platform = operator("platform", { subsidyGrantedRaw: "400000", subsidyAllocatedRaw: "150000", subsidyBudgetRaw: "1000000" }), supplier = operator("supplier");
    const netPositive = operator("supplier", { burn: { amountRaw: "0", windowMs: dayMs } }), unknownOperator = operator("platform", { burn: undefined });
    assert.equal(platform.reportedContributionRaw, "-500000"); assert.equal(supplier.reportedContributionRaw, "50000"); assert.equal(netPositive.runway.status, "zero-burn"); assert.equal(unknownOperator.runway.status, "unknown");
    assert.equal(platform.subsidy.remainingBudgetRaw, "600000"); assert.equal(platform.subsidy.budgetRunway?.horizonMs, String(12 * dayMs));
    assert.equal(finite.scenario?.subsidyBudgetRemainingRaw, "200000"); assert.equal(finite.scenario?.subsidyBudgetRunway?.horizonMs, String(4 * dayMs)); assert.equal(noSubsidyBurn.scenario?.subsidyBudgetRunway?.status, "unknown");
    const duplicate = await saveTask(directory, { n: 3, duplicateOf: 1, rewardRaw: "1000000", protocolFeeBps: "500", chargedRaw: "80000", refundedRaw: "20000" }, files);
    const deduplicated = await read([...runs, duplicate]);
    assert.equal(deduplicated.agent.netServiceCostRaw, contribution.agent.netServiceCostRaw); assert.equal(deduplicated.agent.refundsRaw, contribution.agent.refundsRaw); assert.equal(deduplicated.agent.loanPrincipalRaw, contribution.agent.loanPrincipalRaw);
    assert.equal(deduplicated.suppliers.netReceiptsRaw, contribution.suppliers.netReceiptsRaw); assert.equal(deduplicated.agent.settlementOperatingRaw, null);
    const invalid = await saveTask(directory, { n: 4, rewardRaw: "500000", protocolFeeBps: "500", chargedRaw: "10000", refundedRaw: "20000", invalidRefund: true }, files);
    const invalidRefund = await read([...runs, invalid]); assert.equal(invalidRefund.status, "partial"); assert.equal(invalidRefund.agent.settlementOperatingRaw, null);
    const pending = await saveTask(directory, { n: 5, rewardRaw: "500000", protocolFeeBps: "500", chargedRaw: "10000", unknown: true }, files);
    const unresolved = await read([...runs, pending], preview); assert.equal(unresolved.status, "partial"); assert.equal(unresolved.agent.settlementOperatingRaw, null);
    const subsidyGrantsUnknown = await read([...runs, simple(15, "game", {}, { rewardKind: "usdc" })], preview);
    assert.equal(subsidyGrantsUnknown.scenario?.subsidyBudgetRemainingRaw, null); assert.equal(subsidyGrantsUnknown.scenario?.subsidyBudgetShortfallRaw, null);
    assert.equal(subsidyGrantsUnknown.scenario?.subsidyBudgetRunway?.status, "unknown"); assert.equal(subsidyGrantsUnknown.scenario?.subsidyBudgetRunway?.availableRaw, null);
    assert.throws(() => validateOperatingReportPreview({ ...preview, costsRaw: "130000", evidenceDigest: digest("owner-input-is-not-evidence") }));
    for (const [path, original] of files) assert.equal(await readFile(path, "utf8"), original, "financial readers must preserve the original journal bytes");
    const sources = ["scripts/operating-report-demo.ts", "scripts/fixtures/operating-report-payment-fixtures.ts", "services/hosted-agents/src/operating-types.ts", "services/hosted-agents/src/operating-report.ts", "services/hosted-agents/src/operating-history.ts", "services/hosted-agents/src/accounting.ts", "services/hosted-agents/src/strategy-history.ts", "packages/pi-loop/src/selector.ts", "packages/pi-loop/src/economics.ts"];
    const sourceSha256 = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(join(projectRoot, path))).digest("hex")])));
    return { version: 1, demonstration: "controlled-offline-operating-report", observedAt, currency: "USDC", decimals: 6,
      scope: { controlledFixtures: true, fixtureContainsSyntheticSignedEnvelopes: true, productionRead: false, productionWrite: false, externalRpcCalls: 0, modelCalls: 0, signedTransactions: 0, broadcastTransactions: 0, profitCalibrated: false,
        operatorObservations: "explicit-operator-declarations-only", evidenceDigest: "reference-only-not-authenticated-invoice", exclusions: ["native-gas", "token-valuation", "unobserved-costs", "global-private-books"] },
      contribution, operatorDeclarations: { platform, supplier, netPositive, unknown: unknownOperator },
      runway: { finite: finite.runway, zeroBurn: zeroBurn.runway, unknown: contribution.runway, subsidyBudget: finite.scenario?.subsidyBudgetRunway, noSubsidyBurn: noSubsidyBurn.scenario?.subsidyBudgetRunway }, ownerHypothetical: finite,
      duplicatePayment: { status: deduplicated.status, netServiceCostRaw: deduplicated.agent.netServiceCostRaw, refundsRaw: deduplicated.agent.refundsRaw, loanPrincipalRaw: deduplicated.agent.loanPrincipalRaw, supplierReceiptsRaw: deduplicated.suppliers.netReceiptsRaw, gaps: deduplicated.gaps },
      invalidRefund: { status: invalidRefund.status, settlementOperatingRaw: invalidRefund.agent.settlementOperatingRaw, gaps: invalidRefund.gaps },
      unresolved: { status: unresolved.status, settlementOperatingRaw: unresolved.agent.settlementOperatingRaw, runway: unresolved.runway, gaps: unresolved.gaps, report: unresolved },
      subsidyGrantsUnknown,
      fixtureEvidence: { taskCount: 5, journalCount: files.size, originalJournalsUnchanged: true, temporaryFilesRemoved: true,
        fixtureDigest: digest([...files].map(([path, content]) => ({ path: path.slice(directory.length + 1), sha256: createHash("sha256").update(content).digest("hex") })).sort((a, b) => a.path.localeCompare(b.path))) },
      checksPassed: ["role-contributions-separated", "internal-transfers-not-additive", "refunds-not-deducted-twice", "principal-not-a-second-cost", "grants-not-consumption", "mixed-token-provenance-unknown", "operator-declarations-not-invoices", "owner-preview-not-actual-profit", "finite-zero-burn-unknown-runway", "duplicate-payment-deduplication", "invalid-refund-stays-partial", "unresolved-payment-stays-partial", "original-journals-unchanged"], sourceSha256 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write("Usage: npm run operating:demo -- [--report /absolute/new-report.json]\nControlled offline financial fixtures and explicit operator declarations only. Reports never overwrite.\n"); return; }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--report" || !isAbsolute(args[1]))) throw Error("Usage: --report requires one absolute path to a new file");
  const report = await buildOperatingReportDemo(), content = JSON.stringify(report, null, 2) + "\n";
  if (args[0] === "--report") {
    const file = await open(args[1], "wx", 0o600);
    try { await file.writeFile(content); } catch (error) { await file.close(); await rm(args[1], { force: true }); throw error; }
    await file.close();
  }
  process.stdout.write(JSON.stringify({ ...report, sourceSha256: undefined, ...(args[0] === "--report" ? { report: { path: args[1], sha256: createHash("sha256").update(content).digest("hex"), sourceHashesIncluded: true } } : {}) }, null, 2) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { process.stderr.write(`operating-report-demo: ${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
