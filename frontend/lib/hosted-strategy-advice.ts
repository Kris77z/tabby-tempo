import type { HostedStrategyAdvice, StrategyAdvicePreview, StrategyCandidateAdvice, StrategyHistoryEntry, StrategyPrediction, StrategyPreviewCandidate } from "../../services/hosted-agents/src/strategy-types.js";

const tiers = ["cheap", "strong"] as const;
const funding = ["cash", "task-credit", "reward-tokens", "inference-allowance"] as const;
const codes = new Set([
  "ACCOUNTING_BINDING_MISMATCH", "ACCOUNTING_BORROWING_FEE_UNKNOWN", "ACCOUNTING_CAPITAL_UNKNOWN", "ACCOUNTING_COST_MISMATCH", "ACCOUNTING_DUPLICATE_PAYMENT", "ACCOUNTING_DUPLICATE_TASK",
  "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_HISTORY_LIMIT", "ACCOUNTING_HISTORY_MISSING", "ACCOUNTING_PAYMENT_UNRESOLVED", "ACCOUNTING_PENDING", "ACCOUNTING_SETTLEMENT_MISSING", "ACCOUNTING_SUBSIDY_UNKNOWN", "ACCOUNTING_TOKEN_USAGE_UNKNOWN",
  "STRATEGY_ADMISSION_BINDING_MISMATCH", "STRATEGY_AGENT_NOT_READY", "STRATEGY_BUDGET_LIMIT", "STRATEGY_CASH_POLICY_LIMIT", "STRATEGY_CASH_RESERVE", "STRATEGY_CASH_UNAVAILABLE",
  "STRATEGY_COMPARABLE_HISTORY_MISSING", "STRATEGY_CONFIGURATION_REQUIRED", "STRATEGY_CREDIT_POLICY_LIMIT", "STRATEGY_CREDIT_UNAVAILABLE", "STRATEGY_CURRENT_CANDIDATES_UNAVAILABLE", "STRATEGY_DAILY_CREDIT_USAGE_UNKNOWN",
  "STRATEGY_DEADLINE", "STRATEGY_ESCROW_UNFUNDED", "STRATEGY_FAILURE_LOSS_UNKNOWN", "STRATEGY_HISTORY_INVALID", "STRATEGY_HISTORY_LIMIT", "STRATEGY_HISTORY_MISSING", "STRATEGY_HISTORY_TRUNCATED", "STRATEGY_HYPOTHETICAL_ONLY",
  "STRATEGY_MINIMUM_PROFIT", "STRATEGY_ORIGINAL_ADMISSION_REJECTED", "STRATEGY_ORIGINAL_PREDICTION_MISSING", "STRATEGY_OUTCOME_UNKNOWN", "STRATEGY_OWNER_FROZEN", "STRATEGY_PLANNING_ATTRIBUTION_UNKNOWN",
  "STRATEGY_RESERVATION_UNKNOWN", "STRATEGY_REVENUE_ZERO", "STRATEGY_ROUTE_BINDING_MISSING", "STRATEGY_TOKEN_BALANCE_UNVERIFIED", "STRATEGY_TOKEN_OPPORTUNITY_COST_UNPRICED", "STRATEGY_UNRESOLVED_LIABILITIES",
]);
function invalid(): never { throw Error("HOSTED_STRATEGY_ADVICE_INVALID"); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function closed(value: unknown, keys: string[]) { const result = record(value); if (Object.keys(result).some(key => !keys.includes(key))) invalid(); return result; }
function text(value: unknown, pattern: RegExp): string { if (typeof value !== "string" || !pattern.test(value)) invalid(); return value; }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function literal<T extends string | number | boolean>(value: unknown, expected: T): T { if (value !== expected) invalid(); return expected; }
function option<T extends string>(value: unknown, choices: readonly T[]): T { if (typeof value !== "string" || !choices.includes(value as T)) invalid(); return value as T; }
function list<T>(value: unknown, limit: number, project: (v: unknown) => T): T[] { if (!Array.isArray(value) || value.length > limit) invalid(); return value.map(project); }
function nullable<T>(value: unknown, project: (v: unknown) => T): T | null { return value === null ? null : project(value); }
const amount = (value: unknown) => text(value, /^(0|[1-9][0-9]{0,80})$/);
const signed = (value: unknown) => text(value, /^(0|-?[1-9][0-9]{0,80})$/);
const identifier = (value: unknown) => text(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const requestId = (value: unknown) => text(value, /^[\w-]{1,100}$/);
const hash = (value: unknown) => text(value, /^[a-f0-9]{64}$/);
function taskId(value: unknown) { const result = text(value, /^[1-9][0-9]{0,77}$/); if (BigInt(result) >= 1n << 256n) invalid(); return result; }
function timestamp(value: unknown) { const result = text(value, /^.{1,40}$/); if (!Number.isFinite(Date.parse(result))) invalid(); return result; }
function reasons(value: unknown) { return list(value, codes.size, v => { if (typeof v !== "string" || !codes.has(v)) invalid(); return v; }); }
function identity(value: Record<string, unknown>) {
  return { taskId: taskId(value.taskId), problemId: identifier(value.problemId), providerId: identifier(value.providerId), tier: option(value.tier, tiers), funding: option(value.funding, funding) };
}
function policy(value: unknown) {
  const p = record(value), minMarginBps = amount(p.minMarginBps); if (BigInt(minMarginBps) > 10000n) invalid();
  return { reserveCashRaw: amount(p.reserveCashRaw), minProfitRaw: amount(p.minProfitRaw), minMarginBps };
}
function uint(value: unknown) { const result = text(value, /^(0|[1-9][0-9]{0,77})$/); if (BigInt(result) >= 1n << 256n) invalid(); return result; }

/** Browser assumptions have a closed numeric schema. No execution command or identity field is forwarded. */
export function projectStrategyAdvicePreview(value: unknown): StrategyAdvicePreview {
  const input = closed(value, ["policy", "candidates"]), result: StrategyAdvicePreview = {};
  if (input.policy !== undefined) {
    const p = closed(input.policy, ["reserveCashRaw", "minProfitRaw", "minMarginBps"]); if (Object.keys(p).length !== 3) invalid();
    result.policy = { reserveCashRaw: uint(p.reserveCashRaw), minProfitRaw: uint(p.minProfitRaw), minMarginBps: uint(p.minMarginBps) };
    if (BigInt(result.policy.minMarginBps) > 10000n) invalid();
  }
  if (input.candidates !== undefined) {
    const seen = new Set<string>();
    result.candidates = list(input.candidates, 32, value => {
      const c = closed(value, ["taskId", "problemId", "providerId", "tier", "funding", "executionCostRaw", "planningCostRaw", "borrowerFeeBps", "creditLimitRaw", "rewardRaw", "escrowBalanceRaw", "protocolFeeBps", "deadlineMs", "routeBinding", "tokenFundingConfirmed"]);
      const candidate: StrategyPreviewCandidate = { ...identity(c), executionCostRaw: uint(c.executionCostRaw), planningCostRaw: uint(c.planningCostRaw),
        borrowerFeeBps: uint(c.borrowerFeeBps), creditLimitRaw: uint(c.creditLimitRaw), rewardRaw: uint(c.rewardRaw), escrowBalanceRaw: uint(c.escrowBalanceRaw), protocolFeeBps: uint(c.protocolFeeBps), deadlineMs: count(c.deadlineMs),
        ...(c.routeBinding === undefined ? {} : { routeBinding: hash(c.routeBinding) }), ...(c.tokenFundingConfirmed === undefined ? {} : { tokenFundingConfirmed: bool(c.tokenFundingConfirmed) }) };
      if (BigInt(candidate.borrowerFeeBps) > 65535n || BigInt(candidate.protocolFeeBps) > 10000n || candidate.funding === "reward-tokens" && candidate.executionCostRaw !== "0" || candidate.funding !== "reward-tokens" && c.tokenFundingConfirmed !== undefined) invalid();
      const key = [candidate.taskId, candidate.problemId, candidate.providerId, candidate.tier, candidate.funding].join(":"); if (seen.has(key)) invalid(); seen.add(key);
      return candidate;
    });
  }
  return result;
}

function prediction(value: unknown): StrategyPrediction {
  const p = record(value);
  return { ...identity(p), source: literal(p.source, "original-workflow-admission"), atMs: count(p.atMs), snapshotHash: hash(p.snapshotHash), routeBinding: hash(p.routeBinding),
    executionCostRaw: amount(p.executionCostRaw), planningCostRaw: amount(p.planningCostRaw), borrowerFeeRaw: amount(p.borrowerFeeRaw), netRevenueRaw: amount(p.netRevenueRaw),
    netRewardRaw: signed(p.netRewardRaw), originalMinNetRewardRaw: amount(p.originalMinNetRewardRaw) };
}
function historyEntry(value: unknown): StrategyHistoryEntry {
  const row = record(value), realized = record(row.realized);
  return { requestId: requestId(row.requestId), ...(row.parentRequestId === undefined ? {} : { parentRequestId: requestId(row.parentRequestId) }), at: timestamp(row.at),
    action: option(row.action, ["task", "metered-task", "reward-task"]), outcome: option(row.outcome, ["succeeded", "failed", "pending", "unknown"]),
    prediction: nullable(row.prediction, prediction), realized: { status: option(realized.status, ["confirmed", "pending", "incomplete"]), executionCostRaw: amount(realized.executionCostRaw),
      borrowingFeeRaw: nullable(realized.borrowingFeeRaw, amount), taskRevenueRaw: nullable(realized.taskRevenueRaw, amount), planningCostRaw: nullable(realized.planningCostRaw, amount),
      taskContributionRaw: nullable(realized.taskContributionRaw, signed), netAfterPlanningRaw: nullable(realized.netAfterPlanningRaw, signed),
      failureLossRaw: nullable(realized.failureLossRaw, amount), knownFailureLossLowerBoundRaw: nullable(realized.knownFailureLossLowerBoundRaw, amount) },
    executionCostDeviationRaw: nullable(row.executionCostDeviationRaw, signed), gaps: reasons(row.gaps) };
}
function candidate(value: unknown): StrategyCandidateAdvice {
  const c = record(value), comparableCount = count(c.comparableCount), failedComparableCount = count(c.failedComparableCount); if (failedComparableCount > comparableCount) invalid();
  const result: StrategyCandidateAdvice = { ...identity(c), source: literal(c.source, "owner-hypothetical"), status: option(c.status, ["eligible", "rejected", "insufficient-evidence"]),
    quotedExecutionCostRaw: amount(c.quotedExecutionCostRaw), observedCostBufferRaw: nullable(c.observedCostBufferRaw, amount), comparableCount, failedComparableCount,
    observedFailureLossRaw: nullable(c.observedFailureLossRaw, amount), adjustedExecutionCostRaw: amount(c.adjustedExecutionCostRaw), planningCostRaw: amount(c.planningCostRaw), borrowerFeeRaw: nullable(c.borrowerFeeRaw, amount),
    netRevenueRaw: amount(c.netRevenueRaw), successfulCompletionProfitRaw: nullable(c.successfulCompletionProfitRaw, signed), requiredProfitRaw: amount(c.requiredProfitRaw),
    cashRequiredRaw: nullable(c.cashRequiredRaw, amount), cashAfterRaw: nullable(c.cashAfterRaw, signed), creditRequiredRaw: nullable(c.creditRequiredRaw, amount), reasons: reasons(c.reasons), gaps: reasons(c.gaps) };
  if (result.status === "eligible" && (result.reasons.length || result.gaps.some(code => code !== "STRATEGY_TOKEN_OPPORTUNITY_COST_UNPRICED") || !comparableCount || result.observedCostBufferRaw === null || result.observedFailureLossRaw === null || result.successfulCompletionProfitRaw === null)) invalid();
  return result;
}

/** Project each public field recursively. Runtime engine and private file readers stay outside the frontend bundle. */
export function projectHostedStrategyAdvice(value: unknown, expectedAgentId: string): HostedStrategyAdvice {
  const input = record(value), p = record(input.policy), cash = record(input.cash), h = record(input.history), rec = record(input.recommendation);
  const agentId = text(input.agentId, /^[\w-]{1,80}$/); if (agentId !== expectedAgentId) invalid();
  const result: HostedStrategyAdvice = { version: literal(input.version, 1), observedAt: timestamp(input.observedAt), agentId, mode: literal(input.mode, "advisory-only"), currency: option(input.currency, ["USDC", "PathUSD"]), decimals: literal(input.decimals, 6),
    policy: { ...policy(p), source: option(p.source, ["advisory-default", "owner-preview"]), marginBasis: literal(p.marginBasis, "net-task-revenue") },
    basis: literal(input.basis, "successful-completion-bound"), scope: literal(input.scope, "settlement-asset-only"),
    exclusions: ["chain-fees", "reward-token-opportunity-cost", "success-probability"],
    cash: { status: option(cash.status, ["confirmed", "unavailable"]), cashRaw: nullable(cash.cashRaw, amount), reserveCashRaw: amount(cash.reserveCashRaw), pendingCommitmentsRaw: amount(cash.pendingCommitmentsRaw), outstandingDebtRaw: nullable(cash.outstandingDebtRaw, amount),
      financeObservedAt: nullable(cash.financeObservedAt, timestamp), availableBeforeReserveRaw: nullable(cash.availableBeforeReserveRaw, amount), spendableCashRaw: nullable(cash.spendableCashRaw, amount),
      unresolvedLiabilities: bool(cash.unresolvedLiabilities), creditIncluded: literal(cash.creditIncluded, false) },
    history: { scope: literal(h.scope, "retained-hosted-history"), entries: list(h.entries, 200, historyEntry), entryCount: count(h.entryCount), entriesTruncated: bool(h.entriesTruncated), gaps: reasons(h.gaps),
      comparableCount: count(h.comparableCount), knownFailureLossRaw: amount(h.knownFailureLossRaw), unknownFailureLossCount: count(h.unknownFailureLossCount),
      gameSubsidyRaw: amount(h.gameSubsidyRaw), creditsGranted: count(h.creditsGranted), creditsUsed: count(h.creditsUsed), netOperatingRaw: nullable(h.netOperatingRaw, signed) },
    candidates: list(input.candidates, 32, candidate), recommendation: { status: option(rec.status, ["preview", "blocked", "unavailable", "no-eligible-candidate"]), reasons: reasons(rec.reasons),
      ...(rec.taskId === undefined ? {} : { taskId: taskId(rec.taskId) }), ...(rec.providerId === undefined ? {} : { providerId: identifier(rec.providerId) }),
      ...(rec.tier === undefined ? {} : { tier: option(rec.tier, tiers) }), ...(rec.funding === undefined ? {} : { funding: option(rec.funding, funding) }) }, gaps: reasons(input.gaps) };
  const exclusions = input.exclusions;
  if (!Array.isArray(exclusions) || exclusions.length !== 3 || result.exclusions.some((v, i) => exclusions[i] !== v)) invalid();
  if (result.history.entries.length > result.history.entryCount || result.history.comparableCount > result.history.entryCount || result.history.unknownFailureLossCount > result.history.entryCount) invalid();
  if (result.cash.reserveCashRaw !== result.policy.reserveCashRaw || BigInt(result.cash.pendingCommitmentsRaw) > 0n && !result.cash.unresolvedLiabilities) invalid();
  const cashFields = [result.cash.cashRaw, result.cash.outstandingDebtRaw, result.cash.financeObservedAt, result.cash.availableBeforeReserveRaw, result.cash.spendableCashRaw];
  if (result.cash.status === "confirmed" ? cashFields.some(v => v === null) : cashFields.some(v => v !== null)) invalid();
  if (result.recommendation.status === "preview") {
    if (result.cash.status !== "confirmed" || result.cash.unresolvedLiabilities || !result.candidates.some(c => c.status === "eligible" && c.taskId === rec.taskId && c.providerId === rec.providerId && c.tier === rec.tier && c.funding === rec.funding)) invalid();
  } else if ([rec.taskId, rec.providerId, rec.tier, rec.funding].some(v => v !== undefined)) invalid();
  return result;
}
