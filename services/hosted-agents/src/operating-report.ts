import { validateHostedFinance } from "./finance-projection.js";
import { HostedError } from "./types.js";
import type { HostedOperatingReport, OperatingBurnAssumption, OperatingReportInput, OperatingReportPreview, OperatingRunway, OperatingSupplierReceipt, OperatorFinancialEvaluation, OperatorFinancialObservation } from "./operating-types.js";

export { OPERATING_GAPS } from "./operating-types.js";
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const raw = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const aggregate = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,90})$/.test(value);
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_./:-]{1,160}$/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = (): never => { throw new HostedError("HOSTED_OPERATING_INPUT_INVALID"); };
function object(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail();
}
function burn(value: unknown): OperatingBurnAssumption {
  object(value, ["amountRaw", "windowMs", "taskCount"]);
  if (!raw(value.amountRaw) || !Number.isSafeInteger(value.windowMs) || value.windowMs < 1 || value.taskCount !== undefined && (!Number.isSafeInteger(value.taskCount) || value.taskCount < 1)) fail();
  return { amountRaw: value.amountRaw, windowMs: value.windowMs, ...(value.taskCount === undefined ? {} : { taskCount: value.taskCount }) };
}
export function validateOperatingReportPreview(value: unknown): OperatingReportPreview {
  object(value, ["reserveCashRaw", "recurringCostRaw", "burn", "subsidyBudgetRaw", "subsidyBurn"]);
  const result: OperatingReportPreview = {};
  for (const key of ["reserveCashRaw", "recurringCostRaw", "subsidyBudgetRaw"] as const) if (value[key] !== undefined) { if (!raw(value[key])) fail(); result[key] = value[key]; }
  if (value.burn !== undefined) result.burn = burn(value.burn);
  if (value.subsidyBurn !== undefined) result.subsidyBurn = burn(value.subsidyBurn);
  return result;
}
function available(cash: string, reservations: string, debt: string, reserve: string) {
  const net = BigInt(cash) - BigInt(reservations) - BigInt(debt) - BigInt(reserve);
  return { spendable: (net > 0n ? net : 0n).toString(), shortfall: (net < 0n ? -net : 0n).toString() };
}
/** A zero observed/assumed burn proves no finite horizon for that window, never infinite survival. */
function runway(amount: string | null, rate: OperatingBurnAssumption | undefined, source: OperatingRunway["source"], scope: OperatingRunway["scope"], reasons: string[] = []): OperatingRunway {
  const common = { source, scope, availableRaw: amount, burnAmountRaw: rate?.amountRaw ?? null, burnWindowMs: rate?.windowMs ?? null };
  if (amount === null || !rate || reasons.length) return { ...common, status: "unknown", horizonMs: null, fullTasks: null, reasons: unique([...reasons, ...(!rate ? ["OPERATING_BURN_ASSUMPTION_REQUIRED"] : [])]) };
  const cost = BigInt(rate.amountRaw);
  if (cost === 0n) return { ...common, status: "zero-burn", horizonMs: null, fullTasks: null, reasons: ["OPERATING_ZERO_BURN_NO_FINITE_HORIZON"] };
  return { ...common, status: "finite", horizonMs: (BigInt(amount) * BigInt(rate.windowMs) / cost).toString(),
    fullTasks: rate.taskCount === undefined ? null : (BigInt(amount) * BigInt(rate.taskCount) / cost).toString(), reasons: [] };
}

