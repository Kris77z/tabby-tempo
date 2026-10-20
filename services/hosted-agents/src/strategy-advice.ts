import { HostedError, type HostedFinance } from "./types.js";
import { validateHostedFinance } from "./finance-projection.js";
import type { HostedStrategyAdvice, StrategyAdviceInput, StrategyAdvicePreview, StrategyCandidateAdvice, StrategyPreviewCandidate } from "./strategy-types.js";

/** A preview accepts a point-in-time cash observation for at most two minutes. */
export const STRATEGY_FINANCE_MAX_AGE_MS = 120000;

const raw = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const object = (value: unknown, keys: string[]): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const max = (a: bigint, b: bigint) => a > b ? a : b;
const sub = (a: bigint, b: bigint) => a > b ? a - b : 0n;
const unique = (values: string[]) => [...new Set(values)].sort();
function invalid(): never { throw new HostedError("HOSTED_STRATEGY_PREVIEW_INVALID"); }
/** Closed numeric schema: no owner, URLs, prompts, model output, execution commands or probability claims. */
export function validateStrategyAdvicePreview(value: unknown): StrategyAdvicePreview {
  if (!object(value, ["policy", "candidates"])) invalid();
  if (value.policy !== undefined) {
    if (!object(value.policy, ["reserveCashRaw", "minProfitRaw", "minMarginBps"]) || Object.keys(value.policy).length !== 3 ||
      ![value.policy.reserveCashRaw, value.policy.minProfitRaw, value.policy.minMarginBps].every(raw) || BigInt(value.policy.minMarginBps) > 10000n) invalid();
  }
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates) || value.candidates.length > 32) invalid();
    const seen = new Set<string>();
    for (const c of value.candidates) {
      if (!object(c, ["taskId", "problemId", "providerId", "tier", "funding", "executionCostRaw", "planningCostRaw", "borrowerFeeBps", "creditLimitRaw", "rewardRaw", "escrowBalanceRaw", "protocolFeeBps", "deadlineMs", "routeBinding", "tokenFundingConfirmed"]) ||
        !raw(c.taskId) || c.taskId === "0" || !id(c.problemId) || !id(c.providerId) || !["cheap", "strong"].includes(c.tier) ||
        !["cash", "task-credit", "reward-tokens", "inference-allowance"].includes(c.funding) ||
        ![c.executionCostRaw, c.planningCostRaw, c.borrowerFeeBps, c.creditLimitRaw, c.rewardRaw, c.escrowBalanceRaw, c.protocolFeeBps].every(raw) ||
        BigInt(c.borrowerFeeBps) > 65535n || BigInt(c.protocolFeeBps) > 10000n || !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 0 ||
        c.routeBinding !== undefined && (typeof c.routeBinding !== "string" || !/^[a-f0-9]{64}$/.test(c.routeBinding)) ||
        c.tokenFundingConfirmed !== undefined && typeof c.tokenFundingConfirmed !== "boolean" ||
        c.funding === "reward-tokens" && c.executionCostRaw !== "0" || c.funding !== "reward-tokens" && c.tokenFundingConfirmed !== undefined) invalid();
      const key = [c.taskId, c.problemId, c.providerId, c.tier, c.funding].join(":"); if (seen.has(key)) invalid(); seen.add(key);
    }
  }
  return structuredClone(value) as StrategyAdvicePreview;
}

