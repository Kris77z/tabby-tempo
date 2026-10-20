/** Display denomination follows the verified chain; protocol rewardKind=usdc remains compatible. */
export type SettlementCurrency = "USDC" | "PathUSD";
export const settlementCurrency = (chainId?: string): SettlementCurrency => chainId === "42431" ? "PathUSD" : "USDC";