/** Pure projection. Retained balances and role contributions are kept distinct from owner assumptions and full profit. */
export function assessHostedOperatingReport(input: OperatingReportInput): HostedOperatingReport {
  const preview = validateOperatingReportPreview(input.preview ?? {}), { accounting, agent, evidence } = input, totals = accounting.totals;
  if (accounting.agentId !== agent.id || !["USDC", "PathUSD"].includes(accounting.currency) || accounting.decimals !== 6 || !aggregate(input.pendingReservationsRaw)) throw new HostedError("HOSTED_OPERATING_EVIDENCE_INVALID", 503);
  const gaps: string[] = [...accounting.coverage.reasons, ...evidence.gaps];
  const supplierGaps: string[] = [], platformGaps: string[] = ["OPERATING_TREASURY_RECEIPTS_UNCONFIRMED"];
  const expenses = ["OPERATING_UPSTREAM_COST_UNRECORDED", "OPERATING_HOSTING_COST_UNRECORDED", "OPERATING_CHAIN_FEES_UNRECORDED"];
  const domain = evidence.settlementDomain;
  const domainKnown = domain && domain.chainId === agent.binding?.chainId && address(domain.account) && address(domain.asset);
  if (!domainKnown && (evidence.suppliers.length || evidence.taskFees.length)) gaps.push("OPERATING_DOMAIN_UNKNOWN");
  let gross = 0n, refunds = 0n, net = 0n;
  const byRequest = new Map<string, { net: bigint; refunds: bigint }>();
  const groups = new Map<string, HostedOperatingReport["suppliers"]["rows"][number]>();
  const payments = new Map<string, OperatingSupplierReceipt[]>();
  for (const receipt of evidence.suppliers) {
    const rows = payments.get(receipt.paymentId.toLowerCase()) ?? []; rows.push(receipt); payments.set(receipt.paymentId.toLowerCase(), rows);
  }
  for (const duplicates of payments.values()) {
    if (duplicates.length > 1) supplierGaps.push("OPERATING_DUPLICATE_PAYMENT");
    const receipt = duplicates[0];
    if (duplicates.some(other => JSON.stringify(other) !== JSON.stringify(receipt))) { supplierGaps.push("OPERATING_RECEIPT_INVALID"); continue; }
    const row = accounting.entries.find(entry => entry.requestId === receipt.requestId && entry.status === "confirmed" &&
      (entry.paymentId ? entry.paymentId.toLowerCase() === receipt.paymentId.toLowerCase() : ["planning", "goal"].includes(entry.action)));
    if (!row || !domainKnown || receipt.chainId !== domain.chainId || !address(receipt.account) || !address(receipt.asset) || !address(receipt.payTo) || !same(receipt.account, domain.account) || !same(receipt.asset, domain.asset) ||
      !/^[0-9a-f]{64}$/.test(receipt.routeBinding) || !identifier(receipt.providerId) || !identifier(receipt.service) || !identifier(receipt.model) || !hash(receipt.paymentId) || !hash(receipt.paymentTxHash) ||
      ![receipt.grossReceiptsRaw, receipt.refundsRaw, receipt.netReceiptsRaw].every(raw) || BigInt(receipt.grossReceiptsRaw) - BigInt(receipt.refundsRaw) !== BigInt(receipt.netReceiptsRaw)) {
      supplierGaps.push("OPERATING_RECEIPT_INVALID"); continue;
    }
    const request = byRequest.get(receipt.requestId) ?? { net: 0n, refunds: 0n };
    if (request.net + BigInt(receipt.netReceiptsRaw) > BigInt(row.inferenceCostRaw) || request.refunds + BigInt(receipt.refundsRaw) > BigInt(row.refundsRaw)) { supplierGaps.push("OPERATING_RECEIPT_INVALID"); continue; }
    // A stable provider label or recipient can cover different services, assets and physical models. The original route digest separates those books.
    const key = receipt.routeBinding, existing = groups.get(key);
    if (existing) {
      const fields = ["providerId", "payTo", "chainId", "account", "asset", "service", "model"] as const;
      if (fields.some(field => !same(existing[field], receipt[field]))) { supplierGaps.push("OPERATING_BINDING_MISMATCH"); continue; }
      existing.grossReceiptsRaw = (BigInt(existing.grossReceiptsRaw) + BigInt(receipt.grossReceiptsRaw)).toString();
      existing.refundsRaw = (BigInt(existing.refundsRaw) + BigInt(receipt.refundsRaw)).toString();
      existing.netReceiptsRaw = (BigInt(existing.netReceiptsRaw) + BigInt(receipt.netReceiptsRaw)).toString(); existing.paymentCount++;
    } else groups.set(key, { routeBinding: receipt.routeBinding, providerId: receipt.providerId, payTo: receipt.payTo, chainId: receipt.chainId, account: receipt.account, asset: receipt.asset,
      service: receipt.service, model: receipt.model, grossReceiptsRaw: receipt.grossReceiptsRaw, refundsRaw: receipt.refundsRaw, netReceiptsRaw: receipt.netReceiptsRaw, paymentCount: 1, actualProfitRaw: null });
    gross += BigInt(receipt.grossReceiptsRaw); refunds += BigInt(receipt.refundsRaw); net += BigInt(receipt.netReceiptsRaw);
    byRequest.set(receipt.requestId, { net: request.net + BigInt(receipt.netReceiptsRaw), refunds: request.refunds + BigInt(receipt.refundsRaw) });
  }
  let unknownProtocol = false, unknownCredit = false, protocol = 0n, credit = 0n;
  const taskIds = new Set<string>();
  for (const fee of evidence.taskFees) {
    const row = accounting.entries.find(entry => entry.requestId === fee.requestId && entry.taskId === fee.taskId && entry.status === "confirmed");
    if (taskIds.has(fee.taskId)) { platformGaps.push("OPERATING_DUPLICATE_TASK"); unknownProtocol = unknownCredit = true; continue; }
    taskIds.add(fee.taskId);
    if (!row || !domainKnown || !raw(fee.taskId) || (fee.source === "settled-task-and-original-reward" ? !hash(fee.settlementTxHash) : fee.source !== "confirmed-no-fee" || fee.protocolFeeRaw !== "0" || fee.creditFeeSettledRaw !== "0")) { platformGaps.push("OPERATING_BINDING_MISMATCH"); unknownProtocol = unknownCredit = true; continue; }
    platformGaps.push(...fee.gaps);
    if (fee.protocolFeeRaw === null || !raw(fee.protocolFeeRaw)) unknownProtocol = true; else protocol += BigInt(fee.protocolFeeRaw);
    if (fee.creditFeeSettledRaw === null || !raw(fee.creditFeeSettledRaw) || fee.creditFeeSettledRaw !== row.borrowingFeeRaw) unknownCredit = true; else credit += BigInt(fee.creditFeeSettledRaw);
  }
  const taskEntries = accounting.entries.filter(row => ["task", "metered-task", "reward-task"].includes(row.action) && (row.taskId !== undefined || row.inferenceCostRaw !== "0" || row.refundsRaw !== "0" || row.taskRevenueRaw !== "0" || row.borrowingFeeRaw !== "0" || row.status !== "confirmed"));
  if (evidence.entriesTruncated || accounting.coverage.entriesTruncated || accounting.status !== "complete" || taskEntries.some(row => !taskIds.has(row.taskId ?? "") || row.status !== "confirmed")) {
    unknownProtocol = unknownCredit = true;
  }
  if (unknownProtocol) platformGaps.push("OPERATING_PROTOCOL_FEE_UNKNOWN");
  if (unknownCredit) platformGaps.push("OPERATING_CREDIT_FEE_UNKNOWN");
  if (evidence.entriesTruncated || accounting.coverage.entriesTruncated) gaps.push("OPERATING_HISTORY_TRUNCATED");
  const unattributed = BigInt(totals.inferenceCostRaw) > net ? BigInt(totals.inferenceCostRaw) - net : 0n;
  if (unattributed > 0n || net > BigInt(totals.inferenceCostRaw)) supplierGaps.push("OPERATING_SUPPLIER_ATTRIBUTION_INCOMPLETE");
  let finance;
  try {
    finance = validateHostedFinance(input.finance, agent, agent.binding?.chainId ?? "");
    const atMs = Date.parse(input.observedAt);
    if (!Number.isFinite(atMs) || finance.status === "confirmed" && (!agent.binding || !same(agent.binding.wallet, agent.wallet) || Date.parse(finance.observedAt) > atMs || atMs - Date.parse(finance.observedAt) > 120_000 || finance.block.timestamp * 1000 > atMs)) throw Error("age");
  } catch { finance = { status: "unavailable" as const, observedAt: input.observedAt, reason: "HOSTED_FINANCE_UNCONFIRMED" }; }
  const reserve = preview.reserveCashRaw ?? "0", cash = finance.status === "confirmed" ? available(finance.cashRaw, input.pendingReservationsRaw, finance.debtRaw, reserve) : null;
  const cashReasons: string[] = finance.status !== "confirmed" ? ["OPERATING_CASH_UNAVAILABLE"] : [];
  if (gaps.includes("OPERATING_RESERVATIONS_UNKNOWN")) cashReasons.push("OPERATING_RESERVATIONS_UNKNOWN");
  if (accounting.coverage.reasons.includes("ACCOUNTING_PAYMENT_UNRESOLVED") || gaps.includes("OPERATING_LIABILITIES_UNRESOLVED")) cashReasons.push("OPERATING_LIABILITIES_UNRESOLVED");
  if (accounting.status !== "complete" || accounting.coverage.pendingCount > 0) cashReasons.push("OPERATING_LIABILITIES_UNRESOLVED");
  const spendable = cashReasons.length ? null : cash?.spendable ?? null;
  const budget = preview.subsidyBudgetRaw === undefined ? null : available(preview.subsidyBudgetRaw, totals.gameSubsidyRaw, "0", "0");
  const subsidyReasons = accounting.coverage.reasons.some(reason => ["ACCOUNTING_SUBSIDY_UNKNOWN", "ACCOUNTING_HISTORY_MISSING", "ACCOUNTING_BINDING_MISMATCH", "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_HISTORY_LIMIT"].includes(reason)) ? ["OPERATING_SUBSIDY_GRANTS_UNKNOWN"] : [];
  const report: HostedOperatingReport = {
    version: 1, agentId: agent.id, observedAt: input.observedAt, currency: accounting.currency, decimals: 6, mode: "read-only", scope: "owner-agent-contribution", status: "partial",
    agent: { taskRevenueRaw: totals.taskRevenueRaw, netServiceCostRaw: totals.inferenceCostRaw, refundsRaw: totals.refundsRaw, borrowingFeeRaw: totals.borrowingFeeRaw,
      settlementOperatingRaw: totals.netOperatingRaw, actualProfitRaw: null, ownerCapitalRaw: totals.ownerCapitalRaw, startupCapitalRaw: totals.startupCapitalRaw, loanPrincipalRaw: totals.loanPrincipalRaw, gaps: expenses.filter(gap => gap !== "OPERATING_UPSTREAM_COST_UNRECORDED") },
    platform: { scope: "this-agent-only", derivedProtocolFeeRaw: unknownProtocol ? null : protocol.toString(), knownDerivedProtocolFeeRaw: protocol.toString(),
      creditFeeSettledRaw: unknownCredit ? null : credit.toString(), knownCreditFeeSettledRaw: credit.toString(), creditFeeRecipient: "credit-vault", treasuryReceiptsRaw: null, actualProfitRaw: null,
      gaps: unique([...platformGaps, "OPERATING_PROTOCOL_FEE_RECEIPT_NOT_RETAINED", ...expenses.filter(gap => gap !== "OPERATING_UPSTREAM_COST_UNRECORDED")]) },
    suppliers: { scope: "this-agent-only", grossReceiptsRaw: gross.toString(), refundsRaw: refunds.toString(), netReceiptsRaw: net.toString(), unattributedNetServiceCostRaw: unattributed.toString(),
      actualProfitRaw: null, rows: [...groups.values()].sort((a, b) => a.routeBinding.localeCompare(b.routeBinding)), gaps: unique([...supplierGaps, "OPERATING_SUPPLIER_COST_UNRECORDED", ...expenses]) },
    subsidy: { gameUsdcGrantedRaw: totals.gameSubsidyRaw, startupCapitalGrantedRaw: totals.startupCapitalRaw, gameDistributionOutflowRaw: totals.gameSubsidyRaw, distributionScope: "recorded-game-rewards-to-this-agent", startupCapitalSource: "unattributed-capital",
      usdcAttributedConsumptionRaw: null, usdcGrantRemainingRaw: null, rewardTokensGranted: totals.creditsGranted, inferenceTokensUsed: totals.creditsUsed, rewardTokensConsumed: null, rewardTokensRemaining: null,
      tokenUsageScope: "paid-and-reward-mix-unknown", gaps: unique(["OPERATING_CASH_ALLOCATION_UNKNOWN", "OPERATING_REWARD_TOKEN_ALLOCATION_UNKNOWN", "OPERATING_STARTUP_CAPITAL_SOURCE_UNKNOWN", ...subsidyReasons]) },
    cash: { status: finance.status, cashRaw: finance.status === "confirmed" ? finance.cashRaw : null, financeObservedAt: finance.status === "confirmed" ? finance.observedAt : null,
      pendingReservationsRaw: input.pendingReservationsRaw, outstandingDebtRaw: finance.status === "confirmed" ? finance.debtRaw : null, reserveCashRaw: reserve, spendableCashRaw: spendable, shortfallRaw: cashReasons.length ? null : cash?.shortfall ?? null, creditIncluded: false },
    scenario: Object.keys(preview).length ? { source: "owner-hypothetical", recurringCostRaw: preview.recurringCostRaw ?? "0", settlementOperatingAfterAssumedCostRaw: totals.netOperatingRaw === null ? null : (BigInt(totals.netOperatingRaw) - BigInt(preview.recurringCostRaw ?? "0")).toString(),
      costScope: "retained-history-period", costPeriod: { from: accounting.coverage.since, to: input.observedAt }, subsidyBudgetRaw: preview.subsidyBudgetRaw ?? null,
      subsidyBudgetRemainingRaw: subsidyReasons.length ? null : budget?.spendable ?? null, subsidyBudgetShortfallRaw: subsidyReasons.length ? null : budget?.shortfall ?? null,
      subsidyBudgetRunway: budget ? runway(subsidyReasons.length ? null : budget.spendable, preview.subsidyBurn, "owner-hypothetical", "game-subsidy-distribution-budget", subsidyReasons) : null } : null,
    runway: runway(spendable, preview.burn, preview.burn ? "owner-hypothetical" : "none", "agent-spendable-cash", cashReasons),
    consolidation: { externalRevenueRaw: null, roleTotalsAdditive: false, gaps: ["OPERATING_ROLE_OVERLAP_UNKNOWN"] },
    coverage: { ...structuredClone(accounting.coverage), roleEntriesTruncated: evidence.entriesTruncated }, gaps: [],
  };
  report.gaps = unique([...gaps, ...report.agent.gaps, ...report.platform.gaps, ...report.suppliers.gaps, ...report.subsidy.gaps, ...report.runway.reasons, ...report.consolidation.gaps]);
  return report;
}

