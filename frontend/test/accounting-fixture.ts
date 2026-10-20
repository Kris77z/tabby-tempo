import type { HostedAccounting } from "../lib/hosted-client.js";
export const accountingTime = "2026-10-17T00:00:00.000Z";
export function accountingFixture(agentId = "accounting-agent-a"): HostedAccounting {
  return { version: 1, observedAt: accountingTime, agentId, currency: "USDC", costScope: "settlement-asset-only", chainFeesRaw: null, actualProfitRaw: null, decimals: 6, status: "complete",
    totals: { taskRevenueRaw: "100000", inferenceCostRaw: "120001", borrowingFeeRaw: "2", refundsRaw: "5000", gameSubsidyRaw: "300000", ownerCapitalRaw: "1000000", startupCapitalRaw: "40000", loanPrincipalRaw: "80000", creditsGranted: 10000, creditsUsed: 215, netOperatingRaw: "-20003" },
    coverage: { scope: "retained-hosted-history", since: accountingTime, runCount: 1, entryCount: 1, pendingCount: 0, incompleteCount: 0, returnedEntryCount: 1, entriesTruncated: false, uncoveredSpentRaw: "0", reasons: [] },
    entries: [{ id: "accounting-request", requestId: "accounting-request", action: "task", at: accountingTime, status: "confirmed", inferenceCostRaw: "120001", refundsRaw: "5000", taskRevenueRaw: "100000", borrowingFeeRaw: "2", gameSubsidyRaw: "300000", ownerCapitalRaw: "1000000", startupCapitalRaw: "40000", loanPrincipalRaw: "80000", creditsGranted: 10000, creditsUsed: 215, reasons: [] }] };
}
