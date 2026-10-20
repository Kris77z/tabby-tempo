import type { HostedOperatingReport, OperatingReportPreview, OperatingRunway } from "../../services/hosted-agents/src/operating-types.js";
import { OPERATING_GAPS } from "../../services/hosted-agents/src/operating-types.js";

const codes = new Set([
  ...OPERATING_GAPS,
  "ACCOUNTING_BINDING_MISMATCH", "ACCOUNTING_BORROWING_FEE_UNKNOWN", "ACCOUNTING_CAPITAL_UNKNOWN", "ACCOUNTING_COST_MISMATCH", "ACCOUNTING_DUPLICATE_PAYMENT", "ACCOUNTING_DUPLICATE_TASK",
  "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_HISTORY_LIMIT", "ACCOUNTING_HISTORY_MISSING", "ACCOUNTING_PAYMENT_UNRESOLVED", "ACCOUNTING_PENDING", "ACCOUNTING_SETTLEMENT_MISSING", "ACCOUNTING_SUBSIDY_UNKNOWN", "ACCOUNTING_TOKEN_USAGE_UNKNOWN",
]);
function invalid(): never { throw Error("HOSTED_OPERATING_REPORT_INVALID"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function closed(value: unknown, keys: string[]) { const result = record(value); if (Object.keys(result).some(key => !keys.includes(key))) invalid(); return result; }
function text(value: unknown, pattern: RegExp): string { if (typeof value !== "string" || !pattern.test(value)) invalid(); return value; }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function positive(value: unknown) { const n = count(value); if (n === 0) invalid(); return n; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function literal<T extends string | number | boolean | null>(value: unknown, expected: T): T { if (value !== expected) invalid(); return expected; }
function option<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== "string" || !choices.includes(value as T)) invalid(); return value as T; }
function list<T>(value: unknown, limit: number, project: (v: unknown) => T): T[] { if (!Array.isArray(value) || value.length > limit) invalid(); return value.map(project); }
function nullable<T>(value: unknown, project: (v: unknown) => T): T | null { return value === null ? null : project(value); }
const amount = (value: unknown) => text(value, /^(0|[1-9][0-9]{0,90})$/);
const signed = (value: unknown) => text(value, /^(0|-?[1-9][0-9]{0,90})$/);
const identifier = (value: unknown) => text(value, /^[A-Za-z0-9_-]{1,80}$/);
const address = (value: unknown) => text(value, /^0x[0-9a-f]{40}$/i);
function uint(value: unknown) { const n = text(value, /^(0|[1-9][0-9]{0,77})$/); if (BigInt(n) >= 1n << 256n) invalid(); return n; }
function timestamp(value: unknown) { const result = text(value, /^.{1,40}$/); if (!Number.isFinite(Date.parse(result))) invalid(); return result; }
function reasons(value: unknown) { return list(value, codes.size, v => { if (typeof v !== "string" || !codes.has(v)) invalid(); return v; }); }

/** Closed numeric owner assumptions; operator accounts and evidence cannot enter the HTTP preview. */
export function projectOperatingReportPreview(value: unknown): OperatingReportPreview {
  const input = closed(value, ["reserveCashRaw", "recurringCostRaw", "burn", "subsidyBurn", "subsidyBudgetRaw"]), result: OperatingReportPreview = {};
  for (const key of ["reserveCashRaw", "recurringCostRaw", "subsidyBudgetRaw"] as const) if (input[key] !== undefined) result[key] = uint(input[key]);
  for (const key of ["burn", "subsidyBurn"] as const) if (input[key] !== undefined) {
    const burn = closed(input[key], ["amountRaw", "windowMs", "taskCount"]);
    result[key] = { amountRaw: uint(burn.amountRaw), windowMs: positive(burn.windowMs), ...(burn.taskCount === undefined ? {} : { taskCount: positive(burn.taskCount) }) };
  }
  return result;
}

function runway(value: unknown): OperatingRunway {
  const r = record(value);
  const result: OperatingRunway = { source: option(r.source, ["owner-hypothetical", "none"]), scope: option(r.scope, ["agent-spendable-cash", "game-subsidy-distribution-budget"]), status: option(r.status, ["finite", "zero-burn", "unknown"]),
    availableRaw: nullable(r.availableRaw, amount), burnAmountRaw: nullable(r.burnAmountRaw, amount), burnWindowMs: nullable(r.burnWindowMs, positive),
    horizonMs: nullable(r.horizonMs, v => text(v, /^(0|[1-9][0-9]{0,159})$/)), fullTasks: nullable(r.fullTasks, v => text(v, /^(0|[1-9][0-9]{0,159})$/)), reasons: reasons(r.reasons) };
  if (result.status === "finite" && (result.source === "none" || result.availableRaw === null || result.burnAmountRaw === null || result.burnAmountRaw === "0" || result.burnWindowMs === null || result.horizonMs === null)) invalid();
  if (result.status === "finite" && (result.reasons.length > 0 || result.horizonMs !== (BigInt(result.availableRaw!) * BigInt(result.burnWindowMs!) / BigInt(result.burnAmountRaw!)).toString())) invalid();
  if (result.status === "zero-burn" && (result.source === "none" || result.availableRaw === null || result.burnAmountRaw !== "0" || result.burnWindowMs === null || result.horizonMs !== null || result.fullTasks !== null)) invalid();
  if (result.status === "unknown" && (result.horizonMs !== null || result.fullTasks !== null)) invalid();
  return result;
}

/** Every nested field is projected explicitly; no private books, paths or adapter data are forwarded. */
export function projectHostedOperatingReport(value: unknown, expectedAgentId: string): HostedOperatingReport {
  const input = record(value), a = record(input.agent), p = record(input.platform), s = record(input.suppliers), subsidy = record(input.subsidy), c = record(input.cash), coverage = record(input.coverage), consolidation = record(input.consolidation);
  const agentId = identifier(input.agentId); if (agentId !== expectedAgentId) invalid();
  const result: HostedOperatingReport = { version: literal(input.version, 1), agentId, observedAt: timestamp(input.observedAt), currency: option(input.currency, ["USDC", "PathUSD"]), decimals: literal(input.decimals, 6),
    mode: literal(input.mode, "read-only"), scope: literal(input.scope, "owner-agent-contribution"), status: option(input.status, ["complete", "partial"]),
    agent: { taskRevenueRaw: amount(a.taskRevenueRaw), netServiceCostRaw: amount(a.netServiceCostRaw), refundsRaw: amount(a.refundsRaw), borrowingFeeRaw: amount(a.borrowingFeeRaw),
      settlementOperatingRaw: nullable(a.settlementOperatingRaw, signed), actualProfitRaw: literal(a.actualProfitRaw, null), ownerCapitalRaw: amount(a.ownerCapitalRaw), startupCapitalRaw: amount(a.startupCapitalRaw), loanPrincipalRaw: amount(a.loanPrincipalRaw), gaps: reasons(a.gaps) },
    platform: { scope: literal(p.scope, "this-agent-only"), derivedProtocolFeeRaw: nullable(p.derivedProtocolFeeRaw, amount), knownDerivedProtocolFeeRaw: amount(p.knownDerivedProtocolFeeRaw),
      creditFeeSettledRaw: nullable(p.creditFeeSettledRaw, amount), knownCreditFeeSettledRaw: amount(p.knownCreditFeeSettledRaw), creditFeeRecipient: literal(p.creditFeeRecipient, "credit-vault"),
      treasuryReceiptsRaw: literal(p.treasuryReceiptsRaw, null), actualProfitRaw: literal(p.actualProfitRaw, null), gaps: reasons(p.gaps) },
    suppliers: { scope: literal(s.scope, "this-agent-only"), grossReceiptsRaw: amount(s.grossReceiptsRaw), refundsRaw: amount(s.refundsRaw), netReceiptsRaw: amount(s.netReceiptsRaw),
      unattributedNetServiceCostRaw: amount(s.unattributedNetServiceCostRaw), actualProfitRaw: literal(s.actualProfitRaw, null),
      rows: list(s.rows, 200, value => { const row = record(value); return { routeBinding: text(row.routeBinding, /^[a-f0-9]{64}$/), providerId: text(row.providerId, /^[A-Za-z0-9_./:-]{1,160}$/), payTo: address(row.payTo),
        chainId: uint(row.chainId), account: address(row.account), asset: address(row.asset), service: text(row.service, /^[A-Za-z0-9_./:-]{1,160}$/), model: text(row.model, /^[A-Za-z0-9_./:-]{1,160}$/),
        grossReceiptsRaw: amount(row.grossReceiptsRaw), refundsRaw: amount(row.refundsRaw), netReceiptsRaw: amount(row.netReceiptsRaw), paymentCount: positive(row.paymentCount), actualProfitRaw: literal(row.actualProfitRaw, null) }; }), gaps: reasons(s.gaps) },
    subsidy: { gameUsdcGrantedRaw: amount(subsidy.gameUsdcGrantedRaw), startupCapitalGrantedRaw: amount(subsidy.startupCapitalGrantedRaw), gameDistributionOutflowRaw: amount(subsidy.gameDistributionOutflowRaw), distributionScope: literal(subsidy.distributionScope, "recorded-game-rewards-to-this-agent"), startupCapitalSource: literal(subsidy.startupCapitalSource, "unattributed-capital"), usdcAttributedConsumptionRaw: literal(subsidy.usdcAttributedConsumptionRaw, null), usdcGrantRemainingRaw: literal(subsidy.usdcGrantRemainingRaw, null),
      rewardTokensGranted: count(subsidy.rewardTokensGranted), inferenceTokensUsed: count(subsidy.inferenceTokensUsed), rewardTokensConsumed: literal(subsidy.rewardTokensConsumed, null), rewardTokensRemaining: literal(subsidy.rewardTokensRemaining, null),
      tokenUsageScope: literal(subsidy.tokenUsageScope, "paid-and-reward-mix-unknown"), gaps: reasons(subsidy.gaps) },
    cash: { status: option(c.status, ["confirmed", "unavailable"]), cashRaw: nullable(c.cashRaw, amount), financeObservedAt: nullable(c.financeObservedAt, timestamp), pendingReservationsRaw: amount(c.pendingReservationsRaw), outstandingDebtRaw: nullable(c.outstandingDebtRaw, amount), reserveCashRaw: amount(c.reserveCashRaw),
      spendableCashRaw: nullable(c.spendableCashRaw, amount), shortfallRaw: nullable(c.shortfallRaw, amount), creditIncluded: literal(c.creditIncluded, false) },
    scenario: input.scenario === null ? null : (() => { const scenario = record(input.scenario); return { source: literal(scenario.source, "owner-hypothetical"), recurringCostRaw: amount(scenario.recurringCostRaw),
      settlementOperatingAfterAssumedCostRaw: nullable(scenario.settlementOperatingAfterAssumedCostRaw, signed), costScope: literal(scenario.costScope, "retained-history-period"), costPeriod: (() => { const period = record(scenario.costPeriod); return { from: nullable(period.from, timestamp), to: timestamp(period.to) }; })(),
      subsidyBudgetRaw: nullable(scenario.subsidyBudgetRaw, amount), subsidyBudgetRemainingRaw: nullable(scenario.subsidyBudgetRemainingRaw, amount), subsidyBudgetShortfallRaw: nullable(scenario.subsidyBudgetShortfallRaw, amount), subsidyBudgetRunway: nullable(scenario.subsidyBudgetRunway, runway) }; })(),
    runway: runway(input.runway), consolidation: { externalRevenueRaw: literal(consolidation.externalRevenueRaw, null), roleTotalsAdditive: literal(consolidation.roleTotalsAdditive, false), gaps: reasons(consolidation.gaps) },
    coverage: { scope: literal(coverage.scope, "retained-hosted-history"), since: nullable(coverage.since, timestamp), runCount: count(coverage.runCount), entryCount: count(coverage.entryCount), pendingCount: count(coverage.pendingCount), incompleteCount: count(coverage.incompleteCount),
      returnedEntryCount: count(coverage.returnedEntryCount), entriesTruncated: bool(coverage.entriesTruncated), uncoveredSpentRaw: amount(coverage.uncoveredSpentRaw), reasons: reasons(coverage.reasons), roleEntriesTruncated: bool(coverage.roleEntriesTruncated) }, gaps: reasons(input.gaps) };
  if (result.coverage.pendingCount + result.coverage.incompleteCount > result.coverage.entryCount || result.coverage.returnedEntryCount > result.coverage.entryCount || result.coverage.entriesTruncated !== (result.coverage.returnedEntryCount < result.coverage.entryCount)) invalid();
  if (result.cash.status === "confirmed") {
    if (result.cash.cashRaw === null || result.cash.financeObservedAt === null || result.cash.outstandingDebtRaw === null) invalid();
    if (result.cash.spendableCashRaw === null || result.cash.shortfallRaw === null) {
      if (result.cash.spendableCashRaw !== null || result.cash.shortfallRaw !== null || result.runway.status !== "unknown" || !result.runway.reasons.some(reason => ["OPERATING_LIABILITIES_UNRESOLVED", "OPERATING_RESERVATIONS_UNKNOWN"].includes(reason))) invalid();
    } else {
      const available = BigInt(result.cash.cashRaw) - BigInt(result.cash.pendingReservationsRaw) - BigInt(result.cash.outstandingDebtRaw) - BigInt(result.cash.reserveCashRaw);
      if (result.cash.spendableCashRaw !== (available < 0n ? 0n : available).toString() || result.cash.shortfallRaw !== (available < 0n ? -available : 0n).toString()) invalid();
    }
  } else if ([result.cash.cashRaw, result.cash.financeObservedAt, result.cash.outstandingDebtRaw, result.cash.spendableCashRaw, result.cash.shortfallRaw].some(v => v !== null)) invalid();
  if (result.agent.settlementOperatingRaw !== null && result.agent.settlementOperatingRaw !== (BigInt(result.agent.taskRevenueRaw) - BigInt(result.agent.netServiceCostRaw) - BigInt(result.agent.borrowingFeeRaw)).toString()) invalid();
  if (result.runway.scope !== "agent-spendable-cash" || result.scenario?.subsidyBudgetRunway && result.scenario.subsidyBudgetRunway.scope !== "game-subsidy-distribution-budget") invalid();
  if (result.runway.availableRaw !== result.cash.spendableCashRaw || result.subsidy.gameDistributionOutflowRaw !== result.subsidy.gameUsdcGrantedRaw || result.subsidy.startupCapitalGrantedRaw !== result.agent.startupCapitalRaw) invalid();
  if (result.platform.derivedProtocolFeeRaw !== null && result.platform.derivedProtocolFeeRaw !== result.platform.knownDerivedProtocolFeeRaw || result.platform.creditFeeSettledRaw !== null && result.platform.creditFeeSettledRaw !== result.platform.knownCreditFeeSettledRaw) invalid();
  if (result.scenario) {
    const scenario = result.scenario;
    if (scenario.costPeriod.from !== result.coverage.since || scenario.costPeriod.to !== result.observedAt || scenario.settlementOperatingAfterAssumedCostRaw !== (result.agent.settlementOperatingRaw === null ? null : (BigInt(result.agent.settlementOperatingRaw) - BigInt(scenario.recurringCostRaw)).toString())) invalid();
    if (scenario.subsidyBudgetRaw === null) { if ([scenario.subsidyBudgetRemainingRaw, scenario.subsidyBudgetShortfallRaw, scenario.subsidyBudgetRunway].some(v => v !== null)) invalid(); }
    else {
      const budgetRunway = scenario.subsidyBudgetRunway;
      if (!budgetRunway || budgetRunway.source !== "owner-hypothetical" || budgetRunway.availableRaw !== scenario.subsidyBudgetRemainingRaw) invalid();
      if (scenario.subsidyBudgetRemainingRaw === null || scenario.subsidyBudgetShortfallRaw === null) {
        if (scenario.subsidyBudgetRemainingRaw !== null || scenario.subsidyBudgetShortfallRaw !== null || budgetRunway.status !== "unknown" || !budgetRunway.reasons.includes("OPERATING_SUBSIDY_GRANTS_UNKNOWN") || !result.subsidy.gaps.includes("OPERATING_SUBSIDY_GRANTS_UNKNOWN") || !result.gaps.includes("OPERATING_SUBSIDY_GRANTS_UNKNOWN")) invalid();
      } else {
        const remaining = BigInt(scenario.subsidyBudgetRaw) - BigInt(result.subsidy.gameUsdcGrantedRaw);
        if (budgetRunway.reasons.includes("OPERATING_SUBSIDY_GRANTS_UNKNOWN") || scenario.subsidyBudgetRemainingRaw !== (remaining < 0n ? 0n : remaining).toString() || scenario.subsidyBudgetShortfallRaw !== (remaining < 0n ? -remaining : 0n).toString()) invalid();
      }
    }
  }
  const seen = new Set<string>(); let gross = 0n, refunds = 0n, net = 0n;
  for (const row of result.suppliers.rows) { if (seen.has(row.routeBinding) || BigInt(row.grossReceiptsRaw) - BigInt(row.refundsRaw) !== BigInt(row.netReceiptsRaw)) invalid(); seen.add(row.routeBinding); gross += BigInt(row.grossReceiptsRaw); refunds += BigInt(row.refundsRaw); net += BigInt(row.netReceiptsRaw); }
  if (s.grossReceiptsRaw !== gross.toString() || s.refundsRaw !== refunds.toString() || s.netReceiptsRaw !== net.toString()) invalid();
  return result;
}