/** Offline, host/operator use only. No HTTP owner body can supply these declarations or make them verified actuals. */
export function evaluateOperatorFinancialObservation(value: unknown): OperatorFinancialEvaluation {
  object(value, ["version", "source", "role", "subjectId", "period", "evidenceDigest", "receiptsRaw", "refundsRaw", "costsRaw", "cashRaw", "reservationsRaw", "debtRaw", "reserveCashRaw", "subsidyGrantedRaw", "subsidyAllocatedRaw", "subsidyCommittedRaw", "subsidyBudgetRaw", "burn", "subsidyBurn"]);
  if (value.version !== 1 || value.source !== "operator-declared" || !["platform", "supplier"].includes(value.role) || !identifier(value.subjectId) || !/^[0-9a-f]{64}$/.test(value.evidenceDigest)) fail();
  object(value.period, ["from", "to"]);
  if (typeof value.period.from !== "string" || typeof value.period.to !== "string" || !Number.isFinite(Date.parse(value.period.from)) || !Number.isFinite(Date.parse(value.period.to)) || Date.parse(value.period.from) >= Date.parse(value.period.to)) fail();
  for (const key of ["receiptsRaw", "refundsRaw", "costsRaw", "cashRaw", "reservationsRaw", "debtRaw", "reserveCashRaw", "subsidyGrantedRaw", "subsidyAllocatedRaw", "subsidyCommittedRaw", "subsidyBudgetRaw"] as const) {
    if ((["receiptsRaw", "refundsRaw", "costsRaw"] as readonly string[]).includes(key) || value[key] !== undefined) if (!raw(value[key])) fail();
  }
  if (BigInt(value.refundsRaw) > BigInt(value.receiptsRaw) || value.subsidyAllocatedRaw !== undefined && (value.subsidyGrantedRaw === undefined || BigInt(value.subsidyAllocatedRaw) > BigInt(value.subsidyGrantedRaw))) fail();
  const rate = value.burn === undefined ? undefined : burn(value.burn), subsidyRate = value.subsidyBurn === undefined ? undefined : burn(value.subsidyBurn), v = value as OperatorFinancialObservation;
  const cashComplete = [v.cashRaw, v.reservationsRaw, v.debtRaw, v.reserveCashRaw].every(item => item !== undefined);
  const cash = cashComplete ? available(v.cashRaw!, v.reservationsRaw!, v.debtRaw!, v.reserveCashRaw!) : null;
  const budget = v.subsidyBudgetRaw !== undefined && v.subsidyGrantedRaw !== undefined ? available(v.subsidyBudgetRaw, v.subsidyGrantedRaw, v.subsidyCommittedRaw ?? "0", "0") : null;
  const reported = BigInt(v.receiptsRaw) - BigInt(v.refundsRaw);
  const gaps = ["OPERATING_OPERATOR_DECLARATION_UNVERIFIED", ...(!cashComplete ? ["OPERATING_DECLARED_CASH_INCOMPLETE"] : []), ...(v.subsidyBudgetRaw !== undefined && v.subsidyGrantedRaw === undefined ? ["OPERATING_SUBSIDY_GRANTS_UNKNOWN"] : [])];
  return { version: 1, source: "operator-declared", role: v.role, subjectId: v.subjectId, currency: "USDC", decimals: 6, period: { from: v.period.from, to: v.period.to }, evidenceDigest: v.evidenceDigest,
    reportedNetReceiptsRaw: reported.toString(), reportedContributionRaw: (reported - BigInt(v.costsRaw) - BigInt(v.subsidyGrantedRaw ?? "0")).toString(), actualProfitRaw: null,
    subsidy: { grantedRaw: v.subsidyGrantedRaw ?? null, explicitlyAllocatedRaw: v.subsidyAllocatedRaw ?? null, unallocatedGrantRaw: v.subsidyGrantedRaw !== undefined && v.subsidyAllocatedRaw !== undefined ? (BigInt(v.subsidyGrantedRaw) - BigInt(v.subsidyAllocatedRaw)).toString() : null,
      unpaidCommittedRaw: v.subsidyCommittedRaw ?? "0", budgetRaw: v.subsidyBudgetRaw ?? null, remainingBudgetRaw: budget?.spendable ?? null, budgetShortfallRaw: budget?.shortfall ?? null,
      budgetRunway: v.subsidyBudgetRaw === undefined ? null : runway(budget?.spendable ?? null, subsidyRate, "operator-declared", "game-subsidy-distribution-budget", budget ? [] : ["OPERATING_SUBSIDY_GRANTS_UNKNOWN"]) },
    runway: runway(cash?.spendable ?? null, rate, "operator-declared", "operator-cash", cashComplete ? [] : ["OPERATING_DECLARED_CASH_INCOMPLETE"]), gaps };
}
