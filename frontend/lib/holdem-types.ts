export type HoldemSeat = 0 | 1;
export type HoldemStreet = "preflop" | "flop" | "turn" | "river";
export type HoldemPhase = "Starting" | "Running" | "Complete" | "Stopped" | "PreflightFailed" | "SettlementUncertain";
export type HoldemAction = { type: "fold" | "check" | "call" | "all-in" } | { type: "raise"; to: number };
export interface HoldemStep { seat: HoldemSeat; street: HoldemStreet; action: HoldemAction; board: string[]; stacks: [number, number]; pot: number }
export interface HoldemResult { reason: "fold" | "showdown"; winners: HoldemSeat[]; contestedPot: number; payouts: [number, number]; refunds: [number, number]; finalStacks: [number, number] }
export interface HoldemUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
export interface HoldemPurchase {
  seat: HoldemSeat; agentId: string; award: string; deposited: string; depositTxHash: string;
  receipt: { txHash: string; blockNumber: number; fromCash: string; fromCredit: string; taskId: string; chainId: string; model?: string; usage?: HoldemUsage };
}
export interface HoldemBalance { sponsor: string; wallets: [string, string]; cash: [string, string]; provider: string; totalOutstanding: string }
export interface HoldemReport {
  matchId: string; verified: boolean; phase: HoldemPhase; network: "local-anvil" | "monad-testnet" | "monad-mainnet" | "unknown";
  chainId?: string; strategy: "scripted" | "controlled-model" | "real-model"; reason?: string;
  game: { entryFee: string; strategyInferenceCalls: number; chips: { initialPerSeat: number; smallBlind: number; bigBlind: number }; steps: HoldemStep[]; finalBoard: string[]; result: HoldemResult | null };
  strategyInference?: { calls: number; maxCalls: number; vendorInvoiceVerified: boolean; attempts: { turn: number; seat: HoldemSeat; requestedModel: string; status?: number; outcome: "IntentPersisted" | "Applied" | "HTTPRejected" | "ResponseInvalid" | "OutcomeUnknown" | "DeadlineExpired"; durationMs?: number; usage?: HoldemUsage }[] };
  reward: { rawAmount: string; decimals: number; allocations: [string, string]; transfers: { seat: HoldemSeat; agentId: string; amount: string; txHash: string; blockNumber: number }[]; replayDigest?: string; repeatedSettlementPaidAgain?: boolean } | null;
  inference: { rawPricePerWinner: string; taskId: string; calls: number; purchases: HoldemPurchase[] } | null;
  balances?: Partial<Record<"before" | "afterGame" | "afterAward" | "afterPurchase", HoldemBalance>>;
  evidence: { publicReplayVerified: boolean; chainEvidenceRecorded: boolean };
  verification: { gameWalletSpend?: string; fromCredit?: string; loanPrincipal?: string; totalOutstanding?: string; rewardConserved?: boolean };
}
export interface HoldemSnapshot {
  source: "fixture" | "report"; loadedAt: string; report: HoldemReport | null;
  error?: { code: "HOLDEM_REPORT_UNAVAILABLE"; message: string };
  delivery?: HoldemMonadDelivery;
  deliveryError?: string;
  purchase?: HoldemMonadPurchase;
  purchaseError?: string;
}
export interface HoldemMonadDelivery {
  phase: "RewardDeposited"; chainId: "10143"; matchId: string; decimals: 6; rewardRaw: string; allocations: [string, string];
  players: { seat: HoldemSeat; agentId: string }[];
  operations: { kind: "reward" | "approve" | "deposit"; seat: HoldemSeat; amount: string; txHash: string; blockNumber: number }[];
  balances: { before: HoldemMonadBalance; afterAward: HoldemMonadBalance; afterDeposit: HoldemMonadBalance };
  verification: { rewardConserved: boolean; newBorrowingRaw: string; totalOutstandingUnchanged: boolean };
}
export interface HoldemMonadBalance { blockNumber: number; cash: [string, string]; walletsToken: [string, string]; providerToken: string; totalOutstanding: string }
export interface HoldemMonadPurchase {
  phase: "Complete" | "Plan" | "Stopped"; chainId: "10143"; matchId: string; strategy: "controlled-model" | "real-model"; model: string; priceRaw: string; physicalInferenceAttempts: number;
  purchases: { seat: HoldemSeat; agentId: string; awardRaw: string; cashBefore: string; cashAfter?: string; state: "Delivered" | "Unknown" | "Stopped";
    receipt?: { txHash: string; blockNumber: number; fromCash: string; fromCredit: string; taskId: string; model?: string }; usage?: HoldemUsage; taskCompleted?: boolean }[];
  before?: { cash: [string, string]; providerToken: string; totalOutstanding: string }; after?: { cash: [string, string]; providerToken: string; totalOutstanding: string };
  verification: { fromCredit?: string; newBorrowingRaw?: string; zeroDebt: boolean; cashConserved: boolean; totalPaidRaw?: string; paymentReceiptsCanonical: boolean };
}
