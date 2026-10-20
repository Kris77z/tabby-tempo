import type { HostedAccounting, HostedAgent, HostedFinance } from "./types.js";

export type StrategyFunding = "cash" | "task-credit" | "reward-tokens" | "inference-allowance";
/** Preview-only requirements. They never change an Agent, admission policy or saved request. */
export interface StrategyAdvicePolicy { reserveCashRaw: string; minProfitRaw: string; minMarginBps: string }
/** Explicit owner assumptions, never proof of an available task, quote or token balance. */
export interface StrategyPreviewCandidate {
  taskId: string; problemId: string; providerId: string; tier: "cheap" | "strong"; funding: StrategyFunding;
  executionCostRaw: string; planningCostRaw: string; borrowerFeeBps: string; creditLimitRaw: string;
  rewardRaw: string; escrowBalanceRaw: string; protocolFeeBps: string; deadlineMs: number;
  routeBinding?: string;
  tokenFundingConfirmed?: boolean;
}
export interface StrategyAdvicePreview { policy?: StrategyAdvicePolicy; candidates?: StrategyPreviewCandidate[] }
export interface StrategyPrediction {
  source: "original-workflow-admission"; atMs: number; snapshotHash: string; routeBinding: string;
  taskId: string; problemId: string; providerId: string; tier: "cheap" | "strong"; funding: StrategyFunding;
  executionCostRaw: string; planningCostRaw: string; borrowerFeeRaw: string; netRevenueRaw: string; netRewardRaw: string;
  /** Original admission requirement, retained verbatim; the preview policy is separate. */
  originalMinNetRewardRaw: string;
}
export interface StrategyHistoryEntry {
  requestId: string; parentRequestId?: string; at: string; action: string;
  outcome: "succeeded" | "failed" | "pending" | "unknown";
  prediction: StrategyPrediction | null;
  realized: {
    status: "confirmed" | "pending" | "incomplete";
    executionCostRaw: string; borrowingFeeRaw: string | null; taskRevenueRaw: string | null; planningCostRaw: string | null;
    /** Task contribution before planning; no capital, subsidies or principal included. */
    taskContributionRaw: string | null; netAfterPlanningRaw: string | null;
    /** Net failed-task loss after known refunds; null if costs/settlement remain incomplete. */
    failureLossRaw: string | null; knownFailureLossLowerBoundRaw: string | null;
  };
  executionCostDeviationRaw: string | null; gaps: string[];
}
export interface StrategyHistory {
  scope: "retained-hosted-history"; entries: StrategyHistoryEntry[]; entryCount: number; entriesTruncated: boolean;
  gaps: string[];
}
export interface StrategyCandidateAdvice {
  taskId: string; problemId: string; providerId: string; tier: "cheap" | "strong"; funding: StrategyFunding;
  source: "owner-hypothetical"; status: "eligible" | "rejected" | "insufficient-evidence";
  quotedExecutionCostRaw: string;
  /** Maximum confirmed positive overrun for the same problem/provider/tier/funding; no success probability inferred. */
  observedCostBufferRaw: string | null; comparableCount: number; failedComparableCount: number;
  observedFailureLossRaw: string | null;
  adjustedExecutionCostRaw: string; planningCostRaw: string; borrowerFeeRaw: string | null;
  netRevenueRaw: string; successfulCompletionProfitRaw: string | null; requiredProfitRaw: string;
  /** cashAfterRaw may be negative to report a hypothetical shortfall. */
  cashRequiredRaw: string | null; cashAfterRaw: string | null; creditRequiredRaw: string | null;
  reasons: string[]; gaps: string[];
}
export interface HostedStrategyAdvice {
  version: 1; observedAt: string; agentId: string; mode: "advisory-only"; currency: "USDC" | "PathUSD"; decimals: 6;
  policy: StrategyAdvicePolicy & { source: "advisory-default" | "owner-preview"; marginBasis: "net-task-revenue" };
  basis: "successful-completion-bound"; scope: "settlement-asset-only";
  exclusions: ["chain-fees", "reward-token-opportunity-cost", "success-probability"];
  cash: { status: "confirmed" | "unavailable"; cashRaw: string | null; reserveCashRaw: string;
    /** Full outstanding root reservations are withheld, even when some charge may already be reflected in cash. */
    pendingCommitmentsRaw: string; outstandingDebtRaw: string | null; financeObservedAt: string | null; availableBeforeReserveRaw: string | null; spendableCashRaw: string | null;
    unresolvedLiabilities: boolean; creditIncluded: false };
  history: StrategyHistory & { comparableCount: number; knownFailureLossRaw: string; unknownFailureLossCount: number;
    gameSubsidyRaw: string; creditsGranted: number; creditsUsed: number; netOperatingRaw: string | null };
  candidates: StrategyCandidateAdvice[];
  recommendation: { status: "preview" | "blocked" | "unavailable" | "no-eligible-candidate";
    taskId?: string; providerId?: string; tier?: "cheap" | "strong"; funding?: StrategyFunding; reasons: string[] };
  gaps: string[];
}
export interface StrategyAdviceInput {
  agent: HostedAgent; finance: HostedFinance; accounting: HostedAccounting; history: StrategyHistory;
  preview?: StrategyAdvicePreview; observedAt: string; pendingCommitmentsRaw?: string;
}
