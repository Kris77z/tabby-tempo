import type { HostedAccounting, HostedAgent, HostedFinance } from "./types.js";

/** All settlement money is an integer number of six-decimal settlement-asset units. Tokens never share that unit. */
export interface OperatingBurnAssumption { amountRaw: string; windowMs: number; taskCount?: number }
/** Owner assumptions only; never retained evidence, an invoice, an admission rule or a saved budget. */
export interface OperatingReportPreview {
  reserveCashRaw?: string; recurringCostRaw?: string; burn?: OperatingBurnAssumption; subsidyBudgetRaw?: string; subsidyBurn?: OperatingBurnAssumption;
}
export interface OperatingSupplierReceipt {
  requestId: string; paymentId: string; paymentTxHash: string;
  /** Digest of the original chain/account/asset/payTo/service/model/provider route, never a live label. */
  routeBinding: string; providerId: string; payTo: string; chainId: string; account: string; asset: string;
  service: string; model: string; grossReceiptsRaw: string; refundsRaw: string; netReceiptsRaw: string;
}
export interface OperatingTaskFee {
  requestId: string; taskId: string; settlementTxHash?: string;
  protocolFeeRaw: string | null; creditFeeSettledRaw: string | null;
  source: "settled-task-and-original-reward" | "confirmed-no-fee"; gaps: string[];
}
/** Whitelisted retained-history inputs. No operator books or private journal objects enter this interface. */
export interface OperatingRoleEvidence {
  settlementDomain?: { chainId: string; account: string; asset: string };
  suppliers: OperatingSupplierReceipt[]; taskFees: OperatingTaskFee[]; gaps: string[];
  /** A complete accounting total can cover more rows than the bounded role reader returns. */
  entriesTruncated: boolean;
}
export interface OperatingRunway {
  source: "owner-hypothetical" | "operator-declared" | "none";
  scope: "agent-spendable-cash" | "game-subsidy-distribution-budget" | "operator-cash";
  status: "finite" | "zero-burn" | "unknown";
  availableRaw: string | null; burnAmountRaw: string | null; burnWindowMs: number | null;
  horizonMs: string | null; fullTasks: string | null; reasons: string[];
}
export interface HostedOperatingReport {
  version: 1; agentId: string; observedAt: string; currency: "USDC" | "PathUSD"; decimals: 6;
  mode: "read-only"; scope: "owner-agent-contribution"; status: "complete" | "partial";
  agent: {
    taskRevenueRaw: string; netServiceCostRaw: string; refundsRaw: string; borrowingFeeRaw: string;
    settlementOperatingRaw: string | null; actualProfitRaw: null;
    ownerCapitalRaw: string; startupCapitalRaw: string; loanPrincipalRaw: string; gaps: string[];
  };
  platform: {
    scope: "this-agent-only"; derivedProtocolFeeRaw: string | null; knownDerivedProtocolFeeRaw: string;
    creditFeeSettledRaw: string | null; knownCreditFeeSettledRaw: string;
    creditFeeRecipient: "credit-vault"; treasuryReceiptsRaw: null; actualProfitRaw: null; gaps: string[];
  };
  suppliers: {
    scope: "this-agent-only"; grossReceiptsRaw: string; refundsRaw: string; netReceiptsRaw: string;
    unattributedNetServiceCostRaw: string; actualProfitRaw: null;
    rows: (Omit<OperatingSupplierReceipt, "requestId" | "paymentId" | "paymentTxHash"> & { paymentCount: number; actualProfitRaw: null })[];
    gaps: string[];
  };
  subsidy: {
    gameUsdcGrantedRaw: string; startupCapitalGrantedRaw: string;
    gameDistributionOutflowRaw: string; distributionScope: "recorded-game-rewards-to-this-agent";
    startupCapitalSource: "unattributed-capital";
    /** Cash is fungible; grant provenance is not a spending allocation. */
    usdcAttributedConsumptionRaw: null; usdcGrantRemainingRaw: null;
    rewardTokensGranted: number; inferenceTokensUsed: number; rewardTokensConsumed: null; rewardTokensRemaining: null;
    tokenUsageScope: "paid-and-reward-mix-unknown"; gaps: string[];
  };
  cash: {
    status: "confirmed" | "unavailable"; cashRaw: string | null; financeObservedAt: string | null;
    pendingReservationsRaw: string; outstandingDebtRaw: string | null; reserveCashRaw: string;
    spendableCashRaw: string | null; shortfallRaw: string | null; creditIncluded: false;
  };
  scenario: null | {
    source: "owner-hypothetical"; recurringCostRaw: string; settlementOperatingAfterAssumedCostRaw: string | null;
    costScope: "retained-history-period"; costPeriod: { from: string | null; to: string };
    subsidyBudgetRaw: string | null; subsidyBudgetRemainingRaw: string | null; subsidyBudgetShortfallRaw: string | null; subsidyBudgetRunway: OperatingRunway | null;
  };
  runway: OperatingRunway;
  /** Role receipts overlap Agent expenses; adding role totals would double count internal transfers. */
  consolidation: { externalRevenueRaw: null; roleTotalsAdditive: false; gaps: string[] };
  coverage: HostedAccounting["coverage"] & { roleEntriesTruncated: boolean };
  gaps: string[];
}
export interface OperatingReportInput {
  agent: HostedAgent; finance: HostedFinance; accounting: HostedAccounting; evidence: OperatingRoleEvidence;
  pendingReservationsRaw: string; preview?: OperatingReportPreview; observedAt: string;
}