/** Deterministic advisory math. No I/O, probabilities, admission writes or execution selection changes. */
export function assessHostedStrategyAdvice(input: StrategyAdviceInput): HostedStrategyAdvice {
  const { agent, accounting, history } = input, preview = validateStrategyAdvicePreview(input.preview ?? {});
  const atMs = Date.parse(input.observedAt); if (!Number.isFinite(atMs)) invalid();
  let finance: HostedFinance;
  try {
    finance = validateHostedFinance(input.finance, agent, agent.binding?.chainId ?? "");
    if (finance.status === "confirmed" && (!agent.binding || agent.binding.wallet.toLowerCase() !== agent.wallet.toLowerCase() ||
      Date.parse(finance.observedAt) > atMs || atMs - Date.parse(finance.observedAt) > STRATEGY_FINANCE_MAX_AGE_MS || finance.block.timestamp * 1000 > atMs ||
      ![finance.cashRaw, finance.debtRaw, finance.credit.feeBps, finance.credit.tierCapRaw, finance.policy.maxCashPerTxRaw, finance.policy.maxDebtPerTxRaw, finance.policy.maxDebtPerDayRaw].every(raw))) throw Error("finance");
  } catch { finance = { status: "unavailable", observedAt: input.observedAt, reason: "HOSTED_FINANCE_UNCONFIRMED" }; }
  const historical = (row: StrategyAdviceInput["history"]["entries"][number]) => Number.isFinite(Date.parse(row.at)) && Date.parse(row.at) <= atMs &&
    (!row.prediction || Number.isSafeInteger(row.prediction.atMs) && row.prediction.atMs >= 0 && row.prediction.atMs <= Date.parse(row.at));
  const policy = { ...(preview.policy ?? { reserveCashRaw: agent.perRunBudgetRaw, minProfitRaw: "1", minMarginBps: "1000" }),
    source: preview.policy ? "owner-preview" as const : "advisory-default" as const, marginBasis: "net-task-revenue" as const };
  if (!raw(agent.reservedRaw) || !raw(input.pendingCommitmentsRaw ?? agent.reservedRaw) || !raw(agent.spentRaw) || !raw(agent.totalBudgetRaw) || !raw(agent.perRunBudgetRaw)) invalid();
  const pending = max(BigInt(agent.reservedRaw), BigInt(input.pendingCommitmentsRaw ?? agent.reservedRaw));
  const unresolved = accounting.status !== "complete" || accounting.coverage.pendingCount > 0 || history.entries.some(row => row.outcome === "pending") || pending > 0n;
  const cash = finance.status === "confirmed" ? BigInt(finance.cashRaw) : null;
  const debt = finance.status === "confirmed" ? BigInt(finance.debtRaw) : null;
  const available = cash === null || debt === null ? null : sub(cash, pending + debt), reserve = BigInt(policy.reserveCashRaw);
  const spendable = available === null ? null : sub(available, reserve);
  const globalGaps = unique([...accounting.coverage.reasons, ...history.gaps,
    ...(accounting.coverage.entriesTruncated || history.entriesTruncated ? ["STRATEGY_HISTORY_TRUNCATED"] : []),
    ...(finance.status !== "confirmed" ? ["STRATEGY_CASH_UNAVAILABLE"] : []),
    ...(unresolved ? ["STRATEGY_UNRESOLVED_LIABILITIES"] : [])]);
  const remainingBudget = sub(BigInt(agent.totalBudgetRaw), BigInt(agent.spentRaw) + pending);
  const candidates: StrategyCandidateAdvice[] = (preview.candidates ?? []).map((c: StrategyPreviewCandidate) => {
    const comparable = history.entries.filter(row => historical(row) && row.prediction && row.realized.status === "confirmed" && row.executionCostDeviationRaw !== null &&
      c.routeBinding !== undefined && row.prediction.routeBinding === c.routeBinding && row.prediction.problemId === c.problemId && row.prediction.providerId === c.providerId && row.prediction.tier === c.tier && row.prediction.funding === c.funding);
    const deviations = comparable.map(row => BigInt(row.executionCostDeviationRaw!));
    const buffer = comparable.length ? deviations.reduce((sum, n) => max(sum, n), 0n) : null;
    const failed = comparable.filter(row => row.outcome === "failed");
    const lossUnknown = failed.some(row => row.realized.failureLossRaw === null);
    const failureBuffer = comparable.length && !lossUnknown ? failed.reduce((sum, row) => max(sum, BigInt(row.realized.failureLossRaw!)), 0n) : null;
    const execution = BigInt(c.executionCostRaw) + (buffer ?? 0n), planning = BigInt(c.planningCostRaw);
    const revenue = BigInt(c.rewardRaw) - BigInt(c.rewardRaw) * BigInt(c.protocolFeeBps) / 10000n;
    // Margin = (revenue - all priced costs) / revenue. Cross-multiply/ceil; never round via Number.
    const marginProfit = (revenue * BigInt(policy.minMarginBps) + 9999n) / 10000n;
    // One worst observed comparable failure is a deterministic cushion, not an estimated failure probability.
    const required = max(BigInt(policy.minProfitRaw), marginProfit) + (failureBuffer ?? 0n);
    const reasons: string[] = [], gaps: string[] = [];
    if (!c.routeBinding) gaps.push("STRATEGY_ROUTE_BINDING_MISSING");
    if (!comparable.length) gaps.push("STRATEGY_COMPARABLE_HISTORY_MISSING");
    if (lossUnknown) gaps.push("STRATEGY_FAILURE_LOSS_UNKNOWN");
    if (globalGaps.includes("STRATEGY_HISTORY_TRUNCATED")) gaps.push("STRATEGY_HISTORY_TRUNCATED");
    if (BigInt(c.escrowBalanceRaw) < BigInt(c.rewardRaw)) reasons.push("STRATEGY_ESCROW_UNFUNDED");
    if (c.rewardRaw === "0") reasons.push("STRATEGY_REVENUE_ZERO");
    if (c.deadlineMs <= Date.parse(input.observedAt)) reasons.push("STRATEGY_DEADLINE");
    if (agent.status !== "Ready") reasons.push("STRATEGY_AGENT_NOT_READY");
    if (agent.configurationRequired) reasons.push("STRATEGY_CONFIGURATION_REQUIRED");
    if (execution > BigInt(agent.perRunBudgetRaw) || execution + planning > remainingBudget) reasons.push("STRATEGY_BUDGET_LIMIT");
    let cashRequired: bigint | null = null, credit: bigint | null = null, fee: bigint | null = null, after: bigint | null = null;
    if (available !== null && finance.status === "confirmed") {
      // Planning must use cash. Account payments consume cash before task credit; credit never props up the cash floor.
      const cashAfterPlanning = sub(cash!, planning);
      const executionCash = c.funding === "task-credit" && cashAfterPlanning < execution ? cashAfterPlanning : execution;
      cashRequired = planning + executionCash; credit = execution - executionCash;
      fee = credit * max(BigInt(c.borrowerFeeBps), BigInt(finance.credit.feeBps)) / 10000n;
      after = cash! - pending - debt! - cashRequired;
      if (available < planning || after < reserve) reasons.push("STRATEGY_CASH_RESERVE");
      if (finance.policy.ownerFrozen) reasons.push("STRATEGY_OWNER_FROZEN");
      if (max(executionCash, planning) > BigInt(finance.policy.maxCashPerTxRaw)) reasons.push("STRATEGY_CASH_POLICY_LIMIT");
      if (credit > 0n) {
        if (!agent.allowCredit || !finance.credit.eligible || credit > BigInt(c.creditLimitRaw) || credit > sub(BigInt(finance.credit.tierCapRaw), BigInt(finance.debtRaw))) reasons.push("STRATEGY_CREDIT_UNAVAILABLE");
        if (credit > BigInt(finance.policy.maxDebtPerTxRaw) || credit > BigInt(finance.policy.maxDebtPerDayRaw)) reasons.push("STRATEGY_CREDIT_POLICY_LIMIT");
        // Finance does not expose today's consumed debt allowance. A cap alone is not proof of remaining allowance.
        gaps.push("STRATEGY_DAILY_CREDIT_USAGE_UNKNOWN");
      }
    } else gaps.push("STRATEGY_CASH_UNAVAILABLE");
    if (c.funding === "reward-tokens") gaps.push("STRATEGY_TOKEN_BALANCE_UNVERIFIED", "STRATEGY_TOKEN_OPPORTUNITY_COST_UNPRICED");
    const profit = fee === null ? null : revenue - execution - planning - fee;
    if (profit !== null && profit < required) reasons.push("STRATEGY_MINIMUM_PROFIT");
    if (unresolved) gaps.push("STRATEGY_UNRESOLVED_LIABILITIES");
    const hardGaps = gaps.filter(code => code !== "STRATEGY_TOKEN_OPPORTUNITY_COST_UNPRICED");
    return { taskId: c.taskId, problemId: c.problemId, providerId: c.providerId, tier: c.tier, funding: c.funding,
      source: "owner-hypothetical", status: reasons.length ? "rejected" : hardGaps.length ? "insufficient-evidence" : "eligible",
      quotedExecutionCostRaw: c.executionCostRaw, observedCostBufferRaw: buffer?.toString() ?? null, comparableCount: comparable.length, failedComparableCount: failed.length,
      observedFailureLossRaw: failureBuffer?.toString() ?? null, adjustedExecutionCostRaw: execution.toString(), planningCostRaw: planning.toString(), borrowerFeeRaw: fee?.toString() ?? null,
      netRevenueRaw: revenue.toString(), successfulCompletionProfitRaw: profit?.toString() ?? null, requiredProfitRaw: required.toString(), cashRequiredRaw: cashRequired?.toString() ?? null,
      cashAfterRaw: after?.toString() ?? null, creditRequiredRaw: credit?.toString() ?? null, reasons: unique(reasons), gaps: unique(gaps) };
  });
  const eligible = candidates.filter(c => c.status === "eligible").sort((a, b) => {
    const delta = BigInt(b.successfulCompletionProfitRaw!) - BigInt(b.requiredProfitRaw) - BigInt(a.successfulCompletionProfitRaw!) + BigInt(a.requiredProfitRaw);
    return delta < 0n ? -1 : delta > 0n ? 1 : a.taskId.localeCompare(b.taskId) || a.providerId.localeCompare(b.providerId) || a.tier.localeCompare(b.tier) || a.funding.localeCompare(b.funding);
  });
  const recommendation: HostedStrategyAdvice["recommendation"] = !candidates.length ? { status: "unavailable", reasons: ["STRATEGY_CURRENT_CANDIDATES_UNAVAILABLE"] }
    : unresolved || finance.status !== "confirmed" ? { status: "blocked", reasons: unique([...(unresolved ? ["STRATEGY_UNRESOLVED_LIABILITIES"] : []), ...(finance.status !== "confirmed" ? ["STRATEGY_CASH_UNAVAILABLE"] : [])]) }
      : eligible[0] ? { status: "preview", taskId: eligible[0].taskId, providerId: eligible[0].providerId, tier: eligible[0].tier, funding: eligible[0].funding, reasons: ["STRATEGY_HYPOTHETICAL_ONLY"] }
        : { status: candidates.some(c => c.status === "insufficient-evidence") ? "blocked" : "no-eligible-candidate", reasons: unique(candidates.flatMap(c => [...c.reasons, ...c.gaps])) };
  const failedHistory = history.entries.filter(row => historical(row) && row.outcome === "failed");
  return { version: 1, observedAt: input.observedAt, agentId: agent.id, mode: "advisory-only", currency: accounting.currency, decimals: 6,
    policy, basis: "successful-completion-bound", scope: "settlement-asset-only", exclusions: ["chain-fees", "reward-token-opportunity-cost", "success-probability"],
    cash: { status: cash === null ? "unavailable" : "confirmed", cashRaw: cash?.toString() ?? null, financeObservedAt: finance.status === "confirmed" ? finance.observedAt : null,
      reserveCashRaw: policy.reserveCashRaw, pendingCommitmentsRaw: pending.toString(), outstandingDebtRaw: debt?.toString() ?? null, availableBeforeReserveRaw: available?.toString() ?? null, spendableCashRaw: spendable?.toString() ?? null, unresolvedLiabilities: unresolved, creditIncluded: false },
    history: { ...structuredClone(history), comparableCount: history.entries.filter(row => historical(row) && row.executionCostDeviationRaw !== null).length,
      knownFailureLossRaw: failedHistory.reduce((sum, row) => sum + BigInt(row.realized.failureLossRaw ?? "0"), 0n).toString(), unknownFailureLossCount: failedHistory.filter(row => row.realized.failureLossRaw === null).length,
      gameSubsidyRaw: accounting.totals.gameSubsidyRaw, creditsGranted: accounting.totals.creditsGranted, creditsUsed: accounting.totals.creditsUsed, netOperatingRaw: accounting.totals.netOperatingRaw },
    candidates, recommendation, gaps: unique([...globalGaps, ...(!candidates.length ? ["STRATEGY_CURRENT_CANDIDATES_UNAVAILABLE"] : [])]) };
}