/** Offline operator declarations. A digest identifies supplied material; it does not authenticate an invoice. */
export interface OperatorFinancialObservation {
  version: 1; source: "operator-declared"; role: "platform" | "supplier"; subjectId: string;
  period: { from: string; to: string }; evidenceDigest: string;
  receiptsRaw: string; refundsRaw: string;
  /** Non-subsidy operating costs for period. Issued cash subsidies are expensed separately exactly once. */
  costsRaw: string;
  cashRaw?: string; reservationsRaw?: string; debtRaw?: string; reserveCashRaw?: string;
  /** Cash distributions issued in period, an operator-declared expense. */
  subsidyGrantedRaw?: string;
  /** Explicitly traced recipient consumption of those issued grants; not a second cash expense. */
  subsidyAllocatedRaw?: string;
  /** Unpaid distribution commitments; withheld from the total distribution budget. */
  subsidyCommittedRaw?: string; subsidyBudgetRaw?: string; burn?: OperatingBurnAssumption; subsidyBurn?: OperatingBurnAssumption;
}
export interface OperatorFinancialEvaluation {
  version: 1; source: "operator-declared"; role: "platform" | "supplier"; subjectId: string;
  currency: "USDC" | "PathUSD"; decimals: 6; period: { from: string; to: string }; evidenceDigest: string;
  reportedNetReceiptsRaw: string; reportedContributionRaw: string; actualProfitRaw: null;
  subsidy: { grantedRaw: string | null; explicitlyAllocatedRaw: string | null; unallocatedGrantRaw: string | null; unpaidCommittedRaw: string; budgetRaw: string | null; remainingBudgetRaw: string | null; budgetShortfallRaw: string | null; budgetRunway: OperatingRunway | null };
  runway: OperatingRunway; gaps: string[];
}

export const OPERATING_GAPS = [
  "OPERATING_UPSTREAM_COST_UNRECORDED", "OPERATING_HOSTING_COST_UNRECORDED", "OPERATING_CHAIN_FEES_UNRECORDED",
  "OPERATING_PROTOCOL_FEE_UNKNOWN", "OPERATING_TREASURY_RECEIPTS_UNCONFIRMED", "OPERATING_ROLE_OVERLAP_UNKNOWN",
  "OPERATING_SUPPLIER_COST_UNRECORDED", "OPERATING_SUPPLIER_ATTRIBUTION_INCOMPLETE", "OPERATING_BINDING_MISMATCH",
  "OPERATING_DUPLICATE_PAYMENT", "OPERATING_DUPLICATE_TASK", "OPERATING_RECEIPT_INVALID", "OPERATING_DOMAIN_UNKNOWN",
  "OPERATING_CREDIT_FEE_UNKNOWN", "OPERATING_HISTORY_MISSING", "OPERATING_HISTORY_INVALID", "OPERATING_HISTORY_LIMIT",
  "OPERATING_HISTORY_TRUNCATED", "OPERATING_CASH_UNAVAILABLE", "OPERATING_RESERVATIONS_UNKNOWN", "OPERATING_LIABILITIES_UNRESOLVED",
  "OPERATING_CASH_ALLOCATION_UNKNOWN", "OPERATING_REWARD_TOKEN_ALLOCATION_UNKNOWN", "OPERATING_STARTUP_CAPITAL_SOURCE_UNKNOWN",
  "OPERATING_BURN_ASSUMPTION_REQUIRED", "OPERATING_ZERO_BURN_NO_FINITE_HORIZON", "OPERATING_OPERATOR_DECLARATION_UNVERIFIED",
  "OPERATING_DECLARED_CASH_INCOMPLETE", "OPERATING_SUBSIDY_GRANTS_UNKNOWN", "OPERATING_PROTOCOL_FEE_RECEIPT_NOT_RETAINED",
] as const;
